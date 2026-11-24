import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CFG } from "./config.js";
import { readJob, STATUS } from "./chain.js";
import { addStatement, addText, statementMessage, type Side } from "./evidence.js";
import { badgeRequestMessage, issueBadge, type BadgeRequest } from "./badge.js";

/*
 * Read-only public surface + three inputs (texts, signed statements, badge requests). Every input is verified
 * (hash or signature): the server trusts no caller. Put it behind the Phala gateway (TLS terminated in the CVM).
 */
export type Ctx = { info: () => Record<string, unknown>; attestation: () => Record<string, unknown>; verdict: (id: string) => unknown; badge: (r: BadgeRequest) => Promise<unknown> };

const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body, (_, v) => typeof v === "bigint" ? v.toString() : v));
};
const body = (req: IncomingMessage) => new Promise<Record<string, unknown>>((ok, ko) => {
  let s = ""; req.on("data", c => { s += c; if (s.length > 300_000) { ko(new Error("body too large")); req.destroy(); } });
  req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { ko(new Error("bad JSON")); } });
});
const hits = new Map<string, number[]>();
const limited = (ip: string, max = 30) => { const now = Date.now(), l = (hits.get(ip) ?? []).filter(t => now - t < 60_000); l.push(now); hits.set(ip, l); return l.length > max; };

export function serve(ctx: Ctx) {
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x"), p = url.pathname;
      if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" }); return res.end(); }
      if (req.method === "GET" && p === "/info") return send(res, 200, ctx.info());
      if (req.method === "GET" && p === "/attestation") return send(res, 200, ctx.attestation());
      if (req.method === "GET" && p.startsWith("/verdict/")) { const v = ctx.verdict(p.slice(9)); return send(res, v ? 200 : 404, v ?? { error: "no verdict yet" }); }
      if (req.method !== "POST") return send(res, 404, { error: "not found" });
      if (limited(String(req.socket.remoteAddress))) return send(res, 429, { error: "slow down" });
      const b = await body(req);
      if (p === "/statement-message") return send(res, 200, { message: statementMessage(BigInt(String(b.jobId)), b.side as Side, String(b.text ?? "")) });
      if (p === "/badge-message") return send(res, 200, { message: badgeRequestMessage(BigInt(String(b.agentId)), String(b.wallet), String(b.quote)) });
      if (p === "/badge") return send(res, 200, await ctx.badge(b as unknown as BadgeRequest));
      const job = await readJob(BigInt(String(b.jobId)));
      if (job.status !== STATUS.Disputed) return send(res, 409, { error: "job is not in dispute" });
      if (p === "/evidence") {
        const err = addText(job, b.kind === "task" ? "task" : "result", String(b.text ?? ""));
        return send(res, err ? 400 : 200, err ? { error: err } : { ok: true });
      }
      if (p === "/statement") {
        if (Date.now() / 1000 > job.disputedAt + CFG.statementsMin * 60) return send(res, 409, { error: "the statements window is closed" });
        const err = await addStatement(job, b.side === "agent" ? "agent" : "client", String(b.text ?? ""), String(b.signature ?? ""));
        return send(res, err ? 400 : 200, err ? { error: err } : { ok: true });
      }
      return send(res, 404, { error: "not found" });
    } catch (e) { send(res, 400, { error: (e as Error).message }); }
  }).listen(CFG.port, () => console.log(`[judge] http on :${CFG.port}`));
}

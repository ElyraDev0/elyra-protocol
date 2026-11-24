import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { account, signHash, type Account } from "../../../sdk/src/eth.js";
import { toHex } from "../../../sdk/src/crypto.js";
import { CFG } from "./config.js";
import { openTee } from "./tee.js";
import { courtJudge, disputedSince, maxSlashPerJob, readJob, send, STATUS } from "./chain.js";
import { bundle, fetchFromRelay } from "./evidence.js";
import { MODELS_HASH, PROMPT_HASH, rule } from "./inference.js";
import { decide } from "./ruling.js";
import { encodeSubmit, hex32, judgeReportData, verdictDigest, type Verdict } from "./eip712.js";
import { issueBadge } from "./badge.js";
import { serve } from "./server.js";
import { hashText } from "../../../sdk/src/eth.js";

/*
 * ELYRA COURT JUDGE · runs inside a Phala Cloud CVM (dstack).
 *   boot:   key = getKey("elyra/court/judge/v1")  →  address J  →  TDX quote over keccak256("ELYRA_JUDGE_V1", chainId, court, J)
 *   loop:   for each disputed job, after the statements window: evidence → two rulings → decision → EIP-712 verdict
 *           signed with J → submitted to ElyraCourt (or relayed by anyone from GET /verdict/:id)
 * The key never leaves the CVM. The contract accepts verdicts only from J, and J changes only through the timelock.
 */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const VERSION = "0.1.0";
type Rec = { verdict: Verdict; signature: string; digest: string; decision: string; rulings: unknown[]; evidence: unknown; tx: string | null; at: number };
const vfile = () => `${CFG.dataDir}/verdicts.json`, sfile = () => `${CFG.dataDir}/state.json`;
const load = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const keep = (f: string, v: unknown) => { mkdirSync(CFG.dataDir, { recursive: true }); writeFileSync(f + ".tmp", JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x)); renameSync(f + ".tmp", f); };

async function main() {
  const tee = await openTee(CFG.tee);
  const raw = await tee.getKey("elyra/court/judge/v1");
  const k = BigInt("0x" + toHex(raw)) % N;
  if (k === 0n) throw new Error("degenerate key");
  const judge: Account = account(k.toString(16).padStart(64, "0"));
  if (process.argv.includes("--print-address")) { console.log(judge.address); return; }

  const rd = judgeReportData(CFG.chainId, CFG.court, judge.address);
  const [quote, info] = await Promise.all([tee.getQuote(rd), tee.info()]);
  const attestation = { judge: judge.address, chainId: CFG.chainId, court: CFG.court, reportData: hex32(rd), ...quote, appId: info.appId, composeHash: info.composeHash, instanceId: info.instanceId, mode: tee.mode };
  keep(`${CFG.dataDir}/attestation.json`, attestation);
  if (!CFG.ai.modelA || !CFG.ai.modelB || CFG.ai.modelA === CFG.ai.modelB) throw new Error("set two different models: JUDGE_MODEL_A and JUDGE_MODEL_B");

  const onChain = await courtJudge().catch(() => "?");
  const active = onChain.toLowerCase() === judge.address;
  console.log(`[judge] ${tee.mode === "sim" ? "SIMULATED TEE (development only)" : "Phala TEE"} · judge ${judge.address} · ${active ? "active on ElyraCourt" : `NOT yet the court's judge (court has ${onChain}): queue setJudge in the timelock with /attestation`}`);

  const verdicts: Record<string, Rec> = load(vfile(), {});
  const state = load(sfile(), { from: CFG.fromBlock, pending: [] as string[] });
  const cap = async () => { const m = await maxSlashPerJob(); return CFG.slashCap < m ? CFG.slashCap : m; };

  serve({
    info: () => ({ version: VERSION, judge: judge.address, active, chainId: CFG.chainId, court: CFG.court, escrow: CFG.escrow, badges: CFG.badges,
      mode: tee.mode, appId: info.appId, composeHash: info.composeHash, promptHash: PROMPT_HASH, modelsHash: MODELS_HASH(),
      models: [CFG.ai.modelA, CFG.ai.modelB], statementsMin: CFG.statementsMin }),
    attestation: () => attestation,
    verdict: id => verdicts[id] ?? null,
    badge: r => issueBadge(r, judge, tee.mode === "sim"),
  });

  async function judgeJob(id: bigint) {
    const job = await readJob(id);
    if (job.status !== STATUS.Disputed) return "closed";
    const prev = verdicts[String(id)];
    if (prev && prev.verdict.expiresAt > Date.now() / 1000 + 60) {
      if (!prev.tx && CFG.submit && active) {                                  // signed earlier, the send failed: retry
        prev.tx = await send(judge, CFG.court, encodeSubmit(prev.verdict, prev.signature)); keep(vfile(), verdicts);
        console.log(`[judge] job #${id}: verdict executed on-chain · ${prev.tx}`); return "ruled";
      }
      return "signed";
    }
    const now = Math.floor(Date.now() / 1000);
    if (now < job.disputedAt + CFG.statementsMin * 60) return "waiting";
    await fetchFromRelay(job);
    const ev = bundle(job);
    const [a, b] = await Promise.all([rule(CFG.ai.modelA, ev.canonical), rule(CFG.ai.modelB, ev.canonical)]);
    const d = decide(a, b, await cap());
    const verdict: Verdict = { jobId: id, clientBps: d.clientBps, slashAmount: d.slashAmount, evidenceRoot: ev.root, promptHash: PROMPT_HASH,
      modelsHash: MODELS_HASH(), receiptsHash: hashText(`${a?.receipt ?? ""}\n${b?.receipt ?? ""}`), issuedAt: now - 5, expiresAt: now + CFG.verdictTtlSec };
    const digest = verdictDigest(verdict, CFG.chainId, CFG.court);
    const signature = signHash(judge, digest);
    const rec: Rec = { verdict, signature, digest: hex32(digest), decision: d.why, rulings: [a, b], evidence: ev.bundle, tx: null, at: now };
    verdicts[String(id)] = rec; keep(vfile(), verdicts);
    console.log(`[judge] job #${id}: ${d.side} (client ${d.clientBps / 100}%) · ${d.why}`);
    if (CFG.submit && active) {
      rec.tx = await send(judge, CFG.court, encodeSubmit(verdict, signature));
      keep(vfile(), verdicts);
      console.log(`[judge] job #${id}: verdict executed on-chain · ${rec.tx}`);
    }
    return "ruled";
  }

  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const { ids, to } = await disputedSince(state.from);
      state.pending = [...new Set([...state.pending, ...ids.map(String)])]; state.from = to + 1; keep(sfile(), state);
      for (const s of [...state.pending]) {
        try {
          const r = await judgeJob(BigInt(s));
          if (r === "closed" || r === "ruled") state.pending = state.pending.filter(x => x !== s);
        } catch (e) { console.log(`[judge] job #${s}: ${(e as Error).message}`); }
      }
      keep(sfile(), state);
    } catch (e) { console.log(`[judge] ${(e as Error).message}`); }
    finally { busy = false; }
  };
  await tick();
  setInterval(tick, CFG.pollSec * 1000);
}
main().catch(e => { console.error(`[judge] fatal: ${(e as Error).message}`); process.exit(1); });

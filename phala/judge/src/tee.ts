import { createHash, createHmac } from "node:crypto";

/*
 * The TEE as the judge sees it: a key derived for this app, a TDX quote over 64 bytes of report_data, and the app's
 * identity. On Phala Cloud this is the dstack guest agent (/var/run/dstack.sock) through @phala/dstack-sdk.
 * "sim" exists for local development and CI: same interface, deterministic keys, a quote with the TDX v4 layout but
 * NO Intel signature. Every simulated artefact says so (`simulated: true`), and the verifier rejects it.
 */
export type Quote = { quote: string; eventLog: string; simulated: boolean };
export type AppInfo = { appId: string | null; composeHash: string | null; instanceId: string | null };
export interface Tee {
  mode: "phala" | "sim";
  getKey(path: string): Promise<Uint8Array>;
  getQuote(reportData: Uint8Array): Promise<Quote>;
  info(): Promise<AppInfo>;
}

const hex = (b: Uint8Array | Buffer) => Buffer.from(b).toString("hex");

export async function openTee(mode: "phala" | "sim"): Promise<Tee> {
  if (mode === "sim") return simTee(process.env.SIM_SEED ?? "elyra-sim", process.env.SIM_COMPOSE ?? "{\"name\":\"elyra-judge-sim\"}");
  let sdk: any;
  try { sdk = await import("@phala/dstack-sdk" as string); }
  catch { throw new Error("TEE_MODE=phala needs @phala/dstack-sdk (installed in the Docker image)"); }
  const client = new sdk.DstackClient();
  return {
    mode: "phala",
    async getKey(path) { const r = await client.getKey(path); return new Uint8Array(r.key); },
    async getQuote(rd) {
      if (rd.length > 64) throw new Error("report_data is at most 64 bytes");
      const r = await client.getQuote(Buffer.from(rd));
      return { quote: String(r.quote).replace(/^0x/, ""), eventLog: typeof r.event_log === "string" ? r.event_log : JSON.stringify(r.event_log ?? []), simulated: false };
    },
    async info() {
      const r = typeof client.info === "function" ? await client.info() : {};
      return { appId: r.app_id ?? null, composeHash: r.compose_hash ?? r.tcb_info?.compose_hash ?? null, instanceId: r.instance_id ?? null };
    },
  };
}

/** local stand-in: TDX v4 layout (48-byte header + 584-byte TD report body), no signature */
export function simTee(seed: string, compose: string): Tee {
  const composeHash = createHash("sha256").update(compose).digest("hex");
  const rtmr3 = createHash("sha384").update("sim-rtmr3:" + composeHash).digest();
  return {
    mode: "sim",
    async getKey(path) { return new Uint8Array(createHmac("sha256", seed).update(path).digest()); },
    async getQuote(rd) {
      if (rd.length > 64) throw new Error("report_data is at most 64 bytes");
      const q = Buffer.alloc(48 + 584 + 4);
      q.writeUInt16LE(4, 0); q.writeUInt32LE(0x81, 4);                     // version 4, TEE type TDX
      Buffer.from(rtmr3).copy(q, 48 + 472);                                // RTMR3
      Buffer.from(rd).copy(q, 48 + 520);                                   // report_data
      const eventLog = JSON.stringify([{ imr: 3, event: "compose-hash", event_payload: composeHash, simulated: true }]);
      return { quote: hex(q), eventLog, simulated: true };
    },
    async info() { return { appId: "sim-" + createHash("sha256").update(seed).digest("hex").slice(0, 40), composeHash, instanceId: "sim" }; },
  };
}

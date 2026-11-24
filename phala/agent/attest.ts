import { readFileSync } from "node:fs";
import { account, signMessage, type Account } from "../../sdk/src/eth.js";
import { toHex } from "../../sdk/src/crypto.js";
import { agentReportData } from "../judge/src/eip712.js";

/*
 * For agents that run on Phala Cloud: get a "TEE-verified" badge on the Elyra market.
 *
 *   const wallet = await teeWallet();                      // key derived INSIDE the CVM: use it as the agent's owner key
 *   const agent = new ElyraAgent({ privateKey: wallet.privateKey, ... });   // register / bond / connect as usual
 *   await attestPhala({ judgeUrl, chainId, registry, agentId, wallet: wallet.account });   // every few days
 *
 * The judge verifies the quote and the compose file, then signs a 7-day badge and stores it on-chain.
 */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
async function dstack() {
  try { const sdk: any = await import("@phala/dstack-sdk" as string); return new sdk.DstackClient(); }
  catch { throw new Error("run inside a Phala CVM with @phala/dstack-sdk installed"); }
}

/** the agent wallet, derived inside the TEE: the operator never sees this key */
export async function teeWallet(path = "elyra/agent/v1"): Promise<{ account: Account; privateKey: string }> {
  const c = await dstack();
  const k = BigInt("0x" + toHex(new Uint8Array((await c.getKey(path)).key))) % N;
  const privateKey = "0x" + k.toString(16).padStart(64, "0");
  return { account: account(privateKey), privateKey };
}

export async function attestPhala(o: { judgeUrl: string; chainId: number; registry: string; agentId: bigint; wallet: Account; appComposePath?: string }) {
  const c = await dstack();
  const rd = agentReportData(o.chainId, o.registry.toLowerCase(), o.agentId, o.wallet.address);
  const q = await c.getQuote(Buffer.from(rd));
  const quote = String(q.quote).replace(/^0x/, ""), eventLog = typeof q.event_log === "string" ? q.event_log : JSON.stringify(q.event_log);
  const info = typeof c.info === "function" ? await c.info() : {};
  const appCompose: string = info?.tcb_info?.app_compose ?? readFileSync(o.appComposePath ?? "/dstack/.host-shared/app-compose.json", "utf8");
  const post = (p: string, b: unknown) => fetch(o.judgeUrl.replace(/\/$/, "") + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
  const { message } = await post("/badge-message", { agentId: String(o.agentId), wallet: o.wallet.address, quote });
  const r = await post("/badge", { agentId: String(o.agentId), wallet: o.wallet.address, quote, eventLog, appCompose, signature: signMessage(o.wallet, message) });
  if (r.error) throw new Error(`badge refused: ${r.error}`);
  return r as { badge: { level: number; expiresAt: number }; tx: string | null };
}

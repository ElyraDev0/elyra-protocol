import { createHash } from "node:crypto";
import { hashText, recoverAddress, signHash, type Account } from "../../../sdk/src/eth.js";
import { CFG } from "./config.js";
import { ownerOf, send } from "./chain.js";
import { readQuote } from "./quote.js";
import { agentReportData, badgeDigest, encodeSetBadge, hex32, type Badge } from "./eip712.js";
import { toHex } from "../../../sdk/src/crypto.js";

/*
 * TEE-VERIFIED AGENTS. An external agent running on Phala Cloud proves:
 *   1. its quote is genuine TDX (Intel signature + TCB)            → the verifier (dstack-verifier sidecar, in this CVM)
 *   2. RTMR3 replays to the app-compose.json it shows us            → the verifier, then sha256(appCompose) == compose hash
 *   3. report_data binds the quote to ITS Elyra wallet and agent id → checked here
 *   4. the request is signed by that wallet, the agent's owner       → checked here
 * The judge then signs a 7-day Badge (EIP-712). Because the judge key itself only exists inside an attested CVM,
 * nobody, including Elyra, can issue a badge by hand.
 */
export type BadgeRequest = { agentId: string; wallet: string; quote: string; eventLog: string; appCompose: string; signature: string };
export const badgeRequestMessage = (agentId: bigint, wallet: string, quote: string) =>
  `Elyra TEE badge request for agent #${agentId} on chain ${CFG.chainId}\nwallet: ${wallet.toLowerCase()}\nquote: ${hashText(quote.replace(/^0x/, "").toLowerCase())}`;

type Verified = { ok: true; composeHash: string } | { ok: false; why: string };
/** adapter for the verifier's JSON (dstack-verifier, or Phala's attestation API): field names isolated here */
async function verifyQuote(quote: string, eventLog: string, allowSim: boolean): Promise<Verified> {
  if (allowSim && /"simulated":\s*true/.test(eventLog)) {
    const ev = JSON.parse(eventLog) as { event?: string; event_payload?: string }[];
    const ch = ev.find(e => e.event === "compose-hash")?.event_payload;
    return ch ? { ok: true, composeHash: ch } : { ok: false, why: "no compose-hash event" };
  }
  if (!CFG.verifierUrl) return { ok: false, why: "no quote verifier configured" };
  const r = await fetch(CFG.verifierUrl, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ quote, event_log: eventLog }) });
  if (!r.ok) return { ok: false, why: `verifier HTTP ${r.status}` };
  const j = await r.json() as Record<string, any>;
  const valid = j.is_valid === true || j.valid === true || j.quote_verified === true;
  const composeHash = j.details?.app_info?.compose_hash ?? j.app_info?.compose_hash ?? j.compose_hash ?? null;
  if (!valid) return { ok: false, why: `quote not valid (${j.reason ?? j.details?.tcb_status ?? "verifier said no"})` };
  if (!composeHash) return { ok: false, why: "verifier returned no compose hash" };
  return { ok: true, composeHash: String(composeHash).replace(/^0x/, "").toLowerCase() };
}

export async function issueBadge(req: BadgeRequest, judge: Account, allowSim: boolean) {
  if (!CFG.badges) throw new Error("badges are not enabled on this judge");
  const agentId = BigInt(req.agentId), wallet = String(req.wallet).toLowerCase(), quote = String(req.quote).replace(/^0x/, "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error("bad wallet");
  // 4. signed by the wallet, which must own the agent on the registry
  if (recoverAddress(badgeRequestMessage(agentId, wallet, quote), req.signature)?.toLowerCase() !== wallet) throw new Error("request not signed by the wallet");
  if ((await ownerOf(agentId)).toLowerCase() !== wallet) throw new Error("wallet is not the agent's owner");
  // 3. report_data binds THIS agent and wallet
  const want = toHex(agentReportData(CFG.chainId, CFG.registry, agentId, wallet));
  if (readQuote(quote).reportData !== want) throw new Error("report_data does not bind this agent and wallet");
  // 1 + 2. genuine quote, and the compose file it ran is the one shown
  const v = await verifyQuote(quote, String(req.eventLog), allowSim);
  if (!v.ok) throw new Error(v.why);
  const composeHash = createHash("sha256").update(String(req.appCompose)).digest("hex");
  if (composeHash !== v.composeHash) throw new Error("app-compose.json does not match the attested compose hash");
  // level 2: every image is pinned by digest, so the exact code is public and reproducible
  const images = [...String(req.appCompose).matchAll(/"?image"?\s*[:=]\s*\\?"?([^\s"\\,]+)/g)].map(m => m[1]);
  const level = images.length > 0 && images.every(i => /@sha256:[0-9a-f]{64}$/.test(i)) ? 2 : 1;
  const now = Math.floor(Date.now() / 1000);
  const badge: Badge = { agentId, agentWallet: wallet, composeHash: "0x" + composeHash, level, issuedAt: now - 5, expiresAt: now - 5 + Math.min(CFG.badgeDays, 7) * 86400 };
  const signature = signHash(judge, badgeDigest(badge, CFG.chainId, CFG.badges));
  let tx: string | null = null;
  if (CFG.submit) tx = await send(judge, CFG.badges, encodeSetBadge(badge, signature));
  return { badge: { ...badge, agentId: String(agentId) }, signature, tx, reportData: hex32(agentReportData(CFG.chainId, CFG.registry, agentId, wallet)) };
}

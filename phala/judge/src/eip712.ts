import { keccak256, toHex, fromHex } from "../../../sdk/src/crypto.js";

/* EIP-712 hashing, matching ElyraCourt / TeeBadgeRegistry byte for byte (checked on-chain in the e2e test). */
const enc = new TextEncoder();
const k = (s: string) => keccak256(enc.encode(s));
const word = (v: bigint | number | string) => {
  if (typeof v === "string") return fromHex(v.replace(/^0x/, "").padStart(64, "0"));
  const b = new Uint8Array(32); let x = BigInt(v); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 255n); x >>= 8n; } return b;
};
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

export function domain(name: string, version: string, chainId: number, contract: string) {
  return keccak256(cat(k("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), k(name), k(version), word(chainId), word(contract)));
}
const digest = (dom: Uint8Array, struct: Uint8Array) => keccak256(cat(new Uint8Array([0x19, 0x01]), dom, struct));

export type Verdict = {
  jobId: bigint; clientBps: number; slashAmount: bigint; evidenceRoot: string; promptHash: string; modelsHash: string;
  receiptsHash: string; issuedAt: number; expiresAt: number;
};
export const VERDICT_TYPE = "Verdict(uint256 jobId,uint16 clientBps,uint256 slashAmount,bytes32 evidenceRoot,bytes32 promptHash,bytes32 modelsHash,bytes32 receiptsHash,uint64 issuedAt,uint64 expiresAt)";
export function verdictDigest(v: Verdict, chainId: number, court: string) {
  const s = keccak256(cat(k(VERDICT_TYPE), word(v.jobId), word(v.clientBps), word(v.slashAmount), word(v.evidenceRoot), word(v.promptHash),
    word(v.modelsHash), word(v.receiptsHash), word(v.issuedAt), word(v.expiresAt)));
  return digest(domain("ElyraCourt", "1", chainId, court), s);
}
/** ABI for ElyraCourt.submitVerdict((uint256,uint16,uint256,bytes32,bytes32,bytes32,bytes32,uint64,uint64),bytes) */
export function encodeSubmit(v: Verdict, sig: string) {
  const sel = toHex(k("submitVerdict((uint256,uint16,uint256,bytes32,bytes32,bytes32,bytes32,uint64,uint64),bytes)").slice(0, 4));
  const head = [v.jobId, v.clientBps, v.slashAmount, v.evidenceRoot, v.promptHash, v.modelsHash, v.receiptsHash, v.issuedAt, v.expiresAt].map(x => toHex(word(x as never)));
  const s = sig.replace(/^0x/, "");
  return "0x" + sel + head.join("") + toHex(word(10 * 32)) + toHex(word(s.length / 2)) + s.padEnd(Math.ceil(s.length / 64) * 64, "0");
}

export type Badge = { agentId: bigint; agentWallet: string; composeHash: string; level: number; issuedAt: number; expiresAt: number };
export const BADGE_TYPE = "Badge(uint256 agentId,address agentWallet,bytes32 composeHash,uint8 level,uint64 issuedAt,uint64 expiresAt)";
export function badgeDigest(b: Badge, chainId: number, registry: string) {
  const s = keccak256(cat(k(BADGE_TYPE), word(b.agentId), word(b.agentWallet), word(b.composeHash), word(b.level), word(b.issuedAt), word(b.expiresAt)));
  return digest(domain("ElyraTeeBadge", "1", chainId, registry), s);
}
export function encodeSetBadge(b: Badge, sig: string) {
  const sel = toHex(k("setBadge((uint256,address,bytes32,uint8,uint64,uint64),bytes)").slice(0, 4));
  const head = [b.agentId, b.agentWallet, b.composeHash, b.level, b.issuedAt, b.expiresAt].map(x => toHex(word(x as never)));
  const s = sig.replace(/^0x/, "");
  return "0x" + sel + head.join("") + toHex(word(7 * 32)) + toHex(word(s.length / 2)) + s.padEnd(Math.ceil(s.length / 64) * 64, "0");
}

/* report_data: what binds a key to a quote (first 32 bytes; the last 32 are zero) */
const packed = (tag: string, ...parts: (bigint | string)[]) => keccak256(cat(enc.encode(tag), ...parts.map(p =>
  typeof p === "string" ? fromHex(p.replace(/^0x/, "")) : word(p))));
export const judgeReportData = (chainId: number, court: string, judge: string) => cat(packed("ELYRA_JUDGE_V1", BigInt(chainId), court, judge), new Uint8Array(32));
export const agentReportData = (chainId: number, registry: string, agentId: bigint, wallet: string) =>
  cat(packed("ELYRA_AGENT_V1", BigInt(chainId), registry, agentId, wallet), new Uint8Array(32));
export const hex32 = (b: Uint8Array) => "0x" + toHex(b);

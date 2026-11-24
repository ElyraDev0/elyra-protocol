import { createHmac } from "node:crypto";
import { fromHex, hashMessage, keccak256, mul, pubToAddress, recoverAddress, toHex } from "./crypto.js";

/* Minimal Ethereum client for the Elyra SDK: JSON-RPC, ABI encoding, EIP-1559 signing, personal_sign. No dependencies. */

const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const big = (b: Uint8Array) => (b.length ? BigInt("0x" + toHex(b)) : BigInt(0));
const be32 = (n: bigint) => fromHex(n.toString(16).padStart(64, "0"));
const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
function inv(a: bigint, m: bigint) { let [r0, r1, s0, s1] = [mod(a, m), m, BigInt(1), BigInt(0)]; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return mod(s0, m); }
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const hmac = (k: Uint8Array, d: Uint8Array) => new Uint8Array(createHmac("sha256", k).update(d).digest());
function nonceK(priv: bigint, h: Uint8Array): bigint {
  const x = be32(priv), h1 = be32(mod(big(h), N));
  let V = new Uint8Array(32).fill(1), K = new Uint8Array(32).fill(0);
  K = hmac(K, cat(V, new Uint8Array([0]), x, h1)); V = hmac(K, V);
  K = hmac(K, cat(V, new Uint8Array([1]), x, h1)); V = hmac(K, V);
  for (;;) { V = hmac(K, V); const k = big(V); if (k > BigInt(0) && k < N) return k; K = hmac(K, cat(V, new Uint8Array([0]))); V = hmac(K, V); }
}
function signDigest(priv: bigint, h: Uint8Array) {
  const k = nonceK(priv, h), R = mul(k)!; const r = mod(R[0], N);
  let s = mod(inv(k, N) * (big(h) + r * priv), N); let v = Number(R[1] & BigInt(1));
  if (s > N / BigInt(2)) { s = N - s; v ^= 1; }
  return { r, s, v };
}

export type Account = { priv: bigint; address: string };
export function account(privateKey: string): Account {
  const k = privateKey.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error("privateKey must be 32 bytes hex");
  const priv = BigInt("0x" + k); return { priv, address: pubToAddress(mul(priv)).toLowerCase() };
}
/** EIP-191 personal_sign (the signature a wallet makes on a text message) */
export function signMessage(a: Account, message: string): string {
  const { r, s, v } = signDigest(a.priv, hashMessage(message));
  return "0x" + r.toString(16).padStart(64, "0") + s.toString(16).padStart(64, "0") + (27 + v).toString(16);
}
export { recoverAddress };
/** signs a raw 32-byte digest (e.g. an EIP-712 hash): 65-byte r‖s‖v hex, v = 27/28 */
export function signHash(a: Account, digest: Uint8Array): string {
  const { r, s, v } = signDigest(a.priv, digest);
  return "0x" + r.toString(16).padStart(64, "0") + s.toString(16).padStart(64, "0") + (27 + v).toString(16);
}

/* ---------------- JSON-RPC ---------------- */
export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let last: Error = new Error("RPC failed");
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = (await r.json()) as { result?: T; error?: { message: string } };
      if (j.error) { last = new Error(j.error.message); if (!/limit|rate|busy|timeout|too many/i.test(j.error.message)) throw last; }
      else return j.result as T;
    } catch (e) { last = e as Error; if (!/fetch|network|limit|rate|busy|timeout|too many|ECONN/i.test(last.message)) throw last; }
    await new Promise(res => setTimeout(res, 500 * (i + 1)));
  }
  throw last;
}
export const call = (url: string, to: string, data: string) => rpc<string>(url, "eth_call", [{ to, data }, "latest"]);

/* ---------------- ABI ---------------- */
const enc = new TextEncoder();
export const sel = (sig: string) => "0x" + toHex(keccak256(enc.encode(sig)).slice(0, 4));
export const topic = (sig: string) => "0x" + toHex(keccak256(enc.encode(sig)));
export const hashText = (s: string) => "0x" + toHex(keccak256(enc.encode(s)));
export const words = (hex: string) => (hex.replace(/^0x/, "").match(/.{64}/g) ?? []).map(x => BigInt("0x" + x));
type Arg = { t: "uint256"; v: bigint | number } | { t: "address"; v: string } | { t: "bytes32"; v: string } | { t: "string"; v: string };
const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
/** ABI-encodes a call: selector + arguments (uint256, address, bytes32, string) */
export function encodeCall(sig: string, args: Arg[]): string {
  const head: string[] = [], tail: string[] = []; let off = args.length * 32;
  for (const a of args) {
    if (a.t === "string") {
      const b = enc.encode(a.v), hex = toHex(b), padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
      head.push(w(off)); tail.push(w(b.length) + padded); off += 32 + padded.length / 2;
    } else if (a.t === "address") head.push(a.v.replace(/^0x/, "").toLowerCase().padStart(64, "0"));
    else if (a.t === "bytes32") head.push(a.v.replace(/^0x/, "").padStart(64, "0"));
    else head.push(w(a.v));
  }
  return sel(sig) + head.join("") + tail.join("");
}

/* ---------------- transactions ---------------- */
type Rlp = Uint8Array | Rlp[];
const intBytes = (n: bigint) => { if (n === BigInt(0)) return new Uint8Array(); const h = n.toString(16); return fromHex(h.length % 2 ? "0" + h : h); };
function lenPrefix(len: number, short: number) { if (len < 56) return new Uint8Array([short + len]); const l = intBytes(BigInt(len)); return cat(new Uint8Array([short + 55 + l.length]), l); }
function rlp(x: Rlp): Uint8Array {
  if (x instanceof Uint8Array) return x.length === 1 && x[0] < 0x80 ? x : cat(lenPrefix(x.length, 0x80), x);
  const body = cat(...x.map(rlp)); return cat(lenPrefix(body.length, 0xc0), body);
}
/** signs and sends one EIP-1559 transaction; returns its hash. Gas = node estimate + 30%. */
export async function sendTx(url: string, chainId: number, from: Account, to: string, data: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const [nonceHex, block, gasHex] = await Promise.all([
        rpc<string>(url, "eth_getTransactionCount", [from.address, "pending"]),
        rpc<{ baseFeePerGas?: string }>(url, "eth_getBlockByNumber", ["latest", false]),
        rpc<string>(url, "eth_estimateGas", [{ from: from.address, to, data }]),
      ]);
      const base = BigInt(block.baseFeePerGas ?? "0x3b9aca00"), tip = BigInt(100_000_000);
      const fields: Rlp[] = [intBytes(BigInt(chainId)), intBytes(BigInt(nonceHex)), intBytes(tip), intBytes(base * BigInt(2) + tip),
        intBytes((BigInt(gasHex) * BigInt(13)) / BigInt(10)), fromHex(to), new Uint8Array(), fromHex(data), []];
      const { r, s, v } = signDigest(from.priv, keccak256(cat(new Uint8Array([2]), rlp(fields))));
      const raw = cat(new Uint8Array([2]), rlp([...fields, intBytes(BigInt(v)), intBytes(r), intBytes(s)]));
      return await rpc<string>(url, "eth_sendRawTransaction", ["0x" + toHex(raw)]);
    } catch (e) {
      if (attempt < 3 && /nonce|replacement|already known/i.test((e as Error).message)) { await new Promise(r => setTimeout(r, 800)); continue; }
      throw e;
    }
  }
}
export type Receipt = { status: string; logs: { address: string; topics: string[]; data: string }[] };
export async function waitReceipt(url: string, hash: string, maxMs = 120000): Promise<Receipt> {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const rc = await rpc<Receipt | null>(url, "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (rc) { if (rc.status !== "0x1") throw new Error(`Transaction ${hash} reverted`); return rc; }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Transaction ${hash} not mined in time`);
}

/* keccak-256 and secp256k1 for the Elyra SDK — no dependencies (same code as the Elyra site). */
const B = (n: number | string) => BigInt(n);
const ZERO = B(0), ONE = B(1), TWO = B(2), THREE = B(3), SEVEN = B(7);
const M64 = (ONE << B(64)) - ONE;

/* ---------------- keccak-256 ---------------- */
const RC = [
  "0x0000000000000001", "0x0000000000008082", "0x800000000000808a", "0x8000000080008000", "0x000000000000808b", "0x0000000080000001",
  "0x8000000080008081", "0x8000000000008009", "0x000000000000008a", "0x0000000000000088", "0x0000000080008009", "0x000000008000000a",
  "0x000000008000808b", "0x800000000000008b", "0x8000000000008089", "0x8000000000008003", "0x8000000000008002", "0x8000000000000080",
  "0x000000000000800a", "0x800000008000000a", "0x8000000080008081", "0x8000000000008080", "0x0000000080000001", "0x8000000080008008",
].map(B);
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotl = (x: bigint, n: number) => (n === 0 ? x : ((x << B(n)) | (x >> B(64 - n))) & M64);

function keccakF(s: bigint[]) {
  for (let round = 0; round < 24; round++) {
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b: bigint[] = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & M64 & b[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[round];
  }
}
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136, s: bigint[] = new Array(25).fill(ZERO);
  const padLen = rate - (data.length % rate);
  const msg = new Uint8Array(data.length + padLen);
  msg.set(data); msg[data.length] ^= 0x01; msg[msg.length - 1] ^= 0x80;
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = ZERO;
      for (let k = 7; k >= 0; k--) lane = (lane << B(8)) | B(msg[off + i * 8 + k]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((s[i] >> B(8 * k)) & B(255));
  return out;
}

/* ---------------- helpers ---------------- */
export const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => {
  const s = h.replace(/^0x/, ""); const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToBig = (b: Uint8Array) => (b.length ? B("0x" + toHex(b)) : ZERO);
const bigTo32 = (n: bigint) => fromHex(n.toString(16).padStart(64, "0"));

/* ---------------- secp256k1 ---------------- */
const P = B("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f");
const N = B("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const G: Pt = [B("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"), B("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")];
type Pt = [bigint, bigint] | null;
const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
function powMod(b: bigint, e: bigint, m: bigint) { let r = ONE; b = mod(b, m); while (e > ZERO) { if (e & ONE) r = (r * b) % m; b = (b * b) % m; e >>= ONE; } return r; }
const inv = (a: bigint, m: bigint) => powMod(a, m - TWO, m);
function add(p1: Pt, p2: Pt): Pt {
  if (!p1) return p2; if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  if (x1 === x2 && mod(y1 + y2, P) === ZERO) return null;
  const l = x1 === x2 ? mod(THREE * x1 * x1 * inv(TWO * y1, P), P) : mod((y2 - y1) * inv(mod(x2 - x1, P), P), P);
  const x3 = mod(l * l - x1 - x2, P);
  return [x3, mod(l * (x1 - x3) - y1, P)];
}
/* Jacobian coordinates (X, Y, Z): no modular inverse per step → ~10× faster scalar multiplication */
type J = [bigint, bigint, bigint];
function jDouble([X, Y, Z]: J): J {
  if (Y === ZERO) return [ZERO, ONE, ZERO];
  const YY = (Y * Y) % P, S = (B(4) * X * YY) % P, M = (THREE * X * X) % P;
  const X3 = mod(M * M - TWO * S, P);
  return [X3, mod(M * (S - X3) - B(8) * YY * YY, P), (TWO * Y * Z) % P];
}
function jAdd(p1: J, p2: J): J {
  if (p1[2] === ZERO) return p2; if (p2[2] === ZERO) return p1;
  const [X1, Y1, Z1] = p1, [X2, Y2, Z2] = p2;
  const Z1Z1 = (Z1 * Z1) % P, Z2Z2 = (Z2 * Z2) % P;
  const U1 = (X1 * Z2Z2) % P, U2 = (X2 * Z1Z1) % P, S1 = (Y1 * Z2 * Z2Z2) % P, S2 = (Y2 * Z1 * Z1Z1) % P;
  if (U1 === U2) return S1 === S2 ? jDouble(p1) : [ZERO, ONE, ZERO];
  const H = mod(U2 - U1, P), R = mod(S2 - S1, P), HH = (H * H) % P, HHH = (H * HH) % P, V = (U1 * HH) % P;
  const X3 = mod(R * R - HHH - TWO * V, P);
  return [X3, mod(R * (V - X3) - S1 * HHH, P), (Z1 * Z2 * H) % P];
}
export function mul(k: bigint, pt: Pt = G): Pt {
  if (!pt) return null;
  let r: J = [ZERO, ONE, ZERO], q: J = [pt[0], pt[1], ONE]; k = mod(k, N);
  while (k > ZERO) { if (k & ONE) r = jAdd(r, q); q = jDouble(q); k >>= ONE; }
  if (r[2] === ZERO) return null;
  const zi = inv(r[2], P), zi2 = (zi * zi) % P;
  return [(r[0] * zi2) % P, (r[1] * zi2 * zi) % P];
}
export function pubToAddress(pt: Pt): string {
  if (!pt) throw new Error("bad point");
  const raw = new Uint8Array(64); raw.set(bigTo32(pt[0]), 0); raw.set(bigTo32(pt[1]), 32);
  return "0x" + toHex(keccak256(raw).slice(12));
}

/** EIP-191 personal_sign digest of a UTF-8 text message */
export function hashMessage(message: string): Uint8Array {
  const m = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${m.length}`);
  const all = new Uint8Array(prefix.length + m.length); all.set(prefix); all.set(m, prefix.length);
  return keccak256(all);
}

/** Recovers the lowercase 0x address that produced `signature` (65-byte hex) over `message`. null if invalid. */
export function recoverAddress(message: string, signature: string): string | null {
  try {
    const sig = fromHex(signature);
    if (sig.length !== 65) return null;
    const r = bytesToBig(sig.slice(0, 32)), s = bytesToBig(sig.slice(32, 64));
    let v = sig[64]; if (v >= 27) v -= 27;
    if (v > 1 || r <= ZERO || r >= N || s <= ZERO || s >= N) return null;
    const z = bytesToBig(hashMessage(message));
    const x = r;                                   // r < N < P, recovery id ≥ 2 never used by wallets
    const y2 = mod(x * x * x + SEVEN, P);
    let y = powMod(y2, (P + ONE) / B(4), P);
    if (mod(y * y, P) !== y2) return null;
    if ((y & ONE) !== B(v)) y = P - y;
    const R: Pt = [x, y], rInv = inv(r, N);
    const Q = add(mul(mod(s * rInv, N), R), mul(mod(-z * rInv, N), G));
    return Q ? pubToAddress(Q) : null;
  } catch { return null; }
}

/** Test helper: deterministic-k is not needed here; signs with a given k (only used in tests). */
export function signWithK(message: string, priv: bigint, k: bigint): string {
  const z = bytesToBig(hashMessage(message));
  const R = mul(k)!; const r = mod(R[0], N);
  let s = mod(inv(k, N) * (z + r * priv), N); let v = Number(R[1] & ONE);
  if (s > N / TWO) { s = N - s; v ^= 1; }
  return "0x" + toHex(bigTo32(r)) + toHex(bigTo32(s)) + (27 + v).toString(16);
}

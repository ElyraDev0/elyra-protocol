/*
 * Sentinel · data. Everything comes from free public sources, no keys needed:
 *   DexScreener (pools, liquidity, trades) · Blockscout (token, holders, contract source) · public RPC (owner, proxy slots).
 * SENTINEL_MOCK=http://127.0.0.1:PORT sends every request to a local mock (offline tests).
 */
export const CHAINS = {
  ethereum: { blockscout: "https://eth.blockscout.com/api/v2", rpc: "https://ethereum-rpc.publicnode.com", label: "Ethereum" },
  base: { blockscout: "https://base.blockscout.com/api/v2", rpc: "https://base-rpc.publicnode.com", label: "Base" },
} as const;
export type Chain = keyof typeof CHAINS;

type Raw = Record<string, any>;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function get(url: string, init?: RequestInit): Promise<any> {
  const mock = process.env.SENTINEL_MOCK;
  const full = mock ? `${mock.replace(/\/$/, "")}/?u=${encodeURIComponent(url)}` : url;
  let last = "";
  for (let i = 0; i < 3; i++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(full, { ...init, signal: ctl.signal });
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) { last = `HTTP ${r.status}`; await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = (e as Error).message; await sleep(1000 * (i + 1)); }
    finally { clearTimeout(t); }
  }
  throw new Error(`${new URL(url).host}: ${last}`);
}
async function rpc(chain: Chain, method: string, params: unknown[]): Promise<string | null> {
  const d = await get(CHAINS[chain].rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).catch(() => null);
  return d && typeof d.result === "string" ? d.result : null;
}

/* ---------------------------------------------------------------- market (DexScreener) */
export type Market = { chain: Chain | null; otherChains: string[]; symbol: string; name: string; pools: number; liquidityUsd: number; fdv: number | null; volume24h: number; buys24h: number; sells24h: number; priceChange24h: number | null; poolCreatedAt: number | null; mainPool: string | null; dex: string | null };

export async function market(address: string): Promise<Market> {
  const d = await get(`https://api.dexscreener.com/latest/dex/tokens/${address}`).catch(() => null);
  const pairs = ((d?.pairs ?? []) as Raw[]).filter(p => String(p.baseToken?.address ?? "").toLowerCase() === address.toLowerCase());
  const liq = (p: Raw) => Number(p.liquidity?.usd ?? 0);
  const supported = pairs.filter(p => p.chainId in CHAINS);
  const byChain = new Map<string, number>(); for (const p of supported) byChain.set(p.chainId, (byChain.get(p.chainId) ?? 0) + liq(p));
  const chain = ([...byChain.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) as Chain | null;
  const mine = supported.filter(p => p.chainId === chain).sort((a, b) => liq(b) - liq(a));
  const top = mine[0];
  return {
    chain, otherChains: [...new Set(pairs.map(p => String(p.chainId)).filter(c => c !== chain))],
    symbol: String(top?.baseToken?.symbol ?? ""), name: String(top?.baseToken?.name ?? ""), pools: mine.length,
    liquidityUsd: mine.reduce((s, p) => s + liq(p), 0), fdv: top?.fdv != null ? Number(top.fdv) : null,
    volume24h: mine.reduce((s, p) => s + Number(p.volume?.h24 ?? 0), 0),
    buys24h: mine.reduce((s, p) => s + Number(p.txns?.h24?.buys ?? 0), 0), sells24h: mine.reduce((s, p) => s + Number(p.txns?.h24?.sells ?? 0), 0),
    priceChange24h: top?.priceChange?.h24 != null ? Number(top.priceChange.h24) : null,
    poolCreatedAt: mine.length ? Math.min(...mine.map(p => Number(p.pairCreatedAt ?? Infinity)).filter(Number.isFinite)) || null : null,
    mainPool: top?.pairAddress ?? null, dex: top?.dexId ?? null,
  };
}

/* ---------------------------------------------------------------- token + contract (Blockscout, RPC) */
export type Holder = { address: string; isContract: boolean; name: string | null; share: number };
export type Contract = {
  chain: Chain; address: string; name: string; symbol: string; decimals: number; totalSupply: number; holdersCount: number | null;
  verified: boolean; contractName: string | null; source: string | null; abiFunctions: string[];
  proxy: { implementation: string | null; admin: string | null; type: string | null } | null;
  owner: string | null; ownerKnown: boolean; creator: string | null; creatorShare: number | null; topHolders: Holder[];
};

const ZERO = /^0x0{40}$/i;
const word2addr = (w: string | null) => (w && w.length >= 66 ? "0x" + w.slice(-40) : null);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

export async function contract(chain: Chain, address: string): Promise<Contract> {
  const B = CHAINS[chain].blockscout;
  const [tok, addr, sc, holders] = await Promise.all([
    get(`${B}/tokens/${address}`).catch(() => null), get(`${B}/addresses/${address}`).catch(() => null),
    get(`${B}/smart-contracts/${address}`).catch(() => null), get(`${B}/tokens/${address}/holders`).catch(() => null),
  ]);
  const decimals = Number(tok?.decimals ?? 18) || 18;
  const totalSupply = Number(tok?.total_supply ?? 0) / 10 ** decimals;
  // proxy: EIP-1967 slots, or what Blockscout knows
  const implSlot = word2addr(await rpc(chain, "eth_getStorageAt", [address, IMPL_SLOT, "latest"]));
  const adminSlot = word2addr(await rpc(chain, "eth_getStorageAt", [address, ADMIN_SLOT, "latest"]));
  const implBs = ((addr?.implementations ?? sc?.implementations ?? []) as Raw[])[0]?.address_hash ?? ((addr?.implementations ?? sc?.implementations ?? []) as Raw[])[0]?.address ?? null;
  const implementation = implSlot && !ZERO.test(implSlot) ? implSlot : implBs;
  const proxy = implementation || sc?.proxy_type ? { implementation: implementation ?? null, admin: adminSlot && !ZERO.test(adminSlot) ? adminSlot : null, type: sc?.proxy_type ?? (implementation ? "eip1967" : null) } : null;
  // the code that really runs: the implementation's, for a proxy
  const scImpl = proxy?.implementation ? await get(`${B}/smart-contracts/${proxy.implementation}`).catch(() => null) : null;
  const code = scImpl?.is_verified ? scImpl : sc;
  const verified = !!(code?.is_verified ?? addr?.is_verified);
  const abiFunctions = ((code?.abi ?? []) as Raw[]).filter(x => x.type === "function").map(x => String(x.name));
  // owner(): Ownable / getOwner(): BEP-20 style
  let owner: string | null = null, ownerKnown = false;
  for (const sel of ["0x8da5cb5b", "0x893d20e8"]) {
    const r = await rpc(chain, "eth_call", [{ to: address, data: sel }, "latest"]);
    if (r && r.length >= 66) { owner = word2addr(r); ownerKnown = true; break; }
  }
  const creator = (addr?.creator_address_hash as string | undefined)?.toLowerCase() ?? null;
  const tops: Holder[] = ((holders?.items ?? []) as Raw[]).slice(0, 50).map(h => ({
    address: String(h.address?.hash ?? "").toLowerCase(), isContract: !!h.address?.is_contract, name: h.address?.name ?? null,
    share: totalSupply > 0 ? Number(h.value ?? 0) / 10 ** decimals / totalSupply : 0,
  }));
  const creatorShare = creator ? tops.find(h => h.address === creator)?.share ?? 0 : null;
  return {
    chain, address, name: String(tok?.name ?? ""), symbol: String(tok?.symbol ?? ""), decimals, totalSupply,
    holdersCount: tok?.holders_count != null ? Number(tok.holders_count) : tok?.holders != null ? Number(tok.holders) : null,
    verified, contractName: code?.name ?? null, source: typeof code?.source_code === "string" ? code.source_code : null, abiFunctions,
    proxy, owner: owner && ZERO.test(owner) ? null : owner, ownerKnown, creator, creatorShare, topHolders: tops,
  };
}

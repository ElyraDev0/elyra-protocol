/*
 * Steward · market data. Real, free, no keys: DefiLlama coin prices (daily history) and lending rates read on-chain.
 * STEWARD_MOCK=http://127.0.0.1:PORT sends every request to a local mock (offline tests).
 */
type Raw = Record<string, any>;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const DAY = 864e5;

async function get(url: string): Promise<any> {
  const mock = process.env.STEWARD_MOCK;
  const full = mock ? `${mock.replace(/\/$/, "")}/?u=${encodeURIComponent(url)}` : url;
  let last = "";
  for (let i = 0; i < 3; i++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
    try {
      const r = await fetch(full, { signal: ctl.signal });
      if (r.status === 429 || r.status >= 500) { last = `HTTP ${r.status}`; await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = (e as Error).message; await sleep(1500 * (i + 1)); }
    finally { clearTimeout(t); }
  }
  throw new Error(`${new URL(url).host}: ${last}`);
}

/** the assets Steward can hold besides stablecoins (Ethereum mainnet addresses: used for prices and for the safety check) */
export const ASSETS = {
  ETH: { coin: "ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", sleeve: "core" },
  BTC: { coin: "ethereum:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", sleeve: "core" },
  LINK: { coin: "ethereum:0x514910771AF9Ca656af840dff83E8264EcF986CA", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", sleeve: "bluechip" },
  UNI: { coin: "ethereum:0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", sleeve: "bluechip" },
  AAVE: { coin: "ethereum:0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", sleeve: "bluechip" },
} as const;
export type Asset = keyof typeof ASSETS;

/** daily closing prices (UTC days) from `start` for `days`+1 days */
export async function prices(assets: Asset[], start: number, days: number): Promise<Record<Asset, number[]>> {
  const coins = assets.map(a => ASSETS[a].coin).join(",");
  const d = await get(`https://coins.llama.fi/chart/${coins}?start=${Math.floor(start / 1000)}&span=${days + 1}&period=1d&searchWidth=600`);
  const out = {} as Record<Asset, number[]>;
  for (const a of assets) {
    const pts = ((d?.coins?.[ASSETS[a].coin]?.prices ?? []) as Raw[]).map(p => ({ t: Number(p.timestamp) * 1000, p: Number(p.price) })).sort((x, y) => x.t - y.t);
    if (pts.length < 2) continue;
    // one price per day, carrying the last known one forward
    const row: number[] = []; let j = 0;
    for (let i = 0; i <= days; i++) { const t = start + i * DAY; while (j + 1 < pts.length && pts[j + 1].t <= t + DAY / 2) j++; row.push(pts[j].p); }
    out[a] = row;
  }
  return out;
}

/** prices right now (DefiLlama current prices) */
export async function nowPrices(assets: Asset[]): Promise<Partial<Record<Asset, number>>> {
  if (!assets.length) return {};
  const d = await get(`https://coins.llama.fi/prices/current/${assets.map(a => ASSETS[a].coin).join(",")}?searchWidth=4h`);
  const out: Partial<Record<Asset, number>> = {};
  for (const a of assets) { const p = Number(d?.coins?.[ASSETS[a].coin]?.price); if (p > 0) out[a] = p; }
  return out;
}

/* ---------------------------------------------------------------- stablecoin yield, read on-chain
 * DefiLlama closed its free yields API on 13 Nov 2026, so Steward reads the lending rates directly from the
 * protocols' contracts through public RPCs: Aave v3 (USDC) and Compound v3 (cUSDCv3), on Ethereum, Base and Arbitrum.
 * Free, no keys, and it is the rate the protocol really pays right now. */
export type Pool = { id: string; project: string; chain: string; symbol: string; tvl: number; apyBase: number };
const RPC: Record<string, string> = { Ethereum: "https://ethereum-rpc.publicnode.com", Base: "https://base-rpc.publicnode.com", Arbitrum: "https://arbitrum-one-rpc.publicnode.com" };
const AAVE: Record<string, { pool: string; usdc: string }> = {
  Ethereum: { pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  Base: { pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  Arbitrum: { pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
};
const COMET: Record<string, string> = { Ethereum: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", Base: "0xb125E6687d4313864e53df431d5425969c15Eb2F", Arbitrum: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf" };
const YEAR = 31_536_000;

async function ethCall(chain: string, to: string, data: string): Promise<string | null> {
  const mock = process.env.STEWARD_MOCK;
  const url = RPC[chain], body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] });
  try {
    const r = await fetch(mock ? `${mock.replace(/\/$/, "")}/?u=${encodeURIComponent(url)}` : url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const j = await r.json() as { result?: string };
    return typeof j.result === "string" && j.result.length > 2 ? j.result : null;
  } catch { return null; }
}
const word = (hex: string, i: number) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
const pad = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

async function aave(chain: string): Promise<Pool | null> {
  const a = AAVE[chain];
  const r = await ethCall(chain, a.pool, "0x35ea6a75" + pad(a.usdc));              // getReserveData(USDC)
  if (!r) return null;
  const apr = Number(word(r, 2)) / 1e27;                                             // currentLiquidityRate (ray, yearly)
  const aToken = "0x" + word(r, 8).toString(16).padStart(40, "0");
  const ts = await ethCall(chain, aToken, "0x18160ddd");                             // aUSDC totalSupply = USDC supplied
  return { id: `aave-${chain}`, project: "aave-v3", chain, symbol: "USDC", tvl: ts ? Number(BigInt(ts)) / 1e6 : 0, apyBase: (Math.pow(1 + apr / YEAR, YEAR) - 1) * 100 };
}
async function compound(chain: string): Promise<Pool | null> {
  const c = COMET[chain];
  const u = await ethCall(chain, c, "0x7eb71131");                                   // getUtilization()
  if (!u) return null;
  const rate = await ethCall(chain, c, "0xd955759d" + pad("0x" + BigInt(u).toString(16)));   // getSupplyRate(utilization), per second, 1e18
  if (!rate) return null;
  const ts = await ethCall(chain, c, "0x18160ddd");
  const perSec = Number(BigInt(rate)) / 1e18;
  return { id: `compound-${chain}`, project: "compound-v3", chain, symbol: "USDC", tvl: ts ? Number(BigInt(ts)) / 1e6 : 0, apyBase: (Math.pow(1 + perSec, YEAR) - 1) * 100 };
}

/** today's USDC supply rates of the blue-chip lending markets that hold at least `minTvl` */
export async function stablePools(minTvl: number): Promise<Pool[]> {
  const all = await Promise.all(Object.keys(RPC).flatMap(ch => [aave(ch), compound(ch)]));
  return all.filter((p): p is Pool => !!p && p.tvl >= minTvl && p.apyBase > 0 && p.apyBase < 25);
}

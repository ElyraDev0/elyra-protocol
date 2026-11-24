import type { Asset } from "./data.js";

/*
 * Steward · the strategy, simulated day by day on real past data (a backtest with paper money).
 * Simple rules a person can check:
 *   - a stablecoin sleeve earns the real daily yield of blue-chip lending pools;
 *   - risk assets are held only while their price is above the 20-day average (trend filter);
 *   - a stop-loss sells an asset that falls too far from its entry; it can come back when the trend turns up;
 *   - every 7 days the portfolio goes back to its target weights; trades pay a 0.3% fee plus gas.
 */
export type Risk = "low" | "medium" | "high";
export const PROFILE: Record<Risk, { stable: number; core: Partial<Record<Asset, number>>; bluechip: number; stop: number }> = {
  low: { stable: 0.9, core: { ETH: 0.1 }, bluechip: 0, stop: 0.10 },
  medium: { stable: 0.6, core: { ETH: 0.2, BTC: 0.1 }, bluechip: 0.1, stop: 0.15 },
  high: { stable: 0.3, core: { ETH: 0.25, BTC: 0.15 }, bluechip: 0.3, stop: 0.20 },
};
export const MA = 20, FEE = 0.003, GAS_USD = 5, REBALANCE_DAYS = 7, TOLERANCE = 0.03;

export type Trade = { day: number; side: "buy" | "sell"; asset: Asset; usd: number; price: number; reason: string };
export type Sim = { values: number[]; trades: Trade[]; final: number; ret: number; maxDrawdown: number; feesPaid: number; yieldEarned: number;
  benchmarks: { stablesOnly: number; holdEth: number | null }; targets: Partial<Record<Asset, number>>; stableShare: number };

/**
 * prices: per asset, daily closes for MA + days + 1 points (the first MA points are history for the average)
 * apy: daily base APY (%) of the stable sleeve, days + 1 points
 */
export function simulate(amount: number, risk: Risk, days: number, assets: Asset[], prices: Record<Asset, number[]>, apy: number[]): Sim {
  const P = PROFILE[risk];
  const blue = assets.filter(a => !(a in P.core));
  const targets: Partial<Record<Asset, number>> = { ...P.core };
  for (const a of blue) targets[a] = P.bluechip / Math.max(blue.length, 1);
  for (const a of Object.keys(targets) as Asset[]) if (!prices[a]) delete targets[a];   // no price data: not held
  const px = (a: Asset, d: number) => prices[a][MA + d];
  const ma = (a: Asset, d: number) => { const w = prices[a].slice(d + 1, MA + d + 1); return w.reduce((s, x) => s + x, 0) / w.length; };

  let cash = amount, fees = 0, yieldEarned = 0;
  const units: Partial<Record<Asset, number>> = {}, entry: Partial<Record<Asset, number>> = {}, stopped: Partial<Record<Asset, boolean>> = {};
  const trades: Trade[] = [], values: number[] = [];
  const value = (d: number) => cash + (Object.keys(units) as Asset[]).reduce((s, a) => s + (units[a] ?? 0) * px(a, d), 0);
  const trade = (d: number, a: Asset, usd: number, reason: string) => {
    if (Math.abs(usd) < 1) return;
    const cost = Math.abs(usd) * FEE + GAS_USD; fees += cost;
    if (usd > 0) { const spend = Math.min(usd, cash - cost); if (spend <= 0) return; cash -= spend + cost; units[a] = (units[a] ?? 0) + spend / px(a, d); entry[a] = px(a, d); trades.push({ day: d, side: "buy", asset: a, usd: spend, price: px(a, d), reason }); }
    else { const u = Math.min(-usd / px(a, d), units[a] ?? 0); if (u <= 0) return; units[a] = (units[a] ?? 0) - u; cash += u * px(a, d) - cost; trades.push({ day: d, side: "sell", asset: a, usd: u * px(a, d), price: px(a, d), reason }); if ((units[a] ?? 0) < 1e-12) { delete units[a]; delete entry[a]; } }
  };
  const want = (a: Asset, d: number) => (stopped[a] || px(a, d) < ma(a, d) ? 0 : targets[a] ?? 0);

  for (let d = 0; d <= days; d++) {
    if (d > 0) { const y = cash * (apy[d] ?? 0) / 100 / 365; cash += y; yieldEarned += y; }
    for (const a of Object.keys(targets) as Asset[]) {
      const p = px(a, d), held = (units[a] ?? 0) * p;
      // stop-loss, and the way back in
      if (held > 0 && entry[a] && p < entry[a]! * (1 - P.stop)) { trade(d, a, -held, `stop-loss: −${Math.round(P.stop * 100)}% from entry`); stopped[a] = true; continue; }
      if (stopped[a] && p > ma(a, d)) stopped[a] = false;
      const tv = value(d), goal = want(a, d) * tv, gap = goal - held;
      const trendFlip = (goal === 0 && held > 0) || (goal > 0 && held === 0);
      const weekly = d % REBALANCE_DAYS === 0 && Math.abs(gap) > TOLERANCE * tv;
      if (trendFlip || weekly) trade(d, a, gap, trendFlip ? (goal === 0 ? "trend down: price under its 20-day average" : d === 0 ? "initial allocation" : "trend up: back above its 20-day average") : "weekly rebalance");
    }
    values.push(value(d));
  }
  let peak = -Infinity, dd = 0; for (const v of values) { peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak); }
  const stablesOnly = apy.slice(1, days + 1).reduce((v, a) => v * (1 + a / 100 / 365), amount);
  const holdEth = prices.ETH ? amount * px("ETH", days) / px("ETH", 0) : null;
  const final = values[values.length - 1];
  return { values, trades, final, ret: final / amount - 1, maxDrawdown: dd, feesPaid: fees, yieldEarned, benchmarks: { stablesOnly, holdEth }, targets, stableShare: P.stable };
}

/** "10k USDC, aggressive, 2 weeks" → { amount, risk, days } (sensible defaults, safe limits).
 *  live: hours and minutes are allowed ("6 hours" = 0.25 days), 10 minutes to 60 days, default 7; backtest: 7 to 90 days, default 30 */
export function brief(text: string, live = false): { amount: number; risk: Risk; days: number } {
  const t = text.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1");
  const num = (n: string, k?: string) => Number(n) * (k === "k" ? 1e3 : k === "m" ? 1e6 : 1);
  // the period: "30 days", "2 weeks", "1 month"
  const d = t.match(/(\d+)\s*(days?|d\b|weeks?|w\b|months?)/);
  const h = t.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b|minutes?|mins?)/);
  let days = d ? Number(d[1]) * (/^w/.test(d[2]) ? 7 : /^mo/.test(d[2]) ? 30 : 1) : live && h ? Number(h[1]) / (/^m/.test(h[2]) ? 1440 : 24) : /\bweek\b/.test(t) ? 7 : /\bmonth\b/.test(t) ? 30 : live ? 7 : 30;
  // the budget: "$5k", "10000 usdc", "2.5k usd" — or the biggest other number
  const a = t.match(/\$\s*(\d+(?:\.\d+)?)\s*(k|m)?\b/) ?? t.match(/(\d+(?:\.\d+)?)\s*(k|m)?\s*(?:usdc|usdt|usd|dollars?|\$)/);
  let amount = a ? num(a[1], a[2]) : Math.max(0, ...[...t.replace(d?.[0] ?? "\u0000", " ").replace(h?.[0] ?? "\u0000", " ").matchAll(/(\d+(?:\.\d+)?)\s*(k|m)?\b/g)].map(x => num(x[1], x[2]))) || 10_000;
  const risk: Risk = /\b(high|aggressive|degen|max)\b/.test(t) ? "high" : /\b(low|safe|conservative|prudent)\b/.test(t) ? "low" : "medium";
  days = live ? Math.max(10 / 1440, Math.min(60, days >= 1 ? Math.round(days) : Math.round(days * 1440) / 1440)) : Math.max(7, Math.min(90, Math.round(days)));
  amount = Math.max(100, Math.min(10_000_000, Math.round(amount)));
  return { amount, risk, days };
}


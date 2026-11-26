import type { Asset, Pool } from "./data.js";
import { FEE, GAS_USD, MA, PROFILE, REBALANCE_DAYS, TOLERANCE, type Risk } from "./strategy.js";

/*
 * Steward · LIVE mode. The same rules as the backtest, run forward in real time with paper money:
 *   - every few minutes: real prices now, the stable sleeve earns the lending rate for the time that passed, stop-losses are checked;
 *   - once a day (UTC): the day's close joins the 20-day average, trend filter, weekly rebalance, the lending rate is read again;
 *   - every decision is posted to the client as it happens (Elyra relay, live progress), with the portfolio value for the chart;
 *   - at the end of the period: the final report is delivered on-chain like any other job.
 */
export type Check = { asset: Asset; agentId: number | null; jobId: number | null; score: number | null; note: string };
export type LiveTrade = { t: number; side: "buy" | "sell"; asset: Asset; usd: number; price: number; reason: string };
export type LiveJob = {
  jobId: number; client: string; b: { amount: number; risk: Risk; days: number }; start: number; end: number;
  targets: Partial<Record<Asset, number>>; pools: Pool[]; rate: number; checks: Check[]; notes: string[];
  cash: number; units: Partial<Record<Asset, number>>; entry: Partial<Record<Asset, number>>; stopped: Partial<Record<Asset, boolean>>;
  closes: Partial<Record<Asset, number[]>>; last: Partial<Record<Asset, number>>; ethStart: number | null;
  day: number; lastTick: number; fees: number; yieldEarned: number; trades: LiveTrade[]; peak: number; maxDD: number; done?: boolean;
};

const DAY = 864e5, YEAR_MS = 365 * DAY;
export const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const px = (p: number) => (p < 10 ? p.toFixed(3) : p < 1000 ? p.toFixed(2) : Math.round(p).toLocaleString("en-US"));
const avg = (l: number[]) => l.reduce((s, x) => s + x, 0) / Math.max(l.length, 1);

export function value(j: LiveJob) { return j.cash + (Object.keys(j.units) as Asset[]).reduce((s, a) => s + (j.units[a] ?? 0) * (j.last[a] ?? 0), 0); }
export function alloc(j: LiveJob): Record<string, number> {
  const o: Record<string, number> = { "Stablecoin yield": j.cash };
  for (const a of Object.keys(j.units) as Asset[]) o[a] = (j.units[a] ?? 0) * (j.last[a] ?? 0);
  return o;
}
export function snapshot(j: LiveJob) {
  const v = value(j), eth = j.ethStart && j.last.ETH ? j.last.ETH / j.ethStart - 1 : null;
  return { value: Math.round(v * 100) / 100, amount: j.b.amount, ret: v / j.b.amount - 1, holdEth: eth, alloc: alloc(j), start: j.start, end: j.end, rate: j.rate, trades: j.trades.length };
}

/** a new live portfolio: nothing bought yet, the first decide() makes the initial allocation */
export function open(o: { jobId: number; client: string; b: LiveJob["b"]; start: number; end: number; assets: Asset[]; pools: Pool[]; rate: number; checks: Check[]; notes: string[];
  history: Partial<Record<Asset, number[]>>; now: Partial<Record<Asset, number>> }): LiveJob {
  const P = PROFILE[o.b.risk], blue = o.assets.filter(a => !(a in P.core));
  const targets: Partial<Record<Asset, number>> = {};
  for (const a of o.assets) if (o.now[a] && (o.history[a]?.length ?? 0) >= 5) targets[a] = a in P.core ? P.core[a]! : P.bluechip / Math.max(blue.length, 1);
  return { jobId: o.jobId, client: o.client, b: o.b, start: o.start, end: o.end, targets, pools: o.pools, rate: o.rate, checks: o.checks, notes: o.notes,
    cash: o.b.amount, units: {}, entry: {}, stopped: {}, closes: Object.fromEntries(Object.entries(o.history).map(([k, v]) => [k, (v ?? []).slice(-MA)])), last: { ...o.now },
    ethStart: o.now.ETH ?? null, day: Math.floor(o.start / DAY), lastTick: o.start, fees: 0, yieldEarned: 0, trades: [], peak: o.b.amount, maxDD: 0 };
}

function trade(j: LiveJob, t: number, a: Asset, usdAmt: number, reason: string): string | null {
  const p = j.last[a]; if (!p || Math.abs(usdAmt) < 1) return null;
  const cost = Math.abs(usdAmt) * FEE + GAS_USD;
  if (usdAmt > 0) {
    const spend = Math.min(usdAmt, j.cash - cost); if (spend <= 0) return null;
    j.cash -= spend + cost; j.fees += cost; j.units[a] = (j.units[a] ?? 0) + spend / p; j.entry[a] = p;
    j.trades.push({ t, side: "buy", asset: a, usd: spend, price: p, reason });
    return `Bought ${usd(spend)} of ${a} at ${px(p)} — ${reason}`;
  }
  const u = Math.min(-usdAmt / p, j.units[a] ?? 0); if (u <= 0) return null;
  j.units[a] = (j.units[a] ?? 0) - u; j.cash += u * p - cost; j.fees += cost;
  j.trades.push({ t, side: "sell", asset: a, usd: u * p, price: p, reason });
  if ((j.units[a] ?? 0) < 1e-12) { delete j.units[a]; delete j.entry[a]; }
  return `Sold ${usd(u * p)} of ${a} at ${px(p)} — ${reason}`;
}

/**
 * the rules. daily = a new UTC day (trend filter, weekly rebalance); otherwise only the stop-losses.
 * returns the decisions as lines of text, ready for the client.
 */
export function decide(j: LiveJob, t: number, daily: boolean, first = false): string[] {
  const P = PROFILE[j.b.risk], out: string[] = [];
  const dayN = Math.floor((t - j.start) / DAY);
  for (const a of Object.keys(j.targets) as Asset[]) {
    const p = j.last[a]; if (!p) continue;
    const ma = avg(j.closes[a] ?? [p]), held = (j.units[a] ?? 0) * p;
    if (held > 0 && j.entry[a] && p < j.entry[a]! * (1 - P.stop)) {
      const l = trade(j, t, a, -held, `stop-loss: down ${Math.round((1 - p / j.entry[a]!) * 100)}% from entry (limit ${Math.round(P.stop * 100)}%)`);
      if (l) out.push(l); j.stopped[a] = true; continue;
    }
    if (!daily) continue;
    if (j.stopped[a] && p > ma) { j.stopped[a] = false; out.push(`${a} is back above its 20-day average (${px(ma)}): it can be bought again`); }
    const goal = (j.stopped[a] || p < ma ? 0 : j.targets[a] ?? 0) * value(j), gap = goal - held;
    const flip = (goal === 0 && held > 0) || (goal > 0 && held === 0);
    const weekly = !first && dayN > 0 && dayN % REBALANCE_DAYS === 0 && Math.abs(gap) > TOLERANCE * value(j);
    if (flip || weekly) {
      const l = trade(j, t, a, gap, flip ? (goal === 0 ? `trend down: price under its 20-day average (${px(ma)})` : first ? `initial allocation, target ${Math.round((j.targets[a] ?? 0) * 100)}% (price above its 20-day average ${px(ma)})` : `trend up: back above its 20-day average (${px(ma)})`) : "weekly rebalance back to target");
      if (l) out.push(l);
    } else if (first && goal === 0 && !j.stopped[a]) out.push(`${a} not bought yet: price ${px(p)} is under its 20-day average (${px(ma)}). Waiting for the trend to turn up`);
  }
  return out;
}

/** one step forward in time with the prices of now. Returns the lines to post (empty most of the time). */
export function step(j: LiveJob, t: number, now: Partial<Record<Asset, number>>, rate: number | null): string[] {
  const out: string[] = [];
  const dt = Math.max(0, Math.min(t, j.end) - j.lastTick);
  const y = j.cash * (j.rate / 100) * (dt / YEAR_MS); j.cash += y; j.yieldEarned += y; j.lastTick = Math.min(t, j.end);
  const day = Math.floor(t / DAY), daily = day > j.day;
  if (daily) {
    // the last price seen before midnight closes the day: it joins the 20-day average
    for (const a of Object.keys(j.targets) as Asset[]) if (j.last[a]) j.closes[a] = [...(j.closes[a] ?? []), j.last[a]!].slice(-MA);
    j.day = day;
    if (rate !== null && Math.abs(rate - j.rate) >= 0.01) { out.push(`Lending rate updated: ${j.rate.toFixed(2)}% → ${rate.toFixed(2)}% on the stablecoin sleeve`); j.rate = rate; }
  }
  for (const [a, p] of Object.entries(now)) if (p) j.last[a as Asset] = p;
  out.push(...decide(j, t, daily));
  const v = value(j); j.peak = Math.max(j.peak, v); j.maxDD = Math.max(j.maxDD, (j.peak - v) / j.peak);
  if (daily) {
    const d = Math.min(Math.max(1, Math.ceil((t - j.start) / DAY)), Math.ceil((j.end - j.start) / DAY));
    out.push(`Day ${d} of ${Math.ceil((j.end - j.start) / DAY)}: portfolio ${usd(v)} (${pctS(v / j.b.amount - 1)}) · yield earned so far ${usd(j.yieldEarned)}`);
  }
  return out;
}
export const pctS = (x: number) => `${x > 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

/** the final report, delivered on-chain at the end of the period */
export function report(j: LiveJob): string {
  const v = value(j), ret = v / j.b.amount - 1, d = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
  const hours = (j.end - j.start) / 36e5, period = hours < 1 ? `${Math.round(hours * 60)} minutes` : hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`;
  const stablesOnly = Math.pow(1 + j.rate / 100, (j.end - j.start) / YEAR_MS) - 1;
  const eth = j.ethStart && j.last.ETH ? j.last.ETH / j.ethStart - 1 : null;
  const o: string[] = [];
  o.push(`## Steward · DeFi portfolio managed live`);
  o.push(`${j.b.risk} risk · ${usd(j.b.amount)} · ${period} (${d(j.start)} → ${d(j.end)} UTC) · paper money on live prices and lending rates`);
  o.push(`**Result: ${usd(v)} (${pctS(ret)})** · worst drop along the way ${pctS(-j.maxDD)} · fees and gas ${usd(j.fees)} · yield earned ${usd(j.yieldEarned)}`);
  o.push(`For comparison over the same hours: only stablecoin yield ${pctS(stablesOnly)}${eth !== null ? ` · just holding ETH ${pctS(eth)}` : ""}.`);
  o.push(`## Where the money is at the end`);
  for (const [k, u] of Object.entries(alloc(j)).filter(([, u]) => u > 0.5)) o.push(`- **${k}:** ${usd(u)}`);
  o.push(`Stable sleeve: ${j.pools.map(p => `${p.project} ${p.symbol} on ${p.chain}`).join(" · ") || "no pool data"} (last rate ${j.rate.toFixed(2)}%).`);
  if (j.checks.length) {
    o.push(`## Safety checks (agents hired on Elyra)`);
    for (const c of j.checks) o.push(`- ${c.asset}: ${c.score !== null ? `${c.score}/100 · ` : ""}${c.note}${c.jobId ? ` (agent #${c.agentId}, job #${c.jobId})` : ""}`);
  }
  o.push(`## Trades (${j.trades.length})`);
  const rows = j.trades.slice(-30).map(x => `| ${d(x.t)} | ${x.side} | ${x.asset} | ${usd(x.usd)} | ${px(x.price)} | ${x.reason} |`);
  o.push(rows.length ? ["| Time (UTC) | Action | Asset | Amount | Price | Why |", "|---|---|---|---|---|---|", ...rows].join("\n") + (j.trades.length > 30 ? `\n\n…the first ${j.trades.length - 30} are in the live log.` : "") : "No trades: the rules kept the money in the stablecoin sleeve.");
  o.push(`## Rules`);
  o.push(`Stable sleeve in blue-chip lending pools only · risk assets only above their 20-day average · stop-loss ${Math.round(PROFILE[j.b.risk].stop * 100)}% from entry · back to targets every 7 days · 0.3% fee + $5 gas per trade.`);
  for (const n of j.notes) o.push(`_${n}_`);
  o.push(`_Steward is a reference agent by the Elyra team. Paper money on real live data: no real funds were moved, it is not financial advice, and results say nothing about the future._`);
  const json = { agent: "steward", version: 1, mode: "live", risk: j.b.risk, amount: j.b.amount, from: new Date(j.start).toISOString(), to: new Date(j.end).toISOString(),
    final: Math.round(v), ret: Number(ret.toFixed(4)), maxDrawdown: Number(j.maxDD.toFixed(4)), trades: j.trades.length,
    benchmarks: { stablesOnly: Number(stablesOnly.toFixed(4)), holdEth: eth !== null ? Number(eth.toFixed(4)) : null },
    checks: j.checks.map(c => ({ asset: c.asset, score: c.score, agentId: c.agentId, jobId: c.jobId })) };
  let out = o.join("\n\n"); const tail = "\n\n```json\n" + JSON.stringify(json) + "\n```";
  if (out.length + tail.length > 7900) out = out.slice(0, 7900 - tail.length - 5) + " …";
  return out + tail;
}

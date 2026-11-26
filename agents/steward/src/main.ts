/*
 * STEWARD · a simulated DeFi portfolio manager for Elyra (reference agent by the Elyra team, built with the Elyra Agent SDK).
 *
 * The client gives a budget, a risk level and a period, e.g. "10000 USDC, medium risk, 7 days".
 * Steward picks blue-chip stablecoin lending markets (Aave v3, Compound v3: rates read on-chain), HIRES a safety agent on Elyra
 * (Sentinel) to check every extra token before holding it, then MANAGES the portfolio LIVE for that period with paper money
 * on real prices: allocation, trend filter, stop-loss, weekly rebalance. Every decision is posted to the client as it happens
 * (live progress on the job page); at the end it delivers the final report on-chain, with a JSON block other agents can read.
 * "backtest …" / "last 30 days" runs the same rules instantly on past data instead.
 * Paper money: no real funds, not financial advice.
 *
 *   AGENT_KEY=0x… NETWORK=sepolia node dist/agents/steward/src/main.js     (AGENT_ID=… after the first run)
 *   STEWARD_PRICE=8 · STEWARD_CHECK_BUDGET=6 (tUSDC for safety checks per job, at most 75% of what the client paid) · STEWARD_WAIT_MIN=8 · ELYRA_URL=…
 *   LIVE_TICK_MIN=15 (how often live portfolios look at the market) · LIVE_FILE=.steward-live.json (live portfolios, kept across restarts)
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { ElyraAgent, NETWORKS, type Task } from "../../../sdk/src/index.js";
import { ASSETS, nowPrices, prices, stablePools, type Asset, type Pool } from "./data.js";
import * as Live from "./live.js";
import { brief, MA, PROFILE, simulate, type Risk, type Sim } from "./strategy.js";

const env = process.env, DAY = 864e5;
const PRICE = Number(env.STEWARD_PRICE ?? 8), CHECK_BUDGET = Number(env.STEWARD_CHECK_BUDGET ?? 6), WAIT = Number(env.STEWARD_WAIT_MIN ?? 8) * 60_000;
/** the agent id is saved next to the agent after the first run, so a restart never registers a second agent */
const NET = (env.NETWORK as "sepolia" | "orbinum") ?? "sepolia";
const STATE = env.STATE_FILE ?? (NET === "orbinum" ? `.steward-state.orbinum.json` : `.steward-state.json`);
/* the registry this agent is registered on: after a redeploy of the protocol the old id means nothing, so it registers again */
const REGISTRY = ((env.CONTRACTS ? (JSON.parse(env.CONTRACTS) as { registry?: string }).registry : undefined) ?? NETWORKS[NET].registry).toLowerCase();
const loaded = (() => { try { return JSON.parse(readFileSync(STATE, "utf8")) as { agentId?: number; bonded?: boolean; registry?: string }; } catch { return {}; } })();
const redeployed = !!loaded.agentId && !!loaded.registry && loaded.registry.toLowerCase() !== REGISTRY;
const saved: { agentId?: number; bonded?: boolean; registry?: string } = redeployed ? {} : loaded;
if (redeployed) console.log(`The Elyra registry changed (redeploy): registering again on ${REGISTRY}`);
const agent = new ElyraAgent({
  network: NET, privateKey: env.AGENT_KEY!, agentId: env.AGENT_ID ? Number(env.AGENT_ID) : saved.agentId,
  relayUrl: env.ELYRA_URL, rpcUrl: env.RPC_URL, contracts: env.CONTRACTS ? JSON.parse(env.CONTRACTS) : undefined,
});

/** asks a safety agent on Elyra about each extra token; keeps those scored 50+ (or unchecked, with a note) */
async function safety(tokens: Asset[], budget: number): Promise<{ keep: Asset[]; checks: { asset: Asset; agentId: number | null; jobId: number | null; score: number | null; note: string }[] }> {
  const checks: { asset: Asset; agentId: number | null; jobId: number | null; score: number | null; note: string }[] = [];
  if (!tokens.length) return { keep: [], checks };
  // Sentinel first (it gives a 0–100 score); otherwise the best affordable token-safety agent
  const list = await agent.agents("token").catch(() => []);
  const checker = list.find(a => /sentinel/i.test(a.name) && (a.price ?? 99) <= budget) ?? list.find(a => (a.price ?? 99) <= budget);
  let left = budget;
  const jobs = await Promise.all(tokens.map(async asset => {
    if (!checker || (checker.price ?? 0) > left) return { asset, agentId: null, jobId: null };
    left -= checker.price!;
    try { return { asset, agentId: checker.id, jobId: await agent.hire({ agentId: checker.id, amount: checker.price!, skill: "token", values: { address: ASSETS[asset].address }, hours: 2 }) }; }
    catch (e) { agent.log(`safety ${asset}: ${(e as Error).message}`); return { asset, agentId: checker.id, jobId: null }; }
  }));
  const keep: Asset[] = [];
  for (const j of jobs) {
    // a token nobody checked is not held: safety first
    if (!j.jobId) { checks.push({ ...j, score: null, note: "not checked (no safety agent within budget): kept out" }); continue; }
    const text = await agent.result(j.jobId, { timeoutMs: WAIT });
    if (text) await agent.collect(j.jobId).catch(() => {});
    const json = text?.match(/```json\s*([\s\S]*?)```/)?.[1];
    let score: number | null = null; try { score = json ? Number(JSON.parse(json).score) : null; } catch { /* free text answer */ }
    if (score === null && text) { const m = text.match(/(\d{1,3})\s*\/\s*100/); if (m) score = Number(m[1]); }
    const ok = !!text && (score === null || score >= 50);
    checks.push({ ...j, score, note: !text ? "no answer in time: kept out" : score === null ? "checked (no numeric score): held" : ok ? "passed: held" : "failed the safety check: kept out" });
    if (ok) keep.push(j.asset);
  }
  return { keep, checks };
}

const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const pct = (x: number, sign = true) => `${sign && x > 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const day = (start: number, d: number) => new Date(start + d * DAY).toISOString().slice(0, 10);

function render(b: { amount: number; risk: Risk; days: number }, start: number, pools: Pool[], sim: Sim, checks: Awaited<ReturnType<typeof safety>>["checks"], notes: string[]): string {
  const o: string[] = [];
  o.push(`## Steward · simulated DeFi portfolio`);
  o.push(`${b.risk} risk · ${usd(b.amount)} · ${b.days} days (${day(start, 0)} → ${day(start, b.days)}) · paper money on real prices and yields`);
  o.push(`**Result: ${usd(sim.final)} (${pct(sim.ret)})** · worst drop along the way ${pct(-sim.maxDrawdown, false)} · fees and gas ${usd(sim.feesPaid)} · yield earned ${usd(sim.yieldEarned)}`);
  o.push(`For comparison: only stablecoin yield ${pct(sim.benchmarks.stablesOnly / b.amount - 1)}${sim.benchmarks.holdEth !== null ? ` · just holding ETH ${pct(sim.benchmarks.holdEth / b.amount - 1)}` : ""}.`);
  o.push(`## How the money was placed`);
  o.push(`- **Stablecoin yield, ${Math.round(sim.stableShare * 100)}% plus anything not in the market:** ${pools.map(p => `${p.project} ${p.symbol} on ${p.chain} (${p.apyBase.toFixed(1)}% now, ${usd(p.tvl)} supplied)`).join(" · ") || "no pool data"}`);
  for (const [a, w] of Object.entries(sim.targets)) o.push(`- **${a}:** target ${Math.round((w ?? 0) * 100)}%, held only while its price is above its 20-day average`);
  if (checks.length) {
    o.push(`## Safety checks (agents hired on Elyra)`);
    for (const c of checks) o.push(`- ${c.asset}: ${c.score !== null ? `${c.score}/100 · ` : ""}${c.note}${c.jobId ? ` (agent #${c.agentId}, job #${c.jobId})` : ""}`);
  }
  o.push(`## Trades (${sim.trades.length})`);
  const rows = sim.trades.slice(0, 24).map(t => `| ${day(start, t.day)} | ${t.side} | ${t.asset} | ${usd(t.usd)} | ${t.price < 10 ? t.price.toFixed(3) : Math.round(t.price).toLocaleString("en-US")} | ${t.reason} |`);
  o.push(["| Date | Action | Asset | Amount | Price | Why |", "|---|---|---|---|---|---|", ...rows].join("\n") + (sim.trades.length > 24 ? `\n\n…and ${sim.trades.length - 24} more.` : ""));
  o.push(`## Rules`);
  o.push(`Stable sleeve in blue-chip lending pools only · risk assets only above their 20-day average · stop-loss ${Math.round(PROFILE[b.risk].stop * 100)}% from entry · back to targets every 7 days · 0.3% fee + $5 gas per trade.`);
  for (const n of notes) o.push(`_${n}_`);
  o.push(`_Steward is a reference agent by the Elyra team. This is a simulation with paper money on past data: no real funds were moved, it is not financial advice, and past results say nothing about the future._`);
  const json = { agent: "steward", version: 1, mode: "simulation", risk: b.risk, amount: b.amount, days: b.days, from: day(start, 0), to: day(start, b.days),
    final: Math.round(sim.final), ret: Number(sim.ret.toFixed(4)), maxDrawdown: Number(sim.maxDrawdown.toFixed(4)), trades: sim.trades.length,
    benchmarks: { stablesOnly: Number((sim.benchmarks.stablesOnly / b.amount - 1).toFixed(4)), holdEth: sim.benchmarks.holdEth !== null ? Number((sim.benchmarks.holdEth / b.amount - 1).toFixed(4)) : null },
    checks: checks.map(c => ({ asset: c.asset, score: c.score, agentId: c.agentId, jobId: c.jobId })) };
  let out = o.join("\n\n"); const tail = "\n\n```json\n" + JSON.stringify(json) + "\n```";
  if (out.length + tail.length > 7900) out = out.slice(0, 7900 - tail.length - 5) + " …";
  return out + tail;
}

/* ---------------------------------------------------------------- live portfolios (kept on disk: a restart picks them up) */
const LIVE_FILE = env.LIVE_FILE ?? (NET === "orbinum" ? ".steward-live.orbinum.json" : ".steward-live.json"), TICK = Number(env.LIVE_TICK_MIN ?? 15) * 60_000;
/* live portfolios of an older deployment can never be delivered to the new escrow: they are set aside, not deleted */
if (redeployed) { try { renameSync(LIVE_FILE, `${LIVE_FILE}.before-redeploy`); } catch { /* none */ } }
const lives: Record<string, Live.LiveJob> = (() => { try { return JSON.parse(readFileSync(LIVE_FILE, "utf8")); } catch { return {}; } })();
const keepLives = () => { writeFileSync(LIVE_FILE + ".tmp", JSON.stringify(lives)); renameSync(LIVE_FILE + ".tmp", LIVE_FILE); };
/** posts to the client's job page; a failed post never stops the portfolio */
const post = (jobId: number, text?: string, data?: Record<string, unknown>) => agent.progress(jobId, { text, data }).catch(e => agent.log(`job #${jobId}: progress not posted (${(e as Error).message})`));

/** the stable sleeve: blue-chip USDC lending markets with enough deposits, best rate first, max 3 (both protocols when possible) */
async function pickPools(risk: Risk) {
  const all = (await stablePools(risk === "low" ? 100e6 : 20e6).catch(() => [])).sort((x, y) => y.apyBase - x.apyBase);
  const pools: Pool[] = []; for (const p of all) { if (pools.length >= 3) break; if (pools.filter(q => q.project === p.project).length < 2) pools.push(p); }
  return { pools, rate: pools.length ? pools.reduce((s, p) => s + p.apyBase, 0) / pools.length : 0 };
}

async function backtest(task: Task, text: string): Promise<string> {
  const b = brief(text), notes: string[] = [];
  agent.log(`job #${task.jobId}: backtest · ${b.risk} risk · ${b.amount} USD · ${b.days} days`);
  const today = Math.floor(Date.now() / DAY) * DAY, start = today - b.days * DAY;
  const { pools, rate } = await pickPools(b.risk);
  const blue = PROFILE[b.risk].bluechip > 0 ? (Object.keys(ASSETS) as Asset[]).filter(a => ASSETS[a].sleeve === "bluechip") : [];
  const { keep, checks } = await safety(blue, Math.min(CHECK_BUDGET, task.amount * 0.75));
  const assets = [...(Object.keys(PROFILE[b.risk].core) as Asset[]), ...keep];
  const px = await prices(assets, start - MA * DAY, b.days + MA);
  for (const a of assets) if (!px[a]) notes.push(`No price data for ${a}: not held.`);
  // the stable sleeve earns the average of the chosen markets' current rates (lending rates move slowly; history is not free any more)
  const apy = Array.from({ length: b.days + 1 }, () => rate);
  if (!pools.length) notes.push("No lending market answered: the stable sleeve earned 0% in the simulation.");
  else notes.push(`Stablecoin yield uses today's rates of the chosen markets (${rate.toFixed(2)}% on average) for the whole period.`);
  const sim = simulate(b.amount, b.risk, b.days, assets, px, apy);
  agent.log(`job #${task.jobId}: ${pct(sim.ret)} · ${sim.trades.length} trades · ${checks.filter(c => c.jobId).length} safety checks hired`);
  return render(b, start, pools, sim, checks, notes);
}

/** takes a live job on: market data first (a failure here costs nothing and the relay retries), then the safety checks, then the first allocation */
async function startLive(task: Task, text: string): Promise<string | null> {
  const b = brief(text, true), now = Date.now(), notes: string[] = [];
  // the period must fit before the escrow deadline (with 3 h to deliver)
  const room = task.deadline * 1000 - now - 3 * 3600e3;
  let ms = b.days * DAY;
  if (room < 600e3) { agent.log(`job #${task.jobId}: deadline too close for a live run → backtest`); return backtest(task, text + " backtest"); }
  if (ms > room) { ms = room; notes.push(`The job's escrow deadline allowed ${Math.round(room / 36e5)} hours of live management instead of ${Math.round(b.days * 24)}.`); }
  agent.log(`job #${task.jobId}: LIVE · ${b.risk} risk · ${b.amount} USD · ${Math.round(ms / 36e5)} h`);
  const blue = PROFILE[b.risk].bluechip > 0 ? (Object.keys(ASSETS) as Asset[]).filter(a => ASSETS[a].sleeve === "bluechip") : [];
  const candidates = [...(Object.keys(PROFILE[b.risk].core) as Asset[]), ...blue];
  const [{ pools, rate }, history, current] = await Promise.all([pickPools(b.risk), prices(candidates, Math.floor(now / DAY) * DAY - MA * DAY, MA - 1), nowPrices(candidates)]);
  if (!Object.keys(current).length) throw new Error("no live prices right now (will retry)");
  await post(task.jobId, `Job accepted: ${usd(b.amount)} of paper money, ${b.risk} risk, managed live until ${new Date(now + ms).toISOString().slice(0, 16).replace("T", " ")} UTC`, { value: b.amount, amount: b.amount, start: now, end: now + ms });
  await post(task.jobId, pools.length ? `Stablecoin sleeve: ${pools.map(p => `${p.project} USDC on ${p.chain} ${p.apyBase.toFixed(2)}%`).join(" · ")} (rates read on-chain)` : "No lending market answered: the stable sleeve earns 0% for now");
  let keep: Asset[] = [], checks: Live.Check[] = [];
  if (blue.length) {
    await post(task.jobId, `Hiring a safety agent on Elyra to check ${blue.join(", ")} before holding them…`);
    ({ keep, checks } = await safety(blue, Math.min(CHECK_BUDGET, task.amount * 0.75)));
    for (const c of checks) await post(task.jobId, `${c.asset}: ${c.score !== null ? `${c.score}/100 · ` : ""}${c.note}${c.jobId ? ` (agent #${c.agentId}, job #${c.jobId})` : ""}`);
  }
  const assets = [...(Object.keys(PROFILE[b.risk].core) as Asset[]), ...keep];
  for (const a of assets) if (!current[a] || (history[a]?.length ?? 0) < 5) notes.push(`No price data for ${a} at the start: not held.`);
  const j = Live.open({ jobId: task.jobId, client: task.client, b, start: now, end: now + ms, assets, pools, rate, checks, notes, history, now: current });
  const lines = Live.decide(j, now, true, true);
  for (const l of lines) await post(task.jobId, l);
  lives[task.jobId] = j; keepLives();
  await post(task.jobId, `Portfolio open: ${Object.entries(Live.alloc(j)).filter(([, u]) => u > 0.5).map(([k, u]) => `${k} ${usd(u)}`).join(" · ")}. Next look at the market in ${Math.round(TICK / 60000)} min`, Live.snapshot(j));
  return null;                                                    // delivered at the end of the period (see tick)
}

/** every few minutes: all live portfolios look at the market; finished ones are delivered */
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    const open = Object.values(lives).filter(j => !j.done);
    if (!open.length) return;
    const all = [...new Set(open.flatMap(j => Object.keys(j.targets) as Asset[]))];
    const now = Date.now(), px = await nowPrices(all).catch(e => { agent.log(`live: prices not available (${(e as Error).message})`); return null; });
    if (!px) return;
    // the lending rate is read again once a day
    const newDay = open.some(j => Math.floor(now / DAY) > j.day);
    const rates = newDay ? await stablePools(20e6).catch(() => []) : [];
    for (const j of open) {
      const mine = rates.filter(p => j.pools.some(q => q.id === p.id));
      const rate = mine.length ? mine.reduce((s, p) => s + p.apyBase, 0) / mine.length : null;
      const t = Math.min(now, j.end);
      const lines = Live.step(j, t, px, rate);
      for (const l of lines) await post(j.jobId, l);
      await post(j.jobId, undefined, Live.snapshot(j));
      if (now >= j.end) {
        await post(j.jobId, `Period over: final value ${usd(Live.value(j))} (${Live.pctS(Live.value(j) / j.b.amount - 1)}). Delivering the report on-chain…`);
        try { await agent.deliver(j.jobId, Live.report(j)); j.done = true; agent.log(`job #${j.jobId}: live run delivered`); }
        catch (e) {
          agent.log(`job #${j.jobId}: delivery failed (${(e as Error).message})`);
          const info = await agent.job(j.jobId).catch(() => null);
          if (info && info.status !== 1) j.done = true;           // refunded or already delivered: nothing more to do
        }
      }
      keepLives();
    }
    // finished portfolios are kept one day (for a late look), then removed
    for (const [k, j] of Object.entries(lives)) if (j.done && Date.now() > j.end + DAY) delete lives[k];
    keepLives();
  } finally { ticking = false; }
}

agent.onTask(async (task: Task) => {
  const text = task.values.task ?? task.values.text ?? task.task;
  if (lives[task.jobId]) return null;                                  // already running live (e.g. after a restart)
  if (/\b(backtest|past|history|historical|last)\b/i.test(text)) return backtest(task, text);
  return startLive(task, text);
});

// first run: register on-chain; every run: make sure the bond is in place and the relay knows how to reach us
const save = (x: Record<string, unknown>) => { Object.assign(saved, x); writeFileSync(STATE, JSON.stringify({ ...saved, address: agent.address, network: NET, registry: REGISTRY })); };
/* a saved id that this wallet does not own on the current registry (the protocol was redeployed): register again */
if (agent.agentId && !(await agent.owns(agent.agentId))) {
  console.log(`Agent #${agent.agentId} is not ours on ${REGISTRY}: the protocol was redeployed, registering again`);
  agent.agentId = null; for (const k of Object.keys(saved)) delete (saved as Record<string, unknown>)[k];
  if (Object.keys(lives).length) { try { renameSync(LIVE_FILE, `${LIVE_FILE}.before-redeploy`); } catch { /* none */ } for (const k of Object.keys(lives)) delete lives[k]; }
}
if (!agent.agentId) {
  await agent.register({ name: "Steward · DeFi Portfolio (simulated)", services: "defi:portfolio-simulation", pricing: `${PRICE} tUSDC/job`, profileURI: "https://github.com/ElyraDev0/elyra-protocol/tree/main/agents/steward" });
  save({ agentId: agent.agentId });
}
if (!(saved as { bonded?: boolean }).bonded) { await agent.bond(100); await agent.faucet().catch(() => {}); save({ bonded: true }); }
await agent.connect({ price: PRICE, description: "Write e.g. \"10000 USDC, medium risk, 7 days\". Manages a DeFi portfolio LIVE with paper money (stablecoin yield, ETH/BTC, tokens checked by Sentinel): watch every trade as it happens. \"backtest…\" = instant on past data. Not financial advice." });
console.log(`\n${agent.address} is agent #${agent.agentId} (saved in ${STATE})\n`);
setInterval(() => { agent.faucet().catch(() => {}); }, 12 * 3600e3).unref();   // test tUSDC to keep hiring helpers
setInterval(() => { tick().catch(e => agent.log(`live: ${(e as Error).message}`)); }, TICK);
setTimeout(() => { tick().catch(() => {}); }, 20_000);              // after a restart: catch up at once
await agent.poll({ everyMs: Number(env.POLL_MS ?? 5000), once: env.ONCE === "1" });

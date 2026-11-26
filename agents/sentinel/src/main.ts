/*
 * SENTINEL · a crypto safety analyst agent for Elyra (reference agent by the Elyra team, built with the Elyra Agent SDK).
 *
 * Give it a token address: it reads the market, the contract and the holders from free public sources,
 * HIRES other agents on Elyra for a second opinion (a code review of the contract, a profile of the
 * deployer wallet), pays them through escrow, and returns a safety score 0–100 with the reasons
 * plus a JSON block other agents can use.
 *
 *   AGENT_KEY=0x… NETWORK=sepolia node dist/agents/sentinel/src/main.js
 *   AGENT_ID=…            after the first run (printed)
 *   SENTINEL_PRICE=2      price per job in tUSDC        SENTINEL_HIRE_BUDGET=1.5   max tUSDC spent on helpers per job
 *   SENTINEL_WAIT_MIN=4   minutes to wait for helpers   GROQ_API_KEY=…             plain-words verdict (optional)
 *   ELYRA_URL=…           relay/market (default https://elyraprotocol.com)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ElyraAgent, NETWORKS, type MarketAgent, type Skill, type Task } from "../../../sdk/src/index.js";
import { check, keyCode } from "./checks.js";
import { contract, market } from "./data.js";
import { aiVerdict, render, ruleVerdict, type Review } from "./report.js";

const env = process.env;
const PRICE = Number(env.SENTINEL_PRICE ?? 2), BUDGET = Number(env.SENTINEL_HIRE_BUDGET ?? 1.5), WAIT = Number(env.SENTINEL_WAIT_MIN ?? 4) * 60_000;

/** the agent id is saved next to the agent after the first run, so a restart never registers a second agent */
const NET = (env.NETWORK as "sepolia" | "orbinum") ?? "sepolia";
const STATE = env.STATE_FILE ?? (NET === "orbinum" ? `.sentinel-state.orbinum.json` : `.sentinel-state.json`);
/* the registry this agent is registered on: after a redeploy of the protocol the old id means nothing, so it registers again */
const REGISTRY = ((env.CONTRACTS ? (JSON.parse(env.CONTRACTS) as { registry?: string }).registry : undefined) ?? NETWORKS[NET].registry).toLowerCase();
const loaded = (() => { try { return JSON.parse(readFileSync(STATE, "utf8")) as { agentId?: number; bonded?: boolean; registry?: string }; } catch { return {}; } })();
const redeployed = !!loaded.agentId && !!loaded.registry && loaded.registry.toLowerCase() !== REGISTRY;
const saved: { agentId?: number; bonded?: boolean; registry?: string } = redeployed ? {} : loaded;
if (redeployed) console.log(`The Elyra registry changed (redeploy): registering again on ${REGISTRY}`);
const agent = new ElyraAgent({
  network: NET, privateKey: env.AGENT_KEY!,
  agentId: env.AGENT_ID ? Number(env.AGENT_ID) : saved.agentId, relayUrl: env.ELYRA_URL, rpcUrl: env.RPC_URL,
  contracts: env.CONTRACTS ? JSON.parse(env.CONTRACTS) : undefined,
});

/** the address in the task: the catalog field, or the first 0x… in an open task */
const addressOf = (t: Task) => (t.values.address ?? t.task.match(/0x[a-fA-F0-9]{40}/)?.[0] ?? "").trim();

/** hires the best affordable agent for a skill and returns its job, or null */
async function hire(kind: Review["kind"], skill: Skill, values: Record<string, string>, left: { usd: number }): Promise<Omit<Review, "text"> | null> {
  let list: MarketAgent[] = [];
  try { list = await agent.agents(skill); } catch (e) { agent.log(`market list: ${(e as Error).message}`); return null; }
  const a = list.find(x => (x.price ?? 0) > 0 && (x.price ?? 0) <= left.usd);
  if (!a) { agent.log(`no ${skill} agent within ${left.usd} tUSDC`); return null; }
  try {
    const jobId = await agent.hire({ agentId: a.id, amount: a.price!, skill, values, hours: 2 });
    left.usd -= a.price!;
    return { kind, agentId: a.id, jobId, paid: a.price! };
  } catch (e) { agent.log(`hire ${skill}: ${(e as Error).message}`); return null; }
}

agent.onTask(async task => {
  const address = addressOf(task);
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return "## Sentinel\nSend a token or contract address (0x… on Ethereum or Base) and Sentinel will check it.";
  agent.log(`job #${task.jobId}: checking ${address}`);
  const m = await market(address);
  const c = await contract(m.chain ?? "ethereum", address).catch(e => { agent.log(`contract: ${(e as Error).message}`); return null; });
  const v = check(m, c);

  // second opinions from other agents on Elyra (paid from the job's own price, capped)
  const left = { usd: Math.min(BUDGET, task.amount * 0.75) };
  const jobs: Omit<Review, "text">[] = [];
  const onEth = (m.chain ?? "ethereum") === "ethereum";                  // the market's helper agents read Ethereum mainnet
  if (c?.verified && c.source) { const j = await hire("code", "code", { code: keyCode(c.source) }, left); if (j) jobs.push(j); }
  else if (onEth) { const j = await hire("contract", "contract", { address }, left); if (j) jobs.push(j); }
  if (c?.creator && onEth) { const j = await hire("wallet", "wallet", { address: c.creator }, left); if (j) jobs.push(j); }
  const reviews: Review[] = await Promise.all(jobs.map(async j => ({ ...j, text: await agent.result(j.jobId, { timeoutMs: WAIT }) })));
  // pay the helpers who delivered (release the escrow); the others get refunded after their deadline
  for (const r of reviews) if (r.text) await agent.collect(r.jobId).catch(e => agent.log(`release #${r.jobId}: ${(e as Error).message}`));

  const verdict = (await aiVerdict(m, c, v, reviews)) ?? ruleVerdict(v);
  agent.log(`job #${task.jobId}: score ${v.score}/100 · ${reviews.filter(r => r.text).length}/${reviews.length} second opinions`);
  return render(address, m, c, v, reviews, verdict);
});

// first run: register on-chain; every run: make sure the bond is in place and the relay knows how to reach us
const save = (x: Record<string, unknown>) => { Object.assign(saved, x); writeFileSync(STATE, JSON.stringify({ ...saved, address: agent.address, network: NET, registry: REGISTRY })); };
/* a saved id that this wallet does not own on the current registry (the protocol was redeployed): register again */
if (agent.agentId && !(await agent.owns(agent.agentId))) {
  console.log(`Agent #${agent.agentId} is not ours on ${REGISTRY}: the protocol was redeployed, registering again`);
  agent.agentId = null; for (const k of Object.keys(saved)) delete (saved as Record<string, unknown>)[k];
}
if (!agent.agentId) {
  await agent.register({ name: "Sentinel · Crypto Safety Analyst", services: "token:safety,contract:risk", pricing: `${PRICE} tUSDC/job`, profileURI: "https://github.com/ElyraDev0/elyra-protocol/tree/main/agents/sentinel" });
  save({ agentId: agent.agentId });
}
if (!(saved as { bonded?: boolean }).bonded) { await agent.bond(100); await agent.faucet().catch(() => {}); save({ bonded: true }); }
  await agent.connect({ skills: ["token", "contract"], price: PRICE, description: "Safety score 0–100 for any token on Ethereum or Base: liquidity, honeypot signs, contract powers (mint, blacklist, fees, proxy), holders and the deployer’s bag, plus second opinions it hires from other Elyra agents. Not financial advice." });
console.log(`\n${agent.address} is agent #${agent.agentId} (saved in ${STATE})\n`);
setInterval(() => { agent.faucet().catch(() => {}); }, 12 * 3600e3).unref();   // test tUSDC to keep hiring helpers
await agent.poll({ everyMs: Number(env.POLL_MS ?? 5000), once: env.ONCE === "1" });

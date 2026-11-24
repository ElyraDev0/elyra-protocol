import type { Verdict } from "./checks.js";
import { CHAINS, type Contract, type Market } from "./data.js";

/*
 * Sentinel · the report. Markdown for people, plus a JSON block other agents can read.
 * The plain-words verdict is written by an AI (Groq, optional) from the numbers only; without a key, by fixed rules.
 */
export type Review = { kind: "code" | "contract" | "wallet"; agentId: number; jobId: number; paid: number; text: string | null };

const usd = (n: number | null) => (n === null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const ICON = { high: "🔴", medium: "🟠", low: "🟡", good: "🟢" } as const;
const trim = (s: string, n: number) => { const t = s.replace(/\n{3,}/g, "\n\n").trim(); return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + " …" : t; };

export function ruleVerdict(v: Verdict): string {
  const bad = v.flags.filter(f => f.severity === "high").map(f => f.title.toLowerCase());
  if (!bad.length && v.risk === "low") return "No serious red flags in the data Sentinel can see. That is not a guarantee: always size your position for the risk.";
  if (!bad.length) return "Some warning signs, none critical on its own. Check the points above before buying.";
  return `Serious red flags: ${bad.slice(0, 3).join(", ")}. Treat it as very risky.`;
}

export async function aiVerdict(m: Market, c: Contract | null, v: Verdict, reviews: Review[]): Promise<string | null> {
  const key = process.env.GROQ_API_KEY; if (!key) return null;
  const facts = { token: m.symbol || c?.symbol, chain: m.chain, score: v.score, risk: v.risk, liquidityUsd: Math.round(m.liquidityUsd), flags: v.flags.map(f => `${f.severity}: ${f.title} — ${f.detail}`), reviews: reviews.filter(r => r.text).map(r => `${r.kind}: ${trim(r.text!, 700)}`) };
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.GROQ_MODEL || "openai/gpt-oss-120b", temperature: 0.2, max_tokens: 900, reasoning_effort: "low", include_reasoning: false, messages: [
        { role: "system", content: "You are Sentinel, a crypto safety analyst. Write a verdict of at most 4 sentences in plain English for a beginner deciding whether this token is safe to buy. Use ONLY the facts given; mention the 2-3 most important risks; say clearly if data is missing. No financial advice, no price talk, no lists, no emojis." },
        { role: "user", content: JSON.stringify(facts) }] }) });
    const j = await r.json() as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

export function render(address: string, m: Market, c: Contract | null, v: Verdict, reviews: Review[], verdict: string): string {
  const name = m.symbol || c?.symbol || "token", chain = m.chain ? CHAINS[m.chain].label : "unknown chain";
  const o: string[] = [];
  o.push(`## Sentinel safety report · ${name} (${chain})`);
  o.push(`**Safety score: ${v.score}/100 · ${v.risk} risk**`);
  o.push(verdict);
  o.push(`## What Sentinel found`);
  for (const f of v.flags.filter(x => x.severity !== "good").slice(0, 8)) o.push(`- ${ICON[f.severity]} **${f.title}.** ${f.detail}`);
  const good = v.flags.filter(x => x.severity === "good");
  if (good.length) o.push(`- 🟢 ${good.map(g => g.title).join(" · ")}`);
  o.push(`## Market`);
  o.push(`- Liquidity ${usd(m.liquidityUsd)} · volume 24h ${usd(m.volume24h)} · ${m.buys24h} buys / ${m.sells24h} sells${m.priceChange24h !== null ? ` · price 24h ${m.priceChange24h > 0 ? "+" : ""}${m.priceChange24h}%` : ""}`);
  if (m.otherChains.length) o.push(`- Also traded on: ${m.otherChains.slice(0, 5).join(", ")}`);
  if (c) {
    o.push(`## Contract and holders`);
    o.push(`- ${c.verified ? "Verified" : "Not verified"}${c.proxy ? " · upgradeable proxy" : ""} · owner ${c.ownerKnown ? (c.owner ?? "renounced") : "not readable"} · ${c.holdersCount !== null ? `${c.holdersCount.toLocaleString("en-US")} holders` : "holders unknown"}${c.creator ? ` · deployer ${c.creator}` : ""}`);
  }
  const done = reviews.filter(r => r.text);
  if (reviews.length) {
    o.push(`## Second opinions (agents hired on Elyra)`);
    for (const r of reviews) o.push(r.text ? `**${r.kind === "wallet" ? "Deployer wallet" : "Contract review"}** · agent #${r.agentId}, job #${r.jobId}\n${trim(r.text, 900)}` : `- ${r.kind === "wallet" ? "Deployer wallet" : "Contract review"} (agent #${r.agentId}, job #${r.jobId}): no answer in time.`);
  }
  o.push(`_Sentinel is a reference agent by the Elyra team. Automated checks on public data, not financial advice: a clean report does not make a token safe._`);
  const json = { agent: "sentinel", version: 1, token: address.toLowerCase(), chain: m.chain, symbol: name, score: v.score, risk: v.risk,
    flags: v.flags.filter(f => f.severity !== "good").map(f => ({ id: f.id, severity: f.severity })), liquidityUsd: Math.round(m.liquidityUsd),
    reviews: done.map(r => ({ kind: r.kind, agentId: r.agentId, jobId: r.jobId })) };
  let out = o.join("\n\n");
  const tail = "\n\n```json\n" + JSON.stringify(json) + "\n```";
  if (out.length + tail.length > 7900) out = out.slice(0, 7900 - tail.length - 5) + " …";
  return out + tail;
}

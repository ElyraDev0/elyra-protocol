import type { Contract, Market } from "./data.js";

/*
 * Sentinel · the checks. Fixed rules, the same for every token, so the score is repeatable and explainable.
 * Every finding has a severity; the safety score starts at 100 and loses points for each one.
 */
export type Severity = "high" | "medium" | "low" | "good";
export type Flag = { id: string; severity: Severity; title: string; detail: string };
export type Verdict = { score: number; risk: "low" | "medium" | "high" | "very high"; flags: Flag[] };

const PENALTY: Record<Severity, number> = { high: 25, medium: 10, low: 3, good: 0 };
const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const DAY = 864e5;

/** what the owner of the contract can still do, read from the function names */
const POWERS: { id: string; re: RegExp; what: string; severity: Severity }[] = [
  { id: "mint", re: /^(mint|_?mintTo|issue)$/i, what: "create new tokens (dilute holders)", severity: "high" },
  { id: "blacklist", re: /(blacklist|blocklist|addbot|setbots?|isbot|antibot|freeze)/i, what: "block wallets from selling", severity: "high" },
  { id: "fees", re: /(set|update|change).*(fee|tax)/i, what: "change the buy/sell tax", severity: "medium" },
  { id: "trading", re: /(enable|open|start|set).*trading|tradingenabled|settradingstatus/i, what: "switch trading on and off", severity: "medium" },
  { id: "limits", re: /(set|update).*(maxtx|maxwallet|maxtransaction|max_?amount)/i, what: "limit how much a wallet can buy or sell", severity: "low" },
  { id: "pause", re: /^(pause|unpause)$/i, what: "pause all transfers", severity: "medium" },
  { id: "exempt", re: /exclude.*fee|setexempt|whitelist/i, what: "exempt chosen wallets from fees or limits", severity: "low" },
];

export function check(m: Market, c: Contract | null, now = Date.now()): Verdict {
  const f: Flag[] = [];
  const add = (id: string, severity: Severity, title: string, detail: string) => f.push({ id, severity, title, detail });

  // ---- market
  if (!m.pools) add("no-pool", "high", "No trading pool found", "No DEX pool with this token on Ethereum or Base: it can't be traded normally, or the address is wrong.");
  else {
    if (m.liquidityUsd < 10_000) add("liquidity", "high", "Very low liquidity", `Only ${usd(m.liquidityUsd)} in the pools: a few sells can crash the price, and getting out can be hard.`);
    else if (m.liquidityUsd < 50_000) add("liquidity", "medium", "Low liquidity", `${usd(m.liquidityUsd)} in the pools: large trades move the price a lot.`);
    else add("liquidity", "good", "Healthy liquidity", `${usd(m.liquidityUsd)} in ${m.pools} pool${m.pools > 1 ? "s" : ""}.`);
    const age = m.poolCreatedAt ? (now - m.poolCreatedAt) / DAY : null;
    if (age !== null && age < 1) add("age", "high", "Brand-new pool", `The pool is ${Math.max(1, Math.round(age * 24))} hours old: most rug pulls happen in the first days.`);
    else if (age !== null && age < 7) add("age", "medium", "Young pool", `The pool is ${Math.round(age)} days old.`);
    else if (age !== null && age > 180) add("age", "good", "Established pool", `Trading for ${Math.round(age / 30)} months.`);
    if (m.buys24h >= 30 && m.sells24h === 0) add("no-sells", "high", "Nobody sold in 24 hours", `${m.buys24h} buys and 0 sells: a classic sign that selling may be blocked (honeypot).`);
    else if (m.buys24h >= 30 && m.sells24h / m.buys24h < 0.1) add("few-sells", "medium", "Almost no sells", `${m.buys24h} buys vs ${m.sells24h} sells in 24 hours: check that selling really works before buying.`);
  }

  // ---- contract
  if (c) {
    if (!c.verified) add("unverified", "high", "Source code not published", "The contract's code is not verified: nobody can check what it really does.");
    else add("verified", "good", "Source code published", `Verified contract${c.contractName ? ` (${c.contractName})` : ""}.`);
    if (c.proxy) add("proxy", c.proxy.admin ? "high" : "medium", "Upgradeable contract", `It is a proxy${c.proxy.type ? ` (${c.proxy.type})` : ""}: ${c.proxy.admin ? "an admin" : "whoever controls the upgrade"} can replace the code at any time, including the rules for selling.`);
    const powers = POWERS.filter(p => c.abiFunctions.some(fn => p.re.test(fn)));
    const ownerLive = !!c.owner;
    if (c.ownerKnown && !ownerLive) add("renounced", "good", "Ownership renounced", "The owner role was given up: owner-only functions can no longer be used.");
    for (const p of powers) {
      if (c.ownerKnown && !ownerLive) continue;                              // renounced: those powers are dead
      add(`power-${p.id}`, p.severity, `The owner can ${p.what}`, `${c.abiFunctions.filter(fn => p.re.test(fn)).slice(0, 3).join(", ")}()${ownerLive ? ` · owner ${c.owner}` : ""}.`);
    }
    if (ownerLive && !powers.length) add("owner", "low", "Owner still active", `The owner (${c.owner}) can still call owner-only functions.`);
    if (c.source) {
      if (/\bselfdestruct\s*\(/.test(c.source)) add("selfdestruct", "high", "Can self-destruct", "The code contains selfdestruct.");
      if (/\bdelegatecall\b/.test(c.source) && !c.proxy) add("delegatecall", "medium", "Runs external code", "The code uses delegatecall: it can execute logic from another contract.");
    }
    // ---- holders
    const burn = /^0x0{40}$|^0x0{36}dead$|^0x000000000000000000000000000000000000dead$/i;
    const pool = m.mainPool?.toLowerCase();
    const people = c.topHolders.filter(h => !burn.test(h.address) && h.address !== pool && !(h.isContract && /pool|pair|uniswap|lp|router|lock|vesting|team finance|unicrypt/i.test(h.name ?? "")));
    const top10 = people.slice(0, 10).reduce((s, h) => s + h.share, 0);
    if (c.topHolders.length) {
      if (top10 > 0.5) add("concentration", "high", "Supply concentrated in few wallets", `The top 10 wallets (pools and burn excluded) hold ${pct(top10)} of the supply: they can dump on everyone else.`);
      else if (top10 > 0.25) add("concentration", "medium", "Supply fairly concentrated", `The top 10 wallets hold ${pct(top10)} of the supply.`);
      else add("concentration", "good", "Well distributed", `The top 10 wallets hold ${pct(top10)} of the supply.`);
    }
    if (c.creatorShare !== null && c.creatorShare > 0.05) add("creator", c.creatorShare > 0.15 ? "high" : "medium", "Creator still holds a big bag", `The deployer wallet holds ${pct(c.creatorShare)} of the supply.`);
    if (c.holdersCount !== null) {
      if (c.holdersCount < 100) add("holders", "high", "Very few holders", `${c.holdersCount} holders.`);
      else if (c.holdersCount < 1000) add("holders", "medium", "Few holders", `${c.holdersCount.toLocaleString("en-US")} holders.`);
    }
  } else add("no-contract", "medium", "Contract data not available", "The block explorer did not answer: contract checks are missing from this report.");

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, good: 3 };
  f.sort((a, b) => order[a.severity] - order[b.severity]);
  let score = Math.max(0, 100 - f.reduce((s, x) => s + PENALTY[x.severity], 0));
  if (!m.pools) score = Math.min(score, 30);                                // not tradable: never "low risk", whatever else looks fine
  if (c && !c.symbol && c.holdersCount === null) { f.unshift({ id: "not-token", severity: "high", title: "Not a known token", detail: "The explorer has no token data for this address: it may be a wallet or a plain contract." }); score = Math.min(score, 30); }
  return { score, risk: score >= 75 ? "low" : score >= 50 ? "medium" : score >= 25 ? "high" : "very high", flags: f };
}

/** the parts of the source that decide who can do what: owner-only and fee/blacklist/mint/transfer functions (for the code reviewer) */
export function keyCode(source: string, max = 5800): string {
  const fns = source.match(/function\s+\w+\s*\([^)]*\)[^{;]*\{/g) ?? [];
  const pick: string[] = [];
  for (const head of fns) {
    if (!/onlyOwner|onlyRole|owner|_transfer|fee|tax|blacklist|bot|mint|trading|pause|max/i.test(head)) continue;
    const i = source.indexOf(head); let depth = 0, j = i + head.length - 1;
    for (; j < source.length; j++) { if (source[j] === "{") depth++; else if (source[j] === "}" && --depth === 0) break; }
    pick.push(source.slice(i, j + 1));
    if (pick.join("\n\n").length > max) break;
  }
  const body = (pick.length ? pick.join("\n\n") : source).slice(0, max);
  return `// key functions of the token contract (Sentinel extract)\n${body}`;
}

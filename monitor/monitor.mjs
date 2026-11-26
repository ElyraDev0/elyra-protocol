// ELYRA MONITOR + GUARDIAN — watches the contracts and sends alerts to Telegram.
// GUARDIAN: with GUARDIAN_PRIVATE_KEY set (a separate wallet with a little ETH for gas, registered with
// guard.setGuardian), it can switch the PAUSE ON by itself when something that should NEVER happen happens.
// It pauses ONLY for things that are impossible when the code works: the contracts hold less than they owe
// (escrow, credits, bonds) or a single payment bigger than the per-job cap. Everything else is just an alert.
// It can never un-pause, move funds or change parameters. GUARDIAN_MODE=watch (default) only tells you
// "here I would have paused": use it for the first weeks to tune the thresholds, then set GUARDIAN_MODE=act.
// Run:  cd monitor && npm install && node monitor.mjs        (keep the window open, or run it on a small server)
// Reads ../.env  (see README.md → "Monitor and guardian")
//
// What it checks every minute:
//  1. SOLVENCY — the escrow and credit contracts hold at least what they owe (token balance ≥ lockedOf). If not: 🔴 alert.
//  2. BONDS    — the bond contract holds at least the sum of all bonds (rebuilt from events).            If not: 🔴 alert.
//  3. EVENTS   — pause switched, ownership or parameters changed, disputes, bond penalties:               🟡 alert.
//  4. FAILURES — failed transactions to the Elyra contracts in the last hour (Etherscan), above a threshold: 🟡 alert.
//  5. HEARTBEAT — once a day a short summary, so you know the monitor is alive.
import { config } from "dotenv";
import { createPublicClient, createWalletClient, http, parseAbiItem, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
config({ path: "../.env" });

const E = process.env;
const need = ["SEPOLIA_RPC_URL", "ALERT_BOT_TOKEN", "ALERT_CHAT_ID", "JOB_ESCROW", "AGENT_BOND", "CREDIT_METER", "ELYRA_GUARD", "TEST_ELY", "TEST_USDC", "DEPLOY_BLOCK"];
const missing = need.filter(k => !E[k]);
if (missing.length) { console.log("Missing in ../.env:", missing.join(", ")); process.exit(1); }

const pub = createPublicClient({ chain: sepolia, transport: http(E.SEPOLIA_RPC_URL) });
const A = { escrow: E.JOB_ESCROW, bond: E.AGENT_BOND, meter: E.CREDIT_METER, guard: E.ELYRA_GUARD, ely: E.TEST_ELY, usdc: E.TEST_USDC };
const FAIL_THRESHOLD = Number(E.FAIL_ALERT_PER_HOUR || 10);
const CHUNK = BigInt(E.LOG_CHUNK || 500); // blocks per log request (free RPC plans limit this)
const EVERY_MS = 1000 * Number(E.CHECK_EVERY_SECONDS || 20);

// ---- guardian thresholds (all in .env, see README) ----
const G = {
  mode: (E.GUARDIAN_MODE || "watch").toLowerCase(),               // watch | act
  outflowPct: Number(E.ALERT_OUTFLOW_PCT || 20),                   // 🟡 more than X% of the escrow leaves …
  outflowMin: Number(E.ALERT_OUTFLOW_MINUTES || 10),               //    … within Y minutes
  outflowFloor: Number(E.ALERT_OUTFLOW_MIN_USDC || 200),           //    ignore small amounts (early days)
  disputesHour: Number(E.ALERT_DISPUTES_PER_HOUR || 10),           // 🟡 alert only
  jobsHour: Number(E.ALERT_JOBS_PER_HOUR || 200),                  // 🟡 alert only
};
const guardianAccount = E.GUARDIAN_PRIVATE_KEY ? privateKeyToAccount(E.GUARDIAN_PRIVATE_KEY.startsWith("0x") ? E.GUARDIAN_PRIVATE_KEY : `0x${E.GUARDIAN_PRIVATE_KEY}`) : null;
const wallet = guardianAccount ? createWalletClient({ account: guardianAccount, chain: sepolia, transport: http(E.SEPOLIA_RPC_URL) }) : null;
const pauseAbi = [{ type: "function", name: "guardianPause", stateMutability: "nonpayable", inputs: [], outputs: [] }];
const capAbi = [{ type: "function", name: "jobCap", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const suspicion = new Map();   // rule -> first time seen (double confirmation)
const near = {};               // rule -> highest value seen today, for the daily report
let paused = false;

/** a rule that should never trigger in normal life: confirmed on two checks in a row, then pause (or, in watch mode, tell) */
async function redFlag(rule, text) {
  const first = suspicion.get(rule);
  if (!first) { suspicion.set(rule, Date.now()); await alertOnce("pre-" + rule, `🟠 Possible problem (checking again): ${text}`, 15 * 60 * 1000); return; }
  if (paused) return;
  if (G.mode !== "act" || !wallet) {
    await alertOnce("would-" + rule, `🔴 ${text}\n👉 In ACT mode I would have PAUSED the protocol now. (GUARDIAN_MODE=${G.mode}${wallet ? "" : ", no guardian key"})`, 30 * 60 * 1000);
    return;
  }
  try {
    const hash = await wallet.writeContract({ address: A.guard, abi: pauseAbi, functionName: "guardianPause" });
    paused = true;
    await tg(`🛑 PROTOCOL PAUSED BY THE GUARDIAN\nReason: ${text}\n${scan(hash)}\nNew jobs and deposits are stopped. Withdrawals and refunds keep working.\nCheck calmly, then un-pause from the project wallet (setPaused(false)) or send me this message.`);
  } catch (e) {
    await alertOnce("pause-fail", `🔴 ${text}\n⚠️ I tried to pause but the transaction failed (${e.shortMessage || e.message}). Pause it yourself from the project wallet NOW.`, 10 * 60 * 1000);
  }
}
function clearFlag(rule) { suspicion.delete(rule); }
function track(rule, v) { near[rule] = Math.max(near[rule] ?? 0, v); }
const balHistory = [];          // [time, escrow balance]
let releasedThisTick = [];

const erc20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const locked = [{ type: "function", name: "lockedOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const guardAbi = [{ type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }];
const EV = {
  bonded: parseAbiItem("event Bonded(uint256 indexed agentId, address indexed from, uint256 amount, uint256 total)"),
  withdrawn: parseAbiItem("event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount)"),
  slashed: parseAbiItem("event Slashed(uint256 indexed agentId, address indexed to, uint256 amount)"),
  paused: parseAbiItem("event Paused(bool paused)"),
  owner: parseAbiItem("event OwnershipTransferred(address indexed from, address indexed to)"),
  params: parseAbiItem("event Params(address resolver, address feeRecipient, uint16 feeBps, uint256 minBond, uint256 maxBondPerAgent, uint256 maxSlashPerJob)"),
  caps: parseAbiItem("event TokenCaps(address indexed token, uint256 jobCap, uint256 totalCap, uint256 walletCap)"),
  scheduled: parseAbiItem("event ChangeScheduled(bytes32 indexed id, bytes data, uint64 executableAt)"),
  executed: parseAbiItem("event ChangeExecuted(bytes32 indexed id)"),
  disputed: parseAbiItem("event JobDisputed(uint256 indexed id)"),
  opened: parseAbiItem("event JobOpened(uint256 indexed id, uint256 indexed agentId, address indexed client, address token, uint256 amount, uint64 deadline)"),
  released: parseAbiItem("event JobReleased(uint256 indexed id, uint256 toAgent, uint256 fee)"),
  guardianPaused: parseAbiItem("event GuardianPaused(address by)"),
};

async function tg(text) {
  console.log(new Date().toISOString(), text.replace(/\n/g, " | "));
  try {
    await fetch(`https://api.telegram.org/bot${E.ALERT_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: E.ALERT_CHAT_ID, text, disable_web_page_preview: true }) });
  } catch (e) { console.log("Telegram error:", e.message); }
}
const scan = (h) => `https://sepolia.etherscan.io/tx/${h}`;
const once = new Map(); // avoid repeating the same alert every minute
async function alertOnce(key, text, everyMs = 60 * 60 * 1000) {
  const t = once.get(key) ?? 0; if (Date.now() - t < everyMs) return; once.set(key, Date.now()); await tg(text);
}

const hourly = { disputes: [], jobs: [] };
let from = BigInt(E.DEPLOY_BLOCK), bondSum = 0n, jobsToday = 0, disputesToday = 0, history = true; // first pass: rebuild totals silently
async function logs(event, address, a, b) {
  const out = [];
  for (let s = a; s <= b; s += CHUNK) out.push(...await pub.getLogs({ address, event, fromBlock: s, toBlock: s + CHUNK - 1n > b ? b : s + CHUNK - 1n }));
  return out;
}

async function tick() {
  const head = await pub.getBlockNumber();
  if (head >= from) {
    // events since last tick
    const [b, w, sl, pa, ow, pr, cp, di, op, rel, sc, ex] = await Promise.all([
      logs(EV.bonded, A.bond, from, head), logs(EV.withdrawn, A.bond, from, head), logs(EV.slashed, A.bond, from, head),
      logs(EV.paused, A.guard, from, head), logs(EV.owner, A.guard, from, head), logs(EV.params, A.guard, from, head), logs(EV.caps, A.guard, from, head),
      logs(EV.disputed, A.escrow, from, head), logs(EV.opened, A.escrow, from, head), logs(EV.released, A.escrow, from, head),
      logs(EV.scheduled, A.guard, from, head), logs(EV.executed, A.guard, from, head),
    ]);
    if (!history) for (const l of rel) releasedThisTick.push({ id: l.args.id, amount: l.args.toAgent + l.args.fee });
    const now = Date.now();
    if (!history) { for (const _ of di) hourly.disputes.push(now); for (const _ of op) hourly.jobs.push(now); }
    for (const k of ["disputes", "jobs"]) hourly[k] = hourly[k].filter(t => now - t < 3600_000);
    track("disputes/hour", hourly.disputes.length); track("jobs/hour", hourly.jobs.length);
    if (hourly.disputes.length >= G.disputesHour) await alertOnce("disp-h", `🟡 ${hourly.disputes.length} disputes in the last hour (alert at ${G.disputesHour}). Not paused: have a look.`);
    if (hourly.jobs.length >= G.jobsHour) await alertOnce("jobs-h", `🟡 ${hourly.jobs.length} jobs in the last hour (alert at ${G.jobsHour}). Probably good news — just checking.`);
    for (const l of b) bondSum += l.args.amount;
    for (const l of w) bondSum -= l.args.amount;
    for (const l of sl) { bondSum -= l.args.amount; if (!history) await tg(`🟡 Bond penalty: agent #${l.args.agentId} lost ${formatUnits(l.args.amount, 18)} tELY\n${scan(l.transactionHash)}`); }
    for (const l of pa) if (!history) await tg(`🟡 Protocol ${l.args.paused ? "PAUSED" : "un-paused"}\n${scan(l.transactionHash)}`);
    for (const l of ow) if (!history) await tg(`🟡 Guard ownership changed → ${l.args.to}\n${scan(l.transactionHash)}`);
    // timelock: every parameter change is announced first. An announcement you did not make = the owner key is compromised.
    for (const l of sc) if (!history) await tg(`🟠 Parameter change ANNOUNCED (timelock), executable from ${new Date(Number(l.args.executableAt) * 1000).toISOString()}\nIf you did not schedule it: cancel it from the project wallet (cancel(${l.args.id})) and pause.\n${scan(l.transactionHash)}`);
    for (const l of ex) if (!history) await tg(`🟡 Timelocked change executed\n${scan(l.transactionHash)}`);
    for (const l of [...pr, ...cp]) if (!history) await tg(`🟡 Guard parameters changed\n${scan(l.transactionHash)}`);
    for (const l of di) disputesToday++;   // disputes close by themselves (concede / withdraw / 30-day timeout): no alert each time
    if (!history) jobsToday += op.length;
    from = head + 1n;
    history = false;
  }

  // solvency: the contracts must hold at least what they owe
  for (const [name, addr] of [["JobEscrow", A.escrow], ["CreditMeter", A.meter]]) {
    const [bal, owe] = await Promise.all([
      pub.readContract({ address: A.usdc, abi: erc20, functionName: "balanceOf", args: [addr] }),
      pub.readContract({ address: addr, abi: locked, functionName: "lockedOf", args: [A.usdc] }),
    ]);
    if (bal < owe) await redFlag("solv-" + name, `SOLVENCY: ${name} holds ${formatUnits(bal, 6)} tUSDC but owes ${formatUnits(owe, 6)}.`);
    else clearFlag("solv-" + name);
    if (name === "JobEscrow") {
      // outflow: how much left the escrow in the last N minutes
      const now = Date.now();
      balHistory.push([now, bal]);
      while (balHistory.length && now - balHistory[0][0] > G.outflowMin * 60_000) balHistory.shift();
      const peak = balHistory.reduce((m, [, b]) => (b > m ? b : m), 0n);
      const drop = peak - bal;
      const pct = peak > 0n ? Number((drop * 10_000n) / peak) / 100 : 0;
      track("outflow %", pct);
      if (pct > G.outflowPct && Number(formatUnits(drop, 6)) >= G.outflowFloor)
        await alertOnce("outflow", `🟡 ${pct.toFixed(1)}% of the escrow (${formatUnits(drop, 6)} tUSDC) left in ${G.outflowMin} minutes. The books still balance, so I did NOT pause (it may be many jobs closing together). Have a look.`, 30 * 60 * 1000);
    }
  }
  // a single payment bigger than the per-job cap is impossible if the code is right
  const cap = await pub.readContract({ address: A.guard, abi: capAbi, functionName: "jobCap", args: [A.usdc] });
  for (const r of releasedThisTick) if (cap > 0n && r.amount > cap) await redFlag("bigpay", `Job #${r.id} paid ${formatUnits(r.amount, 6)} tUSDC, more than the per-job cap ${formatUnits(cap, 6)}.`);
  if (!releasedThisTick.some(r => cap > 0n && r.amount > cap)) clearFlag("bigpay");
  releasedThisTick = [];
  const bondBal = await pub.readContract({ address: A.ely, abi: erc20, functionName: "balanceOf", args: [A.bond] });
  if (bondBal < bondSum) await redFlag("solv-bond", `BONDS: AgentBond holds ${formatUnits(bondBal, 18)} tELY but bonds add up to ${formatUnits(bondSum, 18)}.`);
  else clearFlag("solv-bond");

  // failed transactions in the last hour (Etherscan V2, optional)
  if (E.ETHERSCAN_API_KEY) {
    let failed = 0; const since = Math.floor(Date.now() / 1000) - 3600; const examples = [];
    for (const addr of [A.escrow, A.bond, A.meter, A.guard]) {
      try {
        const r = await (await fetch(`https://api.etherscan.io/v2/api?chainid=11155111&module=account&action=txlist&address=${addr}&sort=desc&page=1&offset=100&apikey=${E.ETHERSCAN_API_KEY}`)).json();
        for (const t of Array.isArray(r.result) ? r.result : []) if (Number(t.timeStamp) >= since && t.isError === "1") { failed++; if (examples.length < 3) examples.push(scan(t.hash)); }
      } catch { /* Etherscan busy: try next minute */ }
    }
    if (failed >= FAIL_THRESHOLD) await alertOnce("fails", `🟡 ${failed} failed transactions to the Elyra contracts in the last hour. Examples:\n${examples.join("\n")}\nSend me these links.`);
  }

  paused = await pub.readContract({ address: A.guard, abi: guardAbi, functionName: "paused" });
  return { head, paused };
}

let lastBeat = 0;
await tg(`🟢 Elyra monitor started · guardian ${wallet ? `${guardianAccount.address} · mode ${G.mode.toUpperCase()}` : "OFF (alerts only)"}.`);
for (;;) {
  try {
    const { head, paused } = await tick();
    if (Date.now() - lastBeat > 24 * 3600 * 1000) {
      lastBeat = Date.now();
      const closest = Object.entries(near).map(([k, v]) => `${k}: max ${typeof v === "number" ? v.toFixed(1) : v}`).join(" · ") || "—";
      await tg(`🟢 Daily check · block ${head} · ${paused ? "PAUSED" : "running"} · guardian ${G.mode}\nJobs opened in 24h: ${jobsToday} · disputes: ${disputesToday} · tELY in bonds: ${formatUnits(bondSum, 18)}\nHow close we got to the thresholds today: ${closest} (outflow alert at ${G.outflowPct}%)`);
      jobsToday = 0; disputesToday = 0; for (const k of Object.keys(near)) delete near[k];
    }
  } catch (e) { await alertOnce("rpc", `⚪ Monitor can't reach Sepolia right now (${e.shortMessage || e.message}). It keeps retrying.`, 3 * 3600 * 1000); }
  await new Promise(r => setTimeout(r, EVERY_MS));
}

// END-TO-END (local): anvil + Elyra contracts + ElyraCourt + TeeBadgeRegistry + the judge in SIMULATED TEE mode +
// a stand-in for the Confidential AI API. Proves: evidence is hash-checked, statements are signature-checked, the
// verdict signed by the judge key executes on-chain through ElyraCourt, and a TEE badge is issued and stored.
// Usage: node test/e2e.mjs   (needs: anvil, forge, cast on PATH or FOUNDRY_BIN; the judge built with `npm run build`)
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rmSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url)), judgeDir = path.resolve(here, ".."), repo = path.resolve(judgeDir, "../..");
const FB = process.env.FOUNDRY_BIN ? process.env.FOUNDRY_BIN + "/" : "";
const FORGE_ROOT = process.env.FORGE_ROOT ?? repo;       // a foundry project containing src/ phala/ lib/
const RPC = "http://127.0.0.1:8547", DATA = "/tmp/elyra-judge-e2e";
const KEYS = { deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", agent: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", client: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" };
const TASK = "Check the token 0x6982508145454Ce325dDbE47a25d4ec3d2311933 and give a 0-100 safety score with reasons.";
const RESULT = "lol";                                       // an empty delivery: the client should win
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };

const sdk = await import(path.join(judgeDir, "dist/sdk/src/eth.js"));
const eip = await import(path.join(judgeDir, "dist/phala/judge/src/eip712.js"));
const tee = await import(path.join(judgeDir, "dist/phala/judge/src/tee.js"));
const procs = [];
process.on("exit", () => procs.forEach(p => { try { p.kill(); } catch {} }));

// 1. chain
procs.push(spawn(FB + "anvil", ["--port", "8547", "--silent"], { stdio: "ignore" }));
await sleep(1500);

// 2. judge address (deterministic in sim mode), then contracts + a disputed job
rmSync(DATA, { recursive: true, force: true });
const baseEnv = { ...process.env, TEE_MODE: "sim", SIM_SEED: "e2e-judge", RPC_URL: RPC, CHAIN_ID: "31337", DATA_DIR: DATA,
  ESCROW: "0x" + "0".repeat(40), COURT: "0x" + "0".repeat(40), REGISTRY: "0x" + "0".repeat(40) };
const judge = execFileSync("node", ["dist/phala/judge/src/main.js", "--print-address"], { cwd: judgeDir, env: baseEnv }).toString().trim();
ok(/^0x[0-9a-f]{40}$/.test(judge), `judge key derived in the (simulated) TEE: ${judge}`);
const out = execFileSync(FB + "forge", ["script", "phala/script/DeployPhalaDemo.s.sol:DeployPhalaDemo", "--rpc-url", RPC, "--broadcast", "--offline", "--slow"], {
  cwd: FORGE_ROOT, env: { ...process.env, JUDGE: judge, DEPLOYER_KEY: KEYS.deployer, AGENT_KEY: KEYS.agent, CLIENT_KEY: KEYS.client, TASK_TEXT: TASK, RESULT_TEXT: RESULT } }).toString();
const A = Object.fromEntries([...out.matchAll(/^\s+([A-Z_]+) (0x[0-9a-fA-F]{40}|\d+)$/gm)].map(m => [m[1], m[2]]));
ok(A.COURT && A.JOB_ID, `deployed: court ${A.COURT}, disputed job #${A.JOB_ID}`);
const cast = (...a) => execFileSync(FB + "cast", [...a, "--rpc-url", RPC]).toString().trim();

// 3. stand-in for Phala Confidential AI: two models, both find the delivery empty
let sawEvidence = false;
const ai = createServer((req, res) => { let b = ""; req.on("data", c => b += c); req.on("end", () => {
  const j = JSON.parse(b), user = j.messages[1].content;
  sawEvidence ||= user.includes(TASK) && user.includes("The token analysis tool was down");
  const bps = j.model === "model-a" ? 9000 : 8500;
  res.end(JSON.stringify({ id: `rcpt-${j.model}-${Date.now()}`, choices: [{ message: { content: JSON.stringify({ side: "client", clientBps: bps, slash: true, reasons: ["The result does not answer the task"] }) } }] }));
}); }).listen(8798);

// 4. the judge
const judgeProc = spawn("node", ["dist/phala/judge/src/main.js"], { cwd: judgeDir, env: { ...baseEnv, ESCROW: A.ESCROW, COURT: A.COURT, BADGES: A.BADGES, REGISTRY: A.REGISTRY,
  PORT: "8799", POLL_SEC: "3", STATEMENTS_MIN: "0.25", SLASH_CAP_WEI: String(50n * 10n ** 18n), AI_BASE_URL: "http://127.0.0.1:8798", JUDGE_MODEL_A: "model-a", JUDGE_MODEL_B: "model-b" } });
procs.push(judgeProc); judgeProc.stdout.on("data", d => process.stdout.write("     " + d)); judgeProc.stderr.on("data", d => process.stdout.write("     " + d));
await sleep(2500);
const J = "http://127.0.0.1:8799", post = (p, body) => fetch(J + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const info = await fetch(J + "/info").then(r => r.json());
ok(info.active && info.judge === judge, "judge is the court's judge on-chain, /info answers");
const att = await fetch(J + "/attestation").then(r => r.json());
ok(att.reportData === eip.hex32(eip.judgeReportData(31337, A.COURT.toLowerCase(), judge)) && att.simulated === true, "attestation binds the judge key to the court (simulated quote, flagged as such)");

// 5. evidence + statements (inside the window)
ok((await post("/evidence", { jobId: A.JOB_ID, kind: "result", text: "a forged result" })).status === 400, "forged result text rejected (hash mismatch)");
ok((await post("/evidence", { jobId: A.JOB_ID, kind: "task", text: TASK })).ok, "task text accepted (matches specHash)");
ok((await post("/evidence", { jobId: A.JOB_ID, kind: "result", text: RESULT })).ok, "result text accepted (matches resultHash)");
const text = "The token analysis tool was down, the agent sent one word.";
const { message } = await post("/statement-message", { jobId: A.JOB_ID, side: "client", text });
ok((await post("/statement", { jobId: A.JOB_ID, side: "client", text, signature: sdk.signMessage(sdk.account(KEYS.agent), message) })).status === 400, "statement signed by the wrong wallet rejected");
ok((await post("/statement", { jobId: A.JOB_ID, side: "client", text, signature: sdk.signMessage(sdk.account(KEYS.client), message) })).ok, "client statement accepted (EIP-191 signature)");

// 6. ruling executed on-chain
let st = "";
for (let i = 0; i < 40 && st !== "6"; i++) { await sleep(1500); st = cast("call", A.ESCROW, "jobs(uint256)(uint256,address,address,uint256,uint64,uint64,uint64,uint16,uint8,bytes32,bytes32,uint256)", A.JOB_ID).split("\n")[8]; }
ok(st === "6", "job resolved on-chain by ElyraCourt");
ok(sawEvidence, "the models received the hash-checked evidence and the signed statement");
let v = {};
for (let i = 0; i < 20 && !v.tx; i++) { v = await fetch(J + `/verdict/${A.JOB_ID}`).then(r => r.json()); if (!v.tx) await sleep(500); }
ok(v.verdict.clientBps === 8500 && v.tx, `verdict: client gets ${v.verdict.clientBps / 100}% (the lower of the two rulings), tx ${v.tx.slice(0, 12)}…`);
const onchainDigest = cast("call", A.COURT, "verdictDigest((uint256,uint16,uint256,bytes32,bytes32,bytes32,bytes32,uint64,uint64))(bytes32)",
  `(${v.verdict.jobId},${v.verdict.clientBps},${v.verdict.slashAmount},${v.verdict.evidenceRoot},${v.verdict.promptHash},${v.verdict.modelsHash},${v.verdict.receiptsHash},${v.verdict.issuedAt},${v.verdict.expiresAt})`);
ok(onchainDigest === v.digest, "EIP-712 digest computed in the judge equals the contract's");
const bond = cast("call", A.BOND, "bondOf(uint256)(uint256)", A.AGENT_ID).split(" ")[0];
ok(bond === "950000000000000000000", "agent bond slashed by the capped amount (50 ELY)");

// 7. TEE badge for an external agent (simulated CVM)
const agentTee = tee.simTee("some-agent-cvm", JSON.stringify({ services: { agent: { image: "ghcr.io/example/agent@sha256:" + "a".repeat(64) } } }));
const wallet = sdk.account(KEYS.agent).address;
const aq = await agentTee.getQuote(eip.agentReportData(31337, A.REGISTRY.toLowerCase(), BigInt(A.AGENT_ID), wallet));
const appCompose = JSON.stringify({ services: { agent: { image: "ghcr.io/example/agent@sha256:" + "a".repeat(64) } } });
const bm = (await post("/badge-message", { agentId: A.AGENT_ID, wallet, quote: aq.quote })).message;
const wrongCompose = await post("/badge", { agentId: A.AGENT_ID, wallet, quote: aq.quote, eventLog: aq.eventLog, appCompose: appCompose + " ", signature: sdk.signMessage(sdk.account(KEYS.agent), bm) });
ok(wrongCompose.status === 400, "badge refused when app-compose.json does not match the attested hash");
const badge = await post("/badge", { agentId: A.AGENT_ID, wallet, quote: aq.quote, eventLog: aq.eventLog, appCompose, signature: sdk.signMessage(sdk.account(KEYS.agent), bm) });
if (!badge.tx) console.log(JSON.stringify(badge)); ok(badge.tx, `badge issued by the judge and stored on-chain (level ${badge.badge?.level})`);
const level = cast("call", A.BADGES, "badgeOf(uint256)(uint8,bytes32,uint64)", A.AGENT_ID).split("\n")[0];
ok(level === "2", "TeeBadgeRegistry: level 2 (TEE + images pinned by digest)");
console.log("\nALL GOOD");
process.exit(0);

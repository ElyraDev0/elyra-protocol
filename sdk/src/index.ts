/*
 * Elyra Agent SDK (developer kit v0.3) — connect your own AI agent to the Elyra market.
 *
 *   const agent = new ElyraAgent({ network: "sepolia", privateKey: process.env.AGENT_KEY!, agentId: 42 });
 *   agent.onTask(async task => myModel(task.task));   // return the result text
 *   await agent.poll();                                 // or mount agent.webhook() on your HTTPS server
 *
 * Your agent keeps its own models, data and tools. Elyra adds escrow, proof of delivery, reputation and a court.
 * No dependencies: Node 18+ (built-in fetch). The private key never leaves your machine.
 */
import { account, call, encodeCall, hashText, recoverAddress, rpc, sendTx, signMessage, topic, waitReceipt, words, type Account } from "./eth.js";
import { keccak256, toHex } from "./crypto.js";

export type Network = "sepolia" | "orbinum";
export const NETWORKS: Record<Network, { chainId: number; rpc: string; registry: string; escrow: string; bond: string; tEly: string; tUsdc: string; explorer: string }> = {
  sepolia: {
    chainId: 11155111, rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io",
    registry: "0xc7Cfc9d616804EAA354e41c1bb73d5A45e0EC724", escrow: "0xcC6a402a4591136Fb069Cf01eb9BfEf831ce7a73", bond: "0x72114FC3a78Ff26981D9b65126e257B006359E29",
    tEly: "0xdebD4aeA243876aB9B79CEf0bc688Be51209a473", tUsdc: "0xc1996A07435383B48740bd6C32af9322f8667541",
  },
  orbinum: {
    chainId: 2700, rpc: "https://rpc-1.testnet.orbinum.io", explorer: "https://explorer.testnet.orbinum.network/evm",
    registry: "0xc7Cfc9d616804EAA354e41c1bb73d5A45e0EC724", escrow: "0xcC6a402a4591136Fb069Cf01eb9BfEf831ce7a73", bond: "0x72114FC3a78Ff26981D9b65126e257B006359E29",
    tEly: "0xdebD4aeA243876aB9B79CEf0bc688Be51209a473", tUsdc: "0xc1996A07435383B48740bd6C32af9322f8667541",
  },
};

/** the task formats of the market: a skill's fields (in order) and their maximum length. "open" = free text { task }. */
export const SKILLS = {
  token: ["address:42"], contract: ["address:42"], wallet: ["address:42"], approvals: ["address:42"], safe: ["address:42"], nft: ["address:42"],
  ens: ["query:80"], gas: ["plan:200"], txdecode: ["txhash:66"], kol: ["handle:30"], code: ["code:6000"], testwriter: ["code:6000"], gasopt: ["code:6000"],
  tokenomics: ["text:3000"], governance: ["text:6000"], auditread: ["text:6000"], faq: ["text:6000"], announce: ["brief:1500"], explain: ["question:600"],
  summarize: ["text:6000"], writer: ["topic:500"], translate: ["lang:30", "text:3000"],
} as const;
export type Skill = keyof typeof SKILLS;

/** the exact text whose keccak256 is the job's specHash on-chain */
export function taskText(skill: Skill | null, values: Record<string, string>): string {
  if (!skill) return String(values.task ?? "").trim().slice(0, 2000);
  return JSON.stringify({ agent: skill, ...Object.fromEntries(SKILLS[skill].map(f => { const [k, max] = f.split(":"); return [k, String(values[k] ?? "").trim().slice(0, Number(max))]; })) });
}

/** a paid job, as the Elyra relay sends it (pushed to your endpoint or read by polling) */
export type Task = {
  version: 1; network: string; chainId: number; escrow: string; jobId: number; agentId: number; client: string;
  amount: number; deadline: number; skill: Skill | null; values: Record<string, string>; task: string; specHash: string; sentAt: number;
};
/** returns the result text; or null when the work goes on (e.g. a live job): deliver it later with deliver(task, text) */
export type Handler = (task: Task) => Promise<string | null>;
/** an agent as the market lists it (GET /api/market/agents) */
export type MarketAgent = {
  id: number; name: string; owner: string; active: boolean; completed: number; refunded: number; disputesLost: number; earned: number; bond: number;
  skill: Skill | "custom" | null; managed: "elyra" | "user" | "ext" | null; price: number | null; ext?: { skills: Skill[]; endpoint: boolean } | null;
};

const MSG = {
  connect: (id: number, chainId: number, c: { endpoint: string | null; skills: string[]; price: number }, ts: number) =>
    `Elyra relay · connect agent #${id} on chain ${chainId}\nendpoint: ${c.endpoint ?? "none (polling)"}\nskills: ${c.skills.length ? c.skills.join(",") : "open"}\nprice: ${c.price} tUSDC\nts: ${ts}`,
  poll: (id: number, chainId: number, ts: number) => `Elyra relay · tasks for agent #${id} on chain ${chainId}\nts: ${ts}`,
  result: (jobId: number, chainId: number, h: string, ts: number) => `Elyra relay · result for job #${jobId} on chain ${chainId}\nhash: ${h.toLowerCase()}\nts: ${ts}`,
  progress: (jobId: number, chainId: number, h: string, ts: number) => `Elyra relay · progress for job #${jobId} on chain ${chainId}\nhash: ${h.toLowerCase()}\nts: ${ts}`,
  relay: (body: string) => `Elyra relay · task\n0x${toHex(keccak256(new TextEncoder().encode(body)))}`,
};
const E6 = 1_000_000n, E18 = 10n ** 18n;
const units6 = (x: number) => BigInt(Math.round(x * 1e6));

export class ElyraAgent {
  readonly net: (typeof NETWORKS)[Network];
  readonly me: Account;
  readonly relayUrl: string;
  agentId: number | null;
  private handler: Handler | null = null;
  private busy = new Set<number>();
  private later = new Set<number>();                           // jobs the handler took on and will deliver later (live jobs)
  private unstarted = new Map<number, number>();               // hired jobs that never started → refund after their deadline
  private relayAddress: string | null = null;
  log: (msg: string) => void = m => console.log(`[elyra] ${m}`);

  constructor(o: { network?: Network; privateKey: string; agentId?: number; relayUrl?: string; rpcUrl?: string; contracts?: Partial<(typeof NETWORKS)[Network]> }) {
    const base = NETWORKS[o.network ?? "sepolia"];
    this.net = { ...base, ...(o.contracts ?? {}), rpc: o.rpcUrl ?? o.contracts?.rpc ?? base.rpc };
    this.me = account(o.privateKey);
    this.agentId = o.agentId ?? null;
    this.relayUrl = (o.relayUrl ?? "https://elyraprotocol.com").replace(/\/$/, "");
  }
  get address() { return this.me.address; }
  private get netName() { return this.net.chainId === 2700 ? "orbinum" : "sepolia"; }
  private async relay<T>(body: Record<string, unknown>): Promise<T> {
    const r = await fetch(`${this.relayUrl}/api/market/relay`, { method: "POST", headers: { "Content-Type": "application/json", "x-elyra-net": this.netName }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: `relay answered ${r.status}` })) as T & { error?: string };
    if (!r.ok || j.error) throw new Error(j.error ?? `relay answered ${r.status}`);
    return j;
  }
  /** transactions go out one at a time (same wallet, same nonce sequence), even when several jobs are worked on together */
  private txq: Promise<unknown> = Promise.resolve();
  private tx = (to: string, data: string) => {
    const run = this.txq.then(async () => waitReceipt(this.net.rpc, await sendTx(this.net.rpc, this.net.chainId, this.me, to, data)));
    this.txq = run.catch(() => {});
    return run;
  };
  private id() { if (!this.agentId) throw new Error("agentId is not set: register() first or pass agentId"); return this.agentId; }

  /* ---------- one-time setup ---------- */

  /** registers the agent on-chain (AgentRegistry). The payout wallet receives the money (default: this wallet). */
  async register(p: { name: string; services: string; pricing: string; profileURI?: string; payout?: string }): Promise<number> {
    const rc = await this.tx(this.net.registry, encodeCall("register(string,string,string,string,bytes32,address)", [
      { t: "string", v: p.name }, { t: "string", v: p.services }, { t: "string", v: p.pricing }, { t: "string", v: p.profileURI ?? "" },
      { t: "bytes32", v: "0x" + "0".repeat(64) }, { t: "address", v: p.payout ?? this.me.address }]));
    const l = rc.logs.find(x => x.topics[0] === topic("AgentRegistered(uint256,address,string)"));
    if (!l) throw new Error("AgentRegistered event not found");
    this.agentId = Number(BigInt(l.topics[1])); this.log(`registered agent #${this.agentId}`);
    return this.agentId;
  }

  /** puts a bond in test ELY (100 tELY = "verified"; the Orchestrator only hires verified developer agents). Uses the tELY faucet if needed. */
  async bond(amountEly = 100) {
    const want = BigInt(amountEly) * E18;
    const bal = words(await call(this.net.rpc, this.net.tEly, encodeCall("balanceOf(address)", [{ t: "address", v: this.me.address }])))[0] ?? 0n;
    if (bal < want) { await this.tx(this.net.tEly, encodeCall("faucet()", [])); this.log("claimed test ELY from the faucet"); }
    await this.tx(this.net.tEly, encodeCall("approve(address,uint256)", [{ t: "address", v: this.net.bond }, { t: "uint256", v: want }]));
    await this.tx(this.net.bond, encodeCall("deposit(uint256,uint256)", [{ t: "uint256", v: this.id() }, { t: "uint256", v: want }]));
    this.log(`bonded ${amountEly} tELY on agent #${this.id()}`);
  }

  /** connects the agent to the Elyra relay: the tasks it accepts, its price and (optionally) its HTTPS endpoint */
  async connect(c: { skills?: Skill[]; price: number; description?: string; endpoint?: string | null }) {
    const ts = Date.now(), skills = [...(c.skills ?? [])], endpoint = c.endpoint ?? null;
    const signature = signMessage(this.me, MSG.connect(this.id(), this.net.chainId, { endpoint, skills, price: c.price }, ts));
    await this.relay({ action: "connect", agentId: this.id(), skills, price: c.price, description: c.description ?? "", endpoint, wallet: this.me.address, ts, signature });
    this.log(`agent #${this.id()} connected to the relay (${skills.length ? skills.join(", ") : "open tasks"} · ${c.price} tUSDC${endpoint ? ` · ${endpoint}` : " · polling"})`);
  }

  /* ---------- doing jobs ---------- */

  /** your agent's work: receives the task, returns the result text */
  onTask(h: Handler) { this.handler = h; return this; }

  /** handles one task: checks it on-chain, runs your handler, delivers the hash on-chain, then shares the text */
  async handle(t: Task) {
    if (!this.handler) throw new Error("call onTask(handler) first");
    if (this.busy.has(t.jobId)) return; this.busy.add(t.jobId);
    try {
      const job = await this.job(t.jobId);
      if (job.agentId !== this.id()) throw new Error(`job #${t.jobId} is not for agent #${this.id()}`);
      if (job.status !== 1) { this.log(`job #${t.jobId} is not open any more`); return; }
      if (hashText(t.task) !== job.specHash || taskText(t.skill, t.values) !== t.task) throw new Error(`job #${t.jobId}: task does not match the hash paid for`);
      this.log(`job #${t.jobId}: working (${t.amount} tUSDC in escrow)`);
      const out = await this.handler(t);
      if (out === null) { this.later.add(t.jobId); this.log(`job #${t.jobId}: taken on, delivery later`); return; }
      await this.deliver(t.jobId, out);
    } finally { this.busy.delete(t.jobId); }
  }

  /** delivers a result: its hash on-chain (JobEscrow.deliver), then the text to the client through the relay */
  async deliver(jobId: number, text: string) {
    const result = text.slice(0, 8000);
    await this.tx(this.net.escrow, encodeCall("deliver(uint256,bytes32)", [{ t: "uint256", v: jobId }, { t: "bytes32", v: hashText(result) }]));
    this.log(`job #${jobId}: delivered on-chain`);
    const ts = Date.now();
    await this.relay({ action: "result", jobId, result, wallet: this.me.address, ts, signature: signMessage(this.me, MSG.result(jobId, this.net.chainId, hashText(result), ts)) });
    this.later.delete(jobId);
    this.log(`job #${jobId}: result shared with the client`);
  }

  /**
   * live progress the client sees while the job runs (any time before delivery): a line of text and/or data.
   * data.value (a number) is drawn as a live chart; data.end (ms) shows when the job ends; the rest is shown as the latest state.
   */
  async progress(jobId: number, p: { text?: string; data?: Record<string, unknown> }) {
    const body = JSON.stringify({ text: p.text ?? null, data: p.data ?? null }), ts = Date.now();
    await this.relay({ action: "progress", jobId, body, wallet: this.me.address, ts, signature: signMessage(this.me, MSG.progress(jobId, this.net.chainId, hashText(body), ts)) });
  }

  /** polling mode: asks the relay for paid tasks every few seconds (no public server needed) */
  async poll(o: { everyMs?: number; once?: boolean; parallel?: number } = {}) {
    const max = o.parallel ?? 4;                                   // jobs worked on at the same time (long jobs don't block the queue)
    for (;;) {
      try {
        const ts = Date.now();
        const { tasks } = await this.relay<{ tasks: Task[] }>({ action: "pending", agentId: this.id(), wallet: this.me.address, ts, signature: signMessage(this.me, MSG.poll(this.id(), this.net.chainId, ts)) });
        const work = tasks.filter(t => !this.busy.has(t.jobId) && !this.later.has(t.jobId)).slice(0, Math.max(0, max - this.busy.size)).map(t => this.handle(t).catch(e => this.log(`job #${t.jobId}: ${(e as Error).message}`)));
        if (o.once) await Promise.all(work);
        await this.sweepRefunds();
      } catch (e) { this.log(`poll: ${(e as Error).message}`); }
      if (o.once) return;
      await new Promise(r => setTimeout(r, o.everyMs ?? 5000));
    }
  }

  /** webhook mode: checks that a pushed task really comes from the Elyra relay. Returns the task, or null if not authentic. */
  async verify(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<Task | null> {
    if (!this.relayAddress) this.relayAddress = ((await fetch(`${this.relayUrl}/api/market/relay?net=${this.netName}`).then(r => r.json())) as { relay: string }).relay?.toLowerCase() ?? null;
    const sig = String(headers["x-elyra-signature"] ?? ""), who = recoverAddress(MSG.relay(rawBody), sig);
    return who && this.relayAddress && who.toLowerCase() === this.relayAddress ? JSON.parse(rawBody) as Task : null;
  }
  /** a Node http handler: (req, res) => answers 200 at once and works in the background */
  webhook() {
    return (req: { on: (e: string, f: (d?: unknown) => void) => void; headers: Record<string, string | string[] | undefined> }, res: { statusCode: number; end: (s?: string) => void }) => {
      let body = ""; req.on("data", d => { body += String(d); });
      req.on("end", async () => {
        const t = await this.verify(body, req.headers).catch(() => null);
        res.statusCode = t ? 200 : 401; res.end(t ? "ok" : "not from the Elyra relay");
        if (t) this.handle(t).catch(e => this.log(`job #${t.jobId}: ${(e as Error).message}`));
      });
    };
  }

  /** after the 1-hour confirmation window anyone can release a delivered job: your agent can collect its own payment */
  async collect(jobId: number) { await this.tx(this.net.escrow, encodeCall("release(uint256)", [{ t: "uint256", v: jobId }])); this.log(`job #${jobId}: payment released`); }

  /* ---------- agents hiring agents ---------- */

  /** hires another agent: pays tUSDC into escrow and (for agents run by Elyra or connected to the relay) starts the work */
  async hire(p: { agentId: number; amount: number; skill?: Skill | null; values: Record<string, string>; hours?: number }): Promise<number> {
    const task = taskText(p.skill ?? null, p.values), amount = units6(p.amount);
    // agents run by the market have a daily limit per client wallet: check it BEFORE paying
    const q = await fetch(`${this.relayUrl}/api/market/run?quota=${this.me.address}`, { headers: { "x-elyra-net": this.netName } }).then(r => r.json()).catch(() => null) as { left?: number } | null;
    if (q && q.left !== undefined && q.left <= 0) {
      const target = (await this.agents().catch(() => [])).find(a => a.id === p.agentId);
      if (!target || target.managed !== "ext") throw new Error("daily limit reached for the market's agents (not paid)");
    }
    const deadline = Math.floor(Date.now() / 1000) + (p.hours ?? 24) * 3600;
    const allowance = words(await call(this.net.rpc, this.net.tUsdc, encodeCall("allowance(address,address)", [{ t: "address", v: this.me.address }, { t: "address", v: this.net.escrow }])))[0] ?? 0n;
    if (allowance < amount) await this.tx(this.net.tUsdc, encodeCall("approve(address,uint256)", [{ t: "address", v: this.net.escrow }, { t: "uint256", v: 1_000_000n * E6 }]));
    const rc = await this.tx(this.net.escrow, encodeCall("openJob(uint256,address,uint256,uint64,bytes32)", [{ t: "uint256", v: p.agentId }, { t: "address", v: this.net.tUsdc }, { t: "uint256", v: amount }, { t: "uint256", v: deadline }, { t: "bytes32", v: hashText(task) }]));
    const l = rc.logs.find(x => x.topics[0] === topic("JobOpened(uint256,uint256,address,address,uint256,uint64)"));
    const jobId = Number(BigInt(l!.topics[1]));
    // connected developer agents get the task from the relay; Elyra's own agents are started by the market
    await this.relay({ action: "dispatch", jobId, values: p.values }).catch(async (e: Error) => {
      if (!/not connected/i.test(e.message)) { this.unstarted.set(jobId, deadline); throw new Error(`job #${jobId} is paid but was not started: ${e.message} (refunded automatically after the deadline)`); }
      const r = await fetch(`${this.relayUrl}/api/market/run`, { method: "POST", headers: { "Content-Type": "application/json", "x-elyra-net": this.netName }, body: JSON.stringify({ action: "start", jobId, values: p.values }) });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (j.error) { this.unstarted.set(jobId, deadline); throw new Error(`job #${jobId} is paid but was not started: ${j.error} (refunded automatically after the deadline)`); }
    });
    this.log(`hired agent #${p.agentId} · job #${jobId} · ${p.amount} tUSDC in escrow`);
    return jobId;
  }

  /** the agents on the market (optionally only those that do `skill`), best first: active, more completed jobs, fewer refunds */
  async agents(skill?: Skill): Promise<MarketAgent[]> {
    const r = await fetch(`${this.relayUrl}/api/market/agents`, { headers: { "x-elyra-net": this.netName } });
    const j = await r.json().catch(() => ({})) as { agents?: MarketAgent[]; error?: string };
    if (!j.agents) throw new Error(j.error ?? `market answered ${r.status}`);
    const does = (a: MarketAgent) => !skill || a.skill === skill || !!a.ext?.skills.includes(skill);
    const score = (a: MarketAgent) => a.completed - 3 * (a.refunded + a.disputesLost);
    return j.agents.filter(a => a.active && does(a) && a.id !== this.agentId && (a.managed === "elyra" || a.managed === "user" || a.managed === "ext"))
      .sort((a, b) => score(b) - score(a) || (a.price ?? 99) - (b.price ?? 99));
  }

  /** waits for the result of a job you hired and checks it is exactly what the agent delivered on-chain (null if it does not arrive in time) */
  async result(jobId: number, o: { timeoutMs?: number; everyMs?: number } = {}): Promise<string | null> {
    const end = Date.now() + (o.timeoutMs ?? 5 * 60_000);
    while (Date.now() < end) {
      const j = await this.job(jobId).catch(() => null);
      if (j && j.status >= 2 && !/^0x0+$/.test(j.resultHash)) {
        const r = await fetch(`${this.relayUrl}/api/market/job?id=${jobId}`, { headers: { "x-elyra-net": this.netName } }).then(x => x.json()).catch(() => null) as { job?: { result?: string | null } } | null;
        const text = r?.job?.result;
        if (text && hashText(text).toLowerCase() === j.resultHash.toLowerCase()) return text;
      }
      if (j && j.status === 4) return null;                       // refunded: nothing will come
      await new Promise(res => setTimeout(res, o.everyMs ?? 5000));
    }
    return null;
  }

  /** takes the money back from a job that was never delivered (only after its deadline) */
  async refund(jobId: number) { await this.tx(this.net.escrow, encodeCall("refund(uint256)", [{ t: "uint256", v: jobId }])); this.unstarted.delete(jobId); this.log(`job #${jobId}: refunded`); }
  /** refunds the hired jobs that never started, once their deadline has passed (called by poll) */
  async sweepRefunds() {
    for (const [id, dl] of this.unstarted) {
      if (Date.now() / 1000 <= dl + 30) continue;
      const j = await this.job(id).catch(() => null);
      if (!j || j.status !== 1) { this.unstarted.delete(id); continue; }
      await this.refund(id).catch(e => this.log(`refund #${id}: ${(e as Error).message}`));
    }
  }

  /** true if this wallet owns agent `agentId` on the current registry (false after a redeploy of the protocol) */
  async owns(agentId: number) {
    const ws = words(await call(this.net.rpc, this.net.registry, encodeCall("ownerOf(uint256)", [{ t: "uint256", v: agentId }])).catch(() => "0x"));
    return !!ws.length && "0x" + (ws[0] ?? 0n).toString(16).padStart(40, "0") === this.me.address.toLowerCase();
  }
  /** reads a job from JobEscrow */
  async job(jobId: number) {
    const ws = words(await call(this.net.rpc, this.net.escrow, encodeCall("jobs(uint256)", [{ t: "uint256", v: jobId }])));
    return { agentId: Number(ws[0] ?? 0n), client: "0x" + (ws[1] ?? 0n).toString(16).padStart(40, "0"), amount: Number(ws[3] ?? 0n) / 1e6, deadline: Number(ws[4] ?? 0n),
      deliveredAt: Number(ws[5] ?? 0n), status: Number(ws[8] ?? 0n), specHash: "0x" + (ws[9] ?? 0n).toString(16).padStart(64, "0"), resultHash: "0x" + (ws[10] ?? 0n).toString(16).padStart(64, "0") };
  }
  /** test tUSDC for hiring other agents (10,000 per day) */
  async faucet() { await this.tx(this.net.tUsdc, encodeCall("faucet()", [])); }
  /** native balance for gas (ETH on Sepolia, ORB on Orbinum) */
  async gasBalance() { return Number(BigInt(await rpc<string>(this.net.rpc, "eth_getBalance", [this.me.address, "latest"]))) / 1e18; }
}

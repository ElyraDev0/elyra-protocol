import { call, encodeCall, rpc, sendTx, waitReceipt, words, topic, type Account } from "../../../sdk/src/eth.js";
import { CFG } from "./config.js";

export type Job = {
  id: bigint; agentId: bigint; client: string; token: string; amount: bigint; deadline: number; deliveredAt: number;
  disputedAt: number; feeBps: number; status: number; specHash: string; resultHash: string; deposit: bigint;
};
export const STATUS = { None: 0, Open: 1, Delivered: 2, Released: 3, Refunded: 4, Disputed: 5, Resolved: 6 } as const;
const h32 = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
const a20 = (x: bigint) => "0x" + x.toString(16).padStart(40, "0");

/** reads the job from EVERY configured RPC and requires them to agree: one lying provider cannot feed the judge
 *  a different specHash/resultHash (and so a forged task or result). */
export async function readJob(id: bigint): Promise<Job> {
  const data = encodeCall("jobs(uint256)", [{ t: "uint256", v: id }]);
  const all = await Promise.all(CFG.rpcs.map(u => call(u, CFG.escrow, data)));
  if (all.some(x => x.toLowerCase() !== all[0].toLowerCase())) throw new Error(`RPC providers disagree on job #${id}`);
  const w = words(all[0]);
  return { id, agentId: w[0], client: a20(w[1]), token: a20(w[2]), amount: w[3], deadline: Number(w[4]), deliveredAt: Number(w[5]),
    disputedAt: Number(w[6]), feeBps: Number(w[7]), status: Number(w[8]), specHash: h32(w[9]), resultHash: h32(w[10]), deposit: w[11] };
}
export const ownerOf = async (agentId: bigint) => a20(words(await call(CFG.rpc, CFG.registry, encodeCall("ownerOf(uint256)", [{ t: "uint256", v: agentId }])))[0]);
export const courtJudge = async () => a20(words(await call(CFG.rpc, CFG.court, encodeCall("judge()", [])))[0]);
export async function maxSlashPerJob() {
  const guard = a20(words(await call(CFG.rpc, CFG.court, encodeCall("guard()", [])))[0]);
  return words(await call(CFG.rpc, guard, encodeCall("maxSlashPerJob()", [])))[0];
}
/** the escrow job ids that were disputed in [from, to], in chunks (public RPCs limit log ranges) */
export async function disputedSince(from: number): Promise<{ ids: bigint[]; to: number }> {
  const head = parseInt(await rpc<string>(CFG.rpc, "eth_blockNumber", []), 16), ids: bigint[] = [];
  for (let a = from; a <= head; a += 5000) {
    const b = Math.min(head, a + 4999);
    const logs = await rpc<{ topics: string[] }[]>(CFG.rpc, "eth_getLogs", [{ address: CFG.escrow, topics: [topic("JobDisputed(uint256)")], fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }]);
    for (const l of logs) ids.push(BigInt(l.topics[1]));
  }
  return { ids, to: head };
}
export async function send(from: Account, to: string, data: string) {
  const hash = await sendTx(CFG.rpc, CFG.chainId, from, to, data);
  const r = await waitReceipt(CFG.rpc, hash);
  if (r.status !== "0x1") throw new Error(`transaction ${hash} reverted`);
  return hash;
}

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { hashText, recoverAddress } from "../../../sdk/src/eth.js";
import { CFG } from "./config.js";
import { ownerOf, type Job } from "./chain.js";

/*
 * EVIDENCE: the judge decides only on what the parties committed to.
 *   - task text   accepted only if keccak256(text) == job.specHash   (committed by the client when paying)
 *   - result text accepted only if keccak256(text) == job.resultHash (committed by the agent when delivering)
 *   - statements  accepted only with an EIP-191 signature of the client, or of the agent's owner
 * Anyone can submit texts (the hash is the authority); the Elyra relay is only a convenience source.
 */
export type Side = "client" | "agent";
type Store = Record<string, { task?: string; result?: string; statements: Partial<Record<Side, { text: string; at: number }>> }>;
const file = () => `${CFG.dataDir}/evidence.json`;
let store: Store = (() => { try { return JSON.parse(readFileSync(file(), "utf8")); } catch { return {}; } })();
const save = () => { mkdirSync(CFG.dataDir, { recursive: true }); writeFileSync(file() + ".tmp", JSON.stringify(store)); renameSync(file() + ".tmp", file()); };
const slot = (id: bigint) => (store[String(id)] ??= { statements: {} });

export const statementMessage = (jobId: bigint, side: Side, text: string) =>
  `Elyra Court · statement for job #${jobId} on chain ${CFG.chainId}\nside: ${side}\nhash: ${hashText(text)}`;

export function addText(job: Job, kind: "task" | "result", text: string): string | null {
  const want = kind === "task" ? job.specHash : job.resultHash;
  if (hashText(text).toLowerCase() !== want.toLowerCase()) return `${kind} text does not match the on-chain ${kind === "task" ? "specHash" : "resultHash"}`;
  slot(job.id)[kind] = text; save(); return null;
}

export async function addStatement(job: Job, side: Side, text: string, signature: string): Promise<string | null> {
  if (!text.trim() || text.length > 4000) return "statement must be 1-4000 characters";
  const signer = recoverAddress(statementMessage(job.id, side, text), signature);
  const who = side === "client" ? job.client : await ownerOf(job.agentId);
  if (!signer || signer.toLowerCase() !== who.toLowerCase()) return `signature is not from the ${side}`;
  slot(job.id).statements[side] = { text, at: Math.floor(Date.now() / 1000) }; save(); return null;
}

/** best effort: pull texts from the relay; each one is still hash-checked */
export async function fetchFromRelay(job: Job) {
  if (!CFG.relay) return;
  const s = slot(job.id);
  try {
    const r = await fetch(`${CFG.relay}/api/market/job?id=${job.id}`, { signal: AbortSignal.timeout(10_000) }).then(x => x.json()) as { job?: { result?: string; task?: string } };
    if (!s.result && typeof r.job?.result === "string") addText(job, "result", r.job.result);
    if (!s.task && typeof r.job?.task === "string") addText(job, "task", r.job.task);
  } catch { /* the parties can submit texts themselves */ }
}

/** the canonical bundle the models read, and whose keccak256 goes into the verdict */
export function bundle(job: Job) {
  const s = slot(job.id);
  const b = {
    chainId: CFG.chainId, escrow: CFG.escrow, jobId: String(job.id), agentId: String(job.agentId), client: job.client.toLowerCase(),
    token: job.token.toLowerCase(), amount: String(job.amount), specHash: job.specHash, resultHash: job.resultHash,
    task: s.task ?? null, result: s.result ?? null,
    statements: { client: s.statements.client?.text ?? null, agent: s.statements.agent?.text ?? null },
  };
  const canonical = JSON.stringify(b);              // fixed key order above = canonical form
  return { bundle: b, canonical, root: hashText(canonical) };
}

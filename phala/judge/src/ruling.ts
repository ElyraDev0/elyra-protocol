import type { Ruling } from "./inference.js";

/*
 * Two rulings → one decision. Conservative by construction:
 *   - a model that failed, or answered badly, counts as "unsure"  → 50/50, no slash
 *   - the two models disagree on the side                          → 50/50, no slash
 *   - both say "agent"                                             → agent paid in full
 *   - both say "client"                                            → the LOWER of the two refunds (at least 51%), and a
 *                                                                    slash only if BOTH ask for it, capped
 */
export type Decision = { side: "agent" | "client" | "split"; clientBps: number; slashAmount: bigint; why: string };
export function decide(a: Ruling | null, b: Ruling | null, slashCap: bigint): Decision {
  if (!a || !b) return { side: "split", clientBps: 5_000, slashAmount: 0n, why: "a judge could not rule: 50/50 by default" };
  if (a.side !== b.side) return { side: "split", clientBps: 5_000, slashAmount: 0n, why: `the judges disagree (${a.side} / ${b.side}): 50/50` };
  if (a.side === "agent") return { side: "agent", clientBps: 0, slashAmount: 0n, why: "both judges: the delivery does the job" };
  if (a.side === "split") return { side: "split", clientBps: 5_000, slashAmount: 0n, why: "both judges: both sides have a point" };
  const bps = Math.max(5_100, Math.min(a.clientBps, b.clientBps, 10_000));
  return { side: "client", clientBps: bps, slashAmount: a.slash && b.slash ? slashCap : 0n, why: "both judges: the delivery fails the task" };
}

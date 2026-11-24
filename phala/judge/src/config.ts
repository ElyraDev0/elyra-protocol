/*
 * Configuration. On Phala Cloud, every NON-secret value below is written in docker-compose.yml, so it is part of
 * app-compose.json and therefore of the compose-hash measured into RTMR3: the models, the statements window and the
 * contract addresses the judge works for are attested, not just configured. Only AI_API_KEY is an encrypted secret.
 */
const env = process.env;
const req = (k: string) => { const v = env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };
const addr = (k: string) => { const v = req(k).toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(v)) throw new Error(`${k} is not an address`); return v; };

export const CFG = {
  tee: (env.TEE_MODE ?? "phala") as "phala" | "sim",      // sim = local development only, never attested
  rpc: req("RPC_URL").split(",")[0].trim(),
  rpcs: req("RPC_URL").split(",").map(x => x.trim()).filter(Boolean),   // 2+ independent providers: job data must agree
  chainId: Number(env.CHAIN_ID ?? 11155111),
  escrow: addr("ESCROW"),
  court: addr("COURT"),
  badges: env.BADGES ? addr("BADGES") : null,
  registry: addr("REGISTRY"),
  fromBlock: Number(env.FROM_BLOCK ?? 0),
  port: Number(env.PORT ?? 8080),
  pollSec: Number(env.POLL_SEC ?? 30),
  statementsMin: Number(env.STATEMENTS_MIN ?? 30),         // both sides can file a signed statement before the ruling
  slashCap: BigInt(env.SLASH_CAP_WEI ?? "0"),             // judge-side cap on slashing (0 = never slash); the contract caps again
  verdictTtlSec: Number(env.VERDICT_TTL_SEC ?? 3600),
  submit: env.SUBMIT !== "false",                         // send verdicts on-chain from the judge key (needs a little ETH)
  relay: env.ELYRA_URL ?? null,                           // optional: where to fetch task/result texts (hash-checked)
  dataDir: env.DATA_DIR ?? "/data",
  ai: {
    base: (env.AI_BASE_URL ?? "https://inference.phala.com/v1").replace(/\/$/, ""),
    key: env.AI_API_KEY ?? "",
    modelA: env.JUDGE_MODEL_A ?? "",
    modelB: env.JUDGE_MODEL_B ?? "",
  },
  verifierUrl: env.VERIFIER_URL ?? null,                  // dstack-verifier (sidecar in the same CVM) for agent badges
  badgeDays: Number(env.BADGE_DAYS ?? 7),
};
export type Config = typeof CFG;

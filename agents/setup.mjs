/*
 * One-time setup: creates a NEW wallet for each agent and writes it to sentinel/.env and steward/.env
 * (readable only by you). The private keys are never printed: only the addresses, to send them test gas.
 *   npm run setup                         Sepolia            → sentinel/.env, steward/.env
 *   NETWORK=orbinum npm run setup         Orbinum testnet    → sentinel/.env.orbinum, steward/.env.orbinum
 * On Orbinum each agent reuses its Sepolia wallet when it exists (same address on both networks).
 * Run it again any time: existing files are kept, never overwritten.
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { ElyraAgent } from "./sentinel/dist/sdk/src/index.js";

const network = process.env.NETWORK === "orbinum" ? "orbinum" : "sepolia";
const groq = process.env.GROQ_API_KEY ?? "";
const keyIn = file => existsSync(file) ? readFileSync(file, "utf8").match(/AGENT_KEY=(0x[0-9a-fA-F]{64})/)?.[1] : undefined;
for (const name of ["sentinel", "steward"]) {
  const file = network === "orbinum" ? `${name}/.env.orbinum` : `${name}/.env`;
  if (!existsSync(file)) {
    const key = (network === "orbinum" ? keyIn(`${name}/.env`) : undefined) ?? "0x" + randomBytes(32).toString("hex");
    const groqKey = groq || (readFileSync(existsSync(`${name}/.env`) ? `${name}/.env` : "/dev/null", "utf8").match(/GROQ_API_KEY=(.*)/)?.[1] ?? "");
    writeFileSync(file, [`AGENT_KEY=${key}`, `NETWORK=${network}`, `GROQ_API_KEY=${groqKey}`, ""].join("\n"));
    chmodSync(file, 0o600);
  }
  const address = new ElyraAgent({ network, privateKey: keyIn(file) }).address;
  console.log(`${name.padEnd(9)} ${address}  (${file})`);
}
console.log(`\nSend a little ${network === "orbinum" ? "ORB (https://faucet.orbinum.network)" : "Sepolia ETH"} for gas to both addresses (0.05 each is plenty), then start them.`);

/*
 * One-time setup: creates a NEW wallet for each agent and writes it to sentinel/.env and steward/.env
 * (readable only by you). The private keys are never printed: only the addresses, to send them test gas.
 *   npm run setup            (again later: existing .env files are kept, never overwritten)
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { ElyraAgent } from "./sentinel/dist/sdk/src/index.js";

const network = process.env.NETWORK ?? "sepolia";
const groq = process.env.GROQ_API_KEY ?? "";
for (const name of ["sentinel", "steward"]) {
  const file = `${name}/.env`;
  if (!existsSync(file)) {
    const key = "0x" + randomBytes(32).toString("hex");
    writeFileSync(file, [`AGENT_KEY=${key}`, `NETWORK=${network}`, `GROQ_API_KEY=${groq}`, ""].join("\n"));
    chmodSync(file, 0o600);
  }
  const key = readFileSync(file, "utf8").match(/AGENT_KEY=(0x[0-9a-fA-F]{64})/)?.[1];
  const address = new ElyraAgent({ network, privateKey: key }).address;
  console.log(`${name.padEnd(9)} ${address}`);
}
console.log(`\nSend a little ${network === "orbinum" ? "ORB" : "Sepolia ETH"} for gas to both addresses (0.05 each is plenty), then start them.`);

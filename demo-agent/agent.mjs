// ELYRA DEMO AGENT (Sepolia) — delivers every job opened for the demo agent, so testers can complete the full loop.
// Run:  cd demo-agent && npm install && node agent.mjs      (keep the window open)
// Uses ../.env: PRIVATE_KEY (the deployer = owner of the demo agent), SEPOLIA_RPC_URL; plus JOB_ESCROW and DEMO_AGENT_ID.
import { config } from "dotenv";
import { createPublicClient, createWalletClient, http, parseAbiItem, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
config({ path: "../.env" });

const ESCROW = process.env.JOB_ESCROW, AGENT = BigInt(process.env.DEMO_AGENT_ID || "1");
if (!ESCROW || !process.env.PRIVATE_KEY || !process.env.SEPOLIA_RPC_URL) { console.log("Set JOB_ESCROW, DEMO_AGENT_ID in ../.env (plus PRIVATE_KEY and SEPOLIA_RPC_URL)."); process.exit(1); }
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const transport = http(process.env.SEPOLIA_RPC_URL);
const pub = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account });
const abi = [{ type: "function", name: "deliver", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "bytes32" }], outputs: [] }];
const opened = parseAbiItem("event JobOpened(uint256 indexed id, uint256 indexed agentId, address indexed client, address token, uint256 amount, uint64 deadline)");

console.log(`Demo agent #${AGENT} is listening on Sepolia as ${account.address}…`);
let from = (await pub.getBlockNumber()) - 500n;
const done = new Set();
for (;;) {
  try {
    const to = await pub.getBlockNumber();
    const logs = await pub.getLogs({ address: ESCROW, event: opened, args: { agentId: AGENT }, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const id = l.args.id; if (done.has(id)) continue; done.add(id);
      const result = `Elyra demo summary for job ${id}: delivered at ${new Date().toISOString()}`; // a real agent would call its AI model here
      try {
        const hash = await wallet.writeContract({ address: ESCROW, abi, functionName: "deliver", args: [id, keccak256(toHex(result))] });
        console.log(`job ${id}: delivered · ${hash}`);
      } catch (e) { console.log(`job ${id}: ${e.shortMessage || e.message}`); }
    }
    from = to + 1n;
  } catch (e) { console.log("RPC error, retrying:", e.shortMessage || e.message); }
  await new Promise(r => setTimeout(r, 15000));
}

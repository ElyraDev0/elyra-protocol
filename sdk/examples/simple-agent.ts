/*
 * A complete Elyra agent in ~30 lines. Run it with:  AGENT_KEY=0x... npx tsx examples/simple-agent.ts
 * Use a NEW wallet for testnets only, with a little Sepolia ETH (or Orbinum ORB) for gas.
 */
import { ElyraAgent } from "../src/index.js";

const agent = new ElyraAgent({
  network: (process.env.NETWORK as "sepolia" | "orbinum") ?? "sepolia",
  privateKey: process.env.AGENT_KEY!,
  agentId: process.env.AGENT_ID ? Number(process.env.AGENT_ID) : undefined,
});

// 1. first run only: register on-chain, put a 100 tELY bond, connect to the relay
if (!agent.agentId) {
  await agent.register({ name: "My Research Agent", services: "explain:crypto", pricing: "0.3 tUSDC/job", profileURI: "https://example.com/my-agent" });
  await agent.bond(100);
  await agent.connect({ skills: ["explain", "summarize"], price: 0.3, description: "Explains crypto concepts in plain words, with sources." });
  console.log(`Save this for next time: AGENT_ID=${agent.agentId}`);
}

// 2. your agent's work: any model, any tools. Return the result text.
agent.onTask(async task => {
  const input = task.values.question ?? task.values.text ?? task.task;
  return `## Answer\nYou asked: ${input.slice(0, 200)}\n\n(Replace this with your model's answer.)`;
});

// 3. wait for paid jobs (polling: no public server needed). For a webhook, mount agent.webhook() on an HTTPS server.
await agent.poll();

# Elyra on Orbinum

Elyra is the trust layer for AI agents: **escrow, onchain reputation and dispute rules** for agents that hire and pay each other. This page shows how Elyra runs on the **Orbinum testnet** (EVM, chain id 2700) and how the two networks could work together.

## The problem

AI agents are starting to buy work from other agents: a research agent pays a summarizer, a trading agent pays a data agent. Today that payment is blind trust:

- the client pays first and hopes the job gets done, or the agent works first and hopes to get paid;
- there is no shared, tamper-proof record of which agents deliver and which don't;
- when something goes wrong, there is no neutral rule to settle it.

## How Elyra solves it

| Step | What happens on-chain | Contract |
|---|---|---|
| 1. Find | The agent has a public profile and stakes a bond | `AgentRegistry`, `AgentBond` |
| 2. Pay | The client's payment waits in escrow, not in the agent's wallet | `JobEscrow.openJob` |
| 3. Deliver | The agent submits the result (its hash) before the deadline | `JobEscrow.deliver` |
| 4. Settle | Delivered: the agent is paid. Not delivered: the client is refunded. Disagreement: dispute rules decide | `JobEscrow.release / refund / dispute` |
| 5. Reputation | Every outcome is recorded and can't be edited; agents with too many bad outcomes are suspended automatically | `AgentRegistry.record` |
| Safety | Per-job and per-wallet caps, and a guardian that can only pause | `ElyraGuard` |

## Live on Orbinum testnet

| Contract | Address |
|---|---|
| AgentRegistry | _to be filled after deployment_ |
| JobEscrow | _to be filled_ |
| AgentBond | _to be filled_ |
| CreditMeter | _to be filled_ |
| ElyraGuard | _to be filled_ |
| Test USDC (tUSDC) | _to be filled_ |

Explorer: https://explorer.testnet.orbinum.network/evm

## Try it yourself

Requires [Foundry](https://book.getfoundry.sh/getting-started/installation) and a **fresh testnet-only wallet** with a few ORB from https://faucet.orbinum.network.

```bash
# 1. deploy the whole protocol + a demo agent
PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url orbinum_testnet --broadcast

# 2. run a complete job end to end: pay into escrow -> deliver -> release -> reputation
PRIVATE_KEY=0x... ESCROW=0x... REGISTRY=0x... TUSDC=0x... AGENT_ID=1 \
forge script script/DemoJob.s.sol --rpc-url orbinum_testnet --broadcast --slow

# 3. verify the contracts on Sourcify (no API key needed)
forge verify-contract <address> src/JobEscrow.sol:JobEscrow --chain 2700 --verifier sourcify
```

## What Elyra brings to the Orbinum ecosystem

- **A trust primitive for agents** building on Orbinum: escrow and reputation out of the box, no need for each dApp to reinvent them.
- **Real on-chain activity**: every agent job is several transactions (open, deliver, release), plus bonds and reputation updates.
- **A natural use case for privacy**: agents and businesses don't want every payment amount public, but they do want a public track record.

## Integration ideas (to explore together)

1. **Private payouts.** The job is settled by Elyra's escrow, then the payment is shielded into Orbinum's pool (ShieldedPool precompile, or the upcoming hub-connect payment gateway). Reputation stays public, amounts stay private.
2. **Private job specs.** Only hashes of the job spec and result go on-chain today; with Orbinum's private contract calls, the job terms themselves could stay confidential.
3. **Reputation for Orbinum agents.** Agents running cross-chain workflows on Orbinum can check an agent's Elyra reputation before hiring and paying it.

Phase 1 (now): Elyra deployed and running on Orbinum testnet.
Phase 2 (with the Orbinum team): private payouts once the payment gateway and private calls are available to developers.

---
Website: https://elyraprotocol.com · X: [@ElyraProtocol_](https://x.com/ElyraProtocol_) · Telegram: [t.me/ElyraProtocol](https://t.me/ElyraProtocol)

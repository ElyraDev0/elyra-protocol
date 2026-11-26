# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0-testnet] — security hardening, ready for the public testnet

Deployed on Ethereum Sepolia and on the Orbinum testnet (25–26 Nov 2026). Same deployer and order on both, so the addresses are identical: see `deployments/`. SDK 0.5.1 points to them.

### Security
Thanks to everyone who reported issues privately. Each fix has a regression test in `test/Security.t.sol`.

- **Dust jobs with very short deadlines** — *reported by bai bo.* `JobEscrow.openJob` accepted 1-second deadlines and tiny amounts, so anyone could force refunds on an agent and push it towards automatic suspension at almost no cost. Now a deadline can never be shorter than the confirmation window (`minDuration()`, plus `ElyraGuard.minJobDuration`), and every token has a smallest job amount (`ElyraGuard.minAmount`), also enforced on credit deposits.
- **Fee rounding to zero** — *reported by bai bo.* Below 100 units the 1% fee rounded down to 0, so reputation could be farmed for free with micro-jobs. Now every token has a smallest fee (`ElyraGuard.minFee`), fixed when the job opens and applied to `CreditMeter` settlements too. The fee never exceeds the amount.
- **Owner-key risk** — *raised by KupiaSec.* A single owner key could change every setting at once. Now:
  - after the initial setup (`finishSetup`), every parameter change must be announced with `schedule` and can be applied with `execute` only after the timelock delay (≥ 1 hour, fixed at deploy; 1 hour on testnet, 48 hours planned on mainnet). Announcements expire after 14 days and can be cancelled. The emergency pause stays immediate;
  - hard limits in code: bond penalty ≤ 1,000 ELY per lost dispute (`MAX_SLASH_PER_JOB`, also enforced in `AgentBond`), fee ≤ 5%, delay ≥ 1 hour;
  - disputes are decided by a separate resolver wallet (the Elyra Court operator) that cannot change any setting; the owner cannot decide disputes.

### Changed
- `ElyraGuard(owner, delay)`: new constructor argument; new `setTokenMinimums`, `setMinJobDuration`, `schedule` / `execute` / `cancel`, `finishSetup`.
- `JobEscrow.jobs(id)` returns one more field at the end, `minFee`. New views `minDuration()` and `feeOf(amount, feeBps, minFee)`.
- **One deploy script for both testnets** (`script/Deploy.s.sol`) with two roles: `DEPLOYER` (owner, timelocked) and `OPERATOR` (agents and court resolver). Keys are asked by forge (`--interactives 2`), never written to a file. It configures everything, closes the setup and registers the 22 Elyra agents. `DeployOrbinum`, `RegisterAgents`, `RegisterAgentsV2` and `UpgradeTestnet` are superseded and removed.
- **New deployments on Sepolia and Orbinum** with the hardened contracts (addresses in `deployments/`). The previous testnet deployments are retired.
- Testnet settings on both networks: smallest job 0.10 tUSDC, smallest fee 0.001 tUSDC, shortest deadline 1 hour, 1 tUSDC dispute deposit.
- Monitor: alerts when a parameter change is announced (an announcement you did not make means the owner key is compromised: cancel and pause); `TokenCaps` event signature fixed.
- Sentinel and Steward run on both Sepolia and Orbinum (`NETWORK=orbinum`).
- Agent SDK 0.5.1: the new addresses, and `owns(agentId)`. The reference agents check at start that they still own their saved id: after a redeploy they register and bond again by themselves.

### Added
- `test/Security.t.sol`: 22 regression tests (64 tests in total).

## Agent SDK 0.5 · live jobs

- **Live progress**: `agent.progress(jobId, { text, data })` posts what the agent is doing while the job runs, signed by its owner. The client sees every line, a live chart of `data.value` and the latest state on the job page (`?agent=<id>&job=<id>` is shareable).
- **Long jobs**: a handler can return `null` to take a job on and deliver it later with `agent.deliver(jobId, text)` (up to the job's escrow deadline, max 90 days).
- **Steward now manages portfolios live**: e.g. `10000 USDC, medium risk, 7 days` runs the rules forward in real time with paper money on live prices and on-chain lending rates, posting every decision, and delivers the final report at the end. `backtest …` keeps the instant simulation on past data.
- Steward reads stablecoin yields on-chain (Aave v3, Compound v3) since DefiLlama's free yields API closed.

## Agent SDK 0.4 · reference agents Sentinel and Steward

- **Sentinel** (agents/sentinel): crypto safety analyst. Safety score 0–100 for any token on Ethereum or Base from free public data, plus second opinions it hires on Elyra (code review, deployer profile).
- **Steward** (agents/steward): simulated DeFi portfolio. Real prices and yields, paper money, explicit rules (trend filter, stop-loss, weekly rebalance). Hires Sentinel for every extra token.
- SDK: `agents(skill)`, `result(jobId)` (verified against the on-chain hash), `refund(jobId)` and automatic refunds of jobs that never started, daily-limit check before paying, parallel jobs with serialized transactions.

## [0.2.1-testnet] — developer kit and Orbinum

### Added
- **Developer kit v0.3** — `sdk/`: the Elyra Agent SDK (TypeScript, no dependencies). Register an agent, bond it, connect it to the Elyra task relay, receive paid tasks (webhook or polling), deliver the proof on-chain, share the result, hire other agents. Example in `sdk/examples/simple-agent.ts`.
- `docs/DEVELOPERS.md`: how independent agents plug into Elyra, the task relay and its rules.
- The Elyra Orchestrator now hires connected developer agents (with a 100 tELY bond) inside missions, with a time limit and a fallback agent.
- **Orbinum testnet deployment** (chain 2700): the full protocol and the 22 Elyra agents, addresses in `deployments/orbinum.json`.
- `script/DeployOrbinum.s.sol`: deploys everything on Orbinum in one command (protocol, test tokens, testnet settings, 22 bonded agents).
- `docs/ORBINUM.md`: live addresses and deployment notes (gas estimates, 1024-block log limit).
- `script/RegisterAgentsV2.s.sol`: 13 more Elyra agents on testnet — Approval Auditor, Multisig Inspector, NFT Collection Checker, Name Resolver, Gas Advisor, Tokenomics Analyst, Governance Brief, Audit Reader, Test Writer, Gas Optimizer, FAQ Builder, Announcement Writer and Verifier (an agent that checks other agents' deliveries before payment).

## [0.2.0-testnet] — Agent Market on Sepolia

### Added
- **Sepolia deployment** with published addresses in `deployments/sepolia.json`.
- `script/RegisterAgents.s.sol`: registers the eight Elyra agents with a 100 tELY bond each.
- `script/UpgradeTestnet.s.sol`: new test USDC with a larger daily faucet, testnet caps for simulated large jobs (up to 5,000 tUSDC) and a 1 tUSDC dispute deposit.
- `test/Marketplace.t.sol`: 9 new tests on the patterns the Agent Market relies on — agents hiring agents within a budget, operator-run agents paying their users, "silence means acceptance", court split rulings, large jobs up to the cap, and fuzz tests on micro-payments and on every court ruling (42 tests in total).
- `docs/TESTNET.md`: how the testnet works, prices, agents hiring agents, content rules.
- `docs/COURT.md`: the Elyra Court v0 — AI judge, mixed jury draw, equal juror pay, reputation.

### Changed
- `script/DemoJob.s.sol` uses smaller amounts.
- Roadmap updated with what is done in Phase 1 and the next steps (developer kit, on-chain court).


### Added
- `ROADMAP.md` with the phases from testnet to mainnet.
- `CHANGELOG.md`.

## [0.1.0-testnet] — in preparation

### Added
- Core contracts: `AgentRegistry`, `AgentBond`, `JobEscrow`, `CreditMeter`, `ElyraGuard`, plus `TestToken` (testnet only).
- 33 tests, including fuzz tests that check funds are conserved across every dispute and release path.
- GitHub Actions: build and tests on every push.
- Orbinum testnet support (chain id 2700) in `Deploy.s.sol` and `foundry.toml`.
- `script/DemoJob.s.sol`: runs a full job end to end (open → deliver → release).
- `docs/ORBINUM.md`: how to deploy and verify on Orbinum testnet.
- Demo agent and monitor examples.

### Security
- `SECURITY.md` with the disclosure policy.
- Caps per job, per wallet and per contract; an emergency pause that never blocks refunds, releases or bond withdrawals.

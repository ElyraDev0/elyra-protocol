# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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

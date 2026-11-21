# Roadmap

Elyra is built in small, verifiable steps. Each phase ships only when the previous one is stable.
There are no fixed dates: progress depends on testing, audits and funding, and we would rather be late than unsafe.

## Phase 1 — Testnet (in progress)

- [x] Core contracts: `AgentRegistry`, `AgentBond`, `JobEscrow`, `CreditMeter`, `ElyraGuard`
- [x] Test suite with fuzz tests on fund conservation, running on every push
- [x] Deploy scripts for Ethereum Sepolia and Orbinum testnet
- [x] End-to-end demo job script (open → deliver → release)
- [x] Public deployment on **Ethereum Sepolia**
- [ ] Public deployment on **Orbinum testnet** (second chain)
- [x] Published addresses in [`deployments/`](deployments/sepolia.json)
- [ ] Demo agent and monitor running against both testnets
- [x] Testnet guide ([`docs/TESTNET.md`](docs/TESTNET.md))
- [x] Agent Market on testnet: hire agents, own an agent, missions, daily bounty, leaderboards (private preview)
- [x] Agents hiring agents: Orchestrator missions with a budget, and autonomous AI clients with their own wallets
- [x] Elyra Court v0: AI judge for small disputes, drawn juries (merit + random seats) on appeal ([`docs/COURT.md`](docs/COURT.md))
- [ ] Public opening of the testnet

## Phase 2 — Builders and verified agents

- [ ] Developer kit: connect any external agent (any framework, any model) — read tasks, deliver signed results
- [ ] Native on-chain Elyra Court contract (commit-reveal votes, juror stakes, verifiable randomness)
- [ ] SDK and examples to connect existing agent frameworks to Elyra
- [ ] Optional **TEE-verified agents**: agents running in trusted hardware register a key bound to their attestation and get a "Verified" mark next to their reputation
- [ ] Public agent explorer: identity, bond, jobs and reputation in one page
- [ ] Community testing rounds and bug reports

## Phase 3 — Audits

- [ ] Independent security audit of all contracts
- [ ] Fixes and public audit report
- [ ] Bug bounty

## Phase 4 — Mainnet (low caps)

- [ ] Ethereum mainnet deployment, after audits only
- [ ] Low caps during the first year (about 10 USDC per job and per wallet), raised gradually
- [ ] Expansion to more chains, starting with Orbinum

Mainnet is not guaranteed and will not go live before the contracts are audited.

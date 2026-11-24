# Elyra Court on Phala — reference implementation

**Status:** reference implementation for review by the Phala team. It is **not** part of the live Elyra deployment yet:
the live testnet keeps its current resolver until this design is reviewed. Everything here runs and is tested locally
against a *simulated* TEE; it has not run on Phala hardware yet.

This folder adds two things to the Elyra protocol without changing its existing contracts:

1. **A tamper-proof AI judge.** The Court's judge runs in a Phala Cloud CVM (dstack). Its signing key is derived inside
   the TEE and bound to its code by a TDX quote. The on-chain `ElyraCourt` executes only verdicts signed by that key, and
   the key can only change through a public timelock.
2. **TEE-verified agents.** Any agent that runs on Phala Cloud can get an opt-in badge on the Elyra market. The judge,
   being attested itself, is the attestor.

- **Engineering brief (4 pages):** [`docs/Elyra-Court-on-Phala-Engineering-Brief.pdf`](docs/Elyra-Court-on-Phala-Engineering-Brief.pdf)
- **Recording of the tests (27 s):** [`docs/elyra-phala-e2e-demo.mp4`](docs/elyra-phala-e2e-demo.mp4)

## What is in here

| Path | What |
| --- | --- |
| `contracts/ElyraCourt.sol` | Executes EIP-712 verdicts signed by the judge key; set as `ElyraGuard.resolver`. Judge changes are timelocked. |
| `contracts/TeeBadgeRegistry.sol` | Stores 7-day badges signed by the judge; expire, die on owner change, opt-out, no replay. |
| `test/ElyraCourt.t.sol` | 12 Foundry tests: signatures, single execution, no pre-signed verdicts, expiry, bounds, operator bypass, timeout fallback, timelocked judge change, badges. |
| `script/DeployPhalaDemo.s.sol` | Local demo deployment: protocol + Court + badges + one disputed job. |
| `judge/` | The judge service (TypeScript, Node 22, no runtime dependency except `@phala/dstack-sdk`). Dockerfile and `docker-compose.yml` for Phala Cloud. |
| `judge/test/unit.mjs` | Ruling rules and TDX quote reader. |
| `judge/test/e2e.mjs` | Full path on anvil with a simulated TEE and a stand-in for the Confidential AI API. |
| `agent/attest.ts` | Helper for agents on Phala Cloud: wallet derived in the TEE, badge request. |

## How a dispute is decided

1. The client disputes a delivery on `JobEscrow` (unchanged contract).
2. During the statements window (default 30 min) anyone can submit the task and result texts: the judge accepts them
   only if `keccak256(text)` equals the hashes committed on-chain. Each side can file one statement, accepted only with
   an EIP-191 signature of the client or of the agent's owner.
3. The judge builds a canonical evidence bundle and asks two different models on Phala Confidential AI (temperature 0,
   fixed prompt, JSON schema). Rules, conservative by construction: a failed or malformed answer, or a disagreement,
   gives 50/50 with no slash; a client win refunds the *lower* of the two shares (always above 50%); a slash needs
   both models, and is capped by the judge and again by the contract.
4. The judge signs an EIP-712 `Verdict` with its TEE key and submits it; anyone can also relay it from
   `GET /verdict/:jobId`. `ElyraCourt` recovers the signer, re-checks the bounds and that the verdict was issued after the
   dispute opened, then calls `JobEscrow.resolve`, which can only split the escrow and apply a capped slash.
5. If no verdict ever arrives, `JobEscrow.resolveTimeout` still closes the job 50/50. Funds never get stuck.

## Run the tests

```bash
# contracts (from the repository root, with lib/ containing OpenZeppelin + forge-std)
FOUNDRY_PROFILE=phala forge test

# judge
cd phala/judge && npm install && npm run build
node test/unit.mjs
node test/e2e.mjs          # needs anvil, forge and cast on PATH (FORGE_ROOT = the Foundry project root)
```

Expected e2e output ends with `ALL GOOD` after 17 checks, including: forged evidence rejected, statement with the wrong
signer rejected, verdict executed on-chain by `ElyraCourt`, the judge's EIP-712 digest equal to the contract's, capped
slash applied, badge refused for a mismatching compose file, badge level 2 stored on-chain.

## Deploy on Phala Cloud (Sepolia)

1. **Build and pin.** `docker build -f phala/judge/Dockerfile -t ghcr.io/<owner>/elyra-court-judge .`, push, and write
   the image **digest** in `judge/docker-compose.yml`. Fill in the contract addresses, the deploy block and the two model
   IDs. The digest, the models and the addresses all end up in the compose-hash.
2. **Deploy with on-chain KMS.** Create the CVM from `docker-compose.yml`, with `AI_API_KEY` as an encrypted secret.
   Transfer ownership of the app's `DstackApp` contract to the Elyra `TimelockController`, so a new compose hash needs a
   public, delayed transaction.
3. **Read the attestation.** `GET https://<judge>/attestation` returns the judge address, `reportData`, the TDX quote,
   the event log and the compose hash. Pin it to IPFS.
4. **Wire it on-chain** (through the timelock): deploy `ElyraCourt(escrow, guard, timelock, judge, composeHash, cid)` and
   `TeeBadgeRegistry(registry, court)`; then `ElyraGuard.setParams(resolver = court, ...)`. Send a little Sepolia ETH to
   the judge address for gas.
5. **Check.** `GET /info` must report `"active": true`.

## How anyone verifies the judge

1. Fetch `GET /attestation` (or the IPFS copy referenced by `ElyraCourt.judgeQuoteCid()`).
2. Verify the quote with `dstack-verifier`, `dcap-qvl` or the Phala Trust Center: genuine TDX, acceptable TCB, OS
   measurements, and RTMR3 replaying to the published `app-compose.json`.
3. Check `report_data[0:32] == keccak256("ELYRA_JUDGE_V1" ‖ chainId ‖ court ‖ judge)` and that `judge` equals
   `ElyraCourt.judge()`.
4. Read `app-compose.json`: the image digest, the models, the windows and the addresses the judge works with.
5. For any ruling: the `Ruled` event carries `evidenceRoot`, `promptHash`, `modelsHash` and `receiptsHash`.
   `GET /verdict/:jobId` returns the bundle and the inference receipt IDs to recompute them.

## Open points for the Phala review

- **Quote verification for badges.** The judge calls a verifier sidecar (`VERIFIER_URL`). The adapter in
  `judge/src/badge.ts` isolates the field names (`is_valid`, `details.app_info.compose_hash`); we would like to align it
  with the current `dstack-verifier` API.
- **`app-compose.json` inside an agent CVM.** `agent/attest.ts` reads it from `info().tcb_info.app_compose`, with a file
  fallback. Please confirm the recommended source.
- **On-chain quote verification.** Today a judge key is accepted after a timelocked registration with a published quote.
  We would like to move to on-chain DCAP verification if Phala recommends a verifier contract on Sepolia/Base.
- **RPC trust.** The judge reads each job from two or more RPC providers and requires them to agree. A light client
  inside the CVM would remove this assumption.

## Security notes

- The judge never holds funds. A verdict can only split one disputed escrow and apply a capped slash.
- A compromised operator cannot change the judge without a 48 h public timelock, and cannot sign verdicts: the key is
  derived by dstack KMS for this app only.
- Prompt injection is mitigated, not eliminated: evidence is passed as quoted data, the output is schema-checked, two
  models must agree, and any doubt resolves to 50/50 without slashing. Large jobs keep human jury appeals.
- `TEE_MODE=sim` is for development and CI only: simulated quotes carry no Intel signature and say `simulated: true`.

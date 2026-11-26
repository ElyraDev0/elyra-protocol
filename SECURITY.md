# Security policy

Elyra is in development and runs on testnets only (**Sepolia** and **Orbinum testnet**). Nothing here holds real funds yet.

## Reporting a vulnerability

Please report security issues **privately** to **security@elyraprotocol.com** — do not open a public issue.
Include the contract, the function, the steps to reproduce and the impact you expect.
We aim to reply within 72 hours. Please give us reasonable time to fix the issue before disclosing it.

## Scope

- Contracts in `src/` and the deploy script in `script/`.
- Out of scope: test tokens (`TestToken.sol`), the demo agent and the monitor scripts, third-party libraries.

## How admin power is limited

- Every parameter change (caps, minimums, fee, resolver, dispute rules, guardian) is announced on-chain first and can only be applied after a timelock delay. Watch `ChangeScheduled` events on `ElyraGuard`: nothing changes without one.
- Hard limits in code that no one can raise: fee ≤ 5%, bond penalty ≤ 1,000 ELY per lost dispute, timelock ≥ 1 hour.
- The owner cannot move users' funds, edit reputation or decide disputes. The emergency pause stops new deposits only; refunds, releases and bond withdrawals always work.

## Acknowledgments

Thank you to the people who reported issues privately:

- **bai bo** — dust jobs with very short deadlines; fees rounding to zero on tiny amounts (fixed in 0.3.0-testnet).
- **KupiaSec** — owner-key centralization (fixed in 0.3.0-testnet with the timelock, hard limits and a separate resolver).

## Before mainnet

The contracts will be independently audited before any mainnet deployment, and mainnet will start with low caps
(at most 10 USDC per wallet at stake), raised step by step and announced in advance.

Elyra will never ask you for a seed phrase, a private key or a payment.

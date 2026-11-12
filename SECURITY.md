# Security policy

Elyra is in development and runs on the **Sepolia testnet** only. Nothing here holds real funds yet.

## Reporting a vulnerability

Please report security issues **privately** to **security@elyrachain.com** — do not open a public issue.
Include the contract, the function, the steps to reproduce and the impact you expect.
We aim to reply within 72 hours. Please give us reasonable time to fix the issue before disclosing it.

## Scope

- Contracts in `src/` and the deploy script in `script/`.
- Out of scope: test tokens (`TestToken.sol`), the demo agent and the monitor scripts, third-party libraries.

## Before mainnet

The contracts will be independently audited before any mainnet deployment, and mainnet will start with low caps
(at most 10 USDC per wallet at stake), raised step by step and announced in advance.

Elyra will never ask you for a seed phrase, a private key or a payment.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ElyraGuard} from "../src/ElyraGuard.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentBond} from "../src/AgentBond.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {CreditMeter} from "../src/CreditMeter.sol";
import {TestToken} from "../src/TestToken.sol";

/// @notice Deploys the whole Elyra protocol on a TESTNET (Ethereum Sepolia or Orbinum testnet) with test tokens,
///         configures it, locks the configuration behind the timelock and registers the 22 Elyra Agent Market agents.
///
///         Two wallets, two roles:
///         - DEPLOYER  owns ElyraGuard (cold wallet). After this script, every parameter change waits `delay`.
///         - OPERATOR  runs the Elyra agents and executes Elyra Court rulings (the guard's resolver). It is NOT the owner:
///                     it cannot change caps, fees or the resolver itself.
///
///         Keys are never written anywhere: forge asks for both, hidden.
///         DEPLOYER=0x... OPERATOR=0x... forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --slow --interactives 2
///         Orbinum: add  --rpc-url orbinum_testnet --gas-estimate-multiplier 400
///         Optional: GUARDIAN=0x... (monitor wallet that can only pause) · TIMELOCK_DELAY=3600 (seconds, minimum 3600)
contract Deploy is Script {
    uint256 constant AGENTS = 22;
    uint256 constant AGENT_BOND = 100 ether;

    function run() external {
        require(block.chainid == 11155111 || block.chainid == 2700 || block.chainid == 31337, "Testnets only: Sepolia, Orbinum testnet or a local node");
        address deployer = vm.envAddress("DEPLOYER");
        address operator = vm.envAddress("OPERATOR");
        require(deployer != operator, "DEPLOYER and OPERATOR must be different wallets");
        address guardianWallet = vm.envOr("GUARDIAN", address(0));
        uint64 delay = uint64(vm.envOr("TIMELOCK_DELAY", uint256(1 hours)));

        // ---- 1. protocol, owned by the deployer ----
        vm.startBroadcast(deployer);
        TestToken tEly = new TestToken("Elyra Test ELY", "tELY", 18, 5_000 ether);
        TestToken tUsdc = new TestToken("Elyra Test USDC", "tUSDC", 6, 10_000 * 1e6);

        ElyraGuard guard = new ElyraGuard(deployer, delay);
        AgentRegistry registry = new AgentRegistry(guard);
        // testnet timings are short so people can try every path in one sitting
        AgentBond bond = new AgentBond(IERC20(address(tEly)), registry, guard, 1 hours);
        JobEscrow escrow = new JobEscrow(registry, bond, guard, 1 hours);
        CreditMeter meter = new CreditMeter(registry, guard, 1 hours);
        registry.setReporters(address(escrow), address(meter));
        bond.setEscrow(address(escrow));

        // testnet limits: large enough to simulate big jobs and jury appeals (mainnet year one starts at ~10 USDC per wallet)
        guard.setTokenCaps(address(tUsdc), 5_000 * 1e6, 50_000_000 * 1e6, 10_000 * 1e6);
        // smallest job 0.10 tUSDC, smallest fee 0.001 tUSDC: no dust jobs, no zero-fee jobs
        guard.setTokenMinimums(address(tUsdc), 1e5, 1e3);
        // a client must give an agent at least 1 hour (and never less than the confirmation window)
        guard.setMinJobDuration(1 hours);
        // resolver = the operator (Elyra Court), fees to the deployer, 1% fee, 100 tELY to be "verified", slash cap 1,000 tELY
        guard.setParams(operator, deployer, 100, 100 ether, 100_000 ether, 1_000 ether);
        // dispute rules: 1 tUSDC deposit, max 3 open disputes per client, suspension at ≥5 bad outcomes and >30% bad
        guard.setDisputeDeposit(address(tUsdc), 1e6);
        guard.setDisputeRules(3, 5, 3_000);
        if (guardianWallet != address(0)) guard.setGuardian(guardianWallet);
        // from here on: every parameter change is schedule → wait `delay` → execute. Pausing stays immediate.
        guard.finishSetup();
        vm.stopBroadcast();

        // ---- 2. the Elyra Agent Market agents, owned by the operator ----
        vm.startBroadcast(operator);
        tEly.faucet();
        tEly.approve(address(bond), AGENTS * AGENT_BOND);
        string[22] memory names = [
            "Elyra Demo - Summarizer", "Elyra Orchestrator", "Elyra Token Checker", "Elyra Code Reviewer", "Elyra KOL Checker",
            "Elyra Translator", "Elyra Tx Decoder", "Elyra Contract Inspector", "Elyra Wallet Profiler",
            "Elyra Approval Auditor", "Elyra Multisig Inspector", "Elyra NFT Checker", "Elyra Name Resolver", "Elyra Gas Advisor",
            "Elyra Tokenomics Analyst", "Elyra Governance Brief", "Elyra Audit Reader", "Elyra Test Writer", "Elyra Gas Optimizer",
            "Elyra FAQ Builder", "Elyra Announcer", "Elyra Verifier"
        ];
        string[22] memory services = [
            "summarize:en", "orchestrate:missions", "token-audit:erc20", "code-review:solidity", "kol-check:x",
            "translate:any", "tx-decode:ethereum", "contract-inspect:evm", "wallet-profile:ethereum",
            "approvals:ethereum", "multisig-inspect:safe", "nft-check:erc721", "ens-resolve:ethereum", "gas-advice:ethereum",
            "tokenomics:analysis", "governance:brief", "audit:explain", "tests:foundry", "gas-optimize:solidity",
            "faq:write", "announce:write", "verify:delivery"
        ];
        string[22] memory pricing = [
            "0.1 tUSDC/request", "2 tUSDC/mission", "0.4 tUSDC/report", "0.5 tUSDC/review", "0.5 tUSDC/profile",
            "0.1 tUSDC/text", "0.2 tUSDC/tx", "0.4 tUSDC/contract", "0.3 tUSDC/wallet",
            "0.4 tUSDC/wallet", "0.3 tUSDC/safe", "0.4 tUSDC/collection", "0.1 tUSDC/lookup", "0.1 tUSDC/check",
            "0.4 tUSDC/report", "0.3 tUSDC/brief", "0.4 tUSDC/report", "0.6 tUSDC/contract", "0.5 tUSDC/contract",
            "0.3 tUSDC/faq", "0.2 tUSDC/post", "0.3 tUSDC/check"
        ];
        for (uint256 i; i < AGENTS; i++) {
            uint256 id = registry.register(names[i], services[i], pricing[i], "https://elyraprotocol.com/testnet/market", bytes32(0), operator);
            bond.deposit(id, AGENT_BOND);
        }
        vm.stopBroadcast();

        console2.log("----- Elyra deployed on chain", block.chainid, "-----");
        console2.log("ElyraGuard:   ", address(guard));
        console2.log("AgentRegistry:", address(registry));
        console2.log("AgentBond:    ", address(bond));
        console2.log("JobEscrow:    ", address(escrow));
        console2.log("CreditMeter:  ", address(meter));
        console2.log("tELY:         ", address(tEly));
        console2.log("tUSDC:        ", address(tUsdc));
        console2.log("deploy block: ", block.number);
        console2.log("owner (timelocked, delay in seconds):", deployer, delay);
        console2.log("operator / resolver:", operator);
        console2.log("agents: #1 to #22, 100 tELY bond each");
    }
}

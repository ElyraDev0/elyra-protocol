// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentBond} from "../src/AgentBond.sol";
import {TestToken} from "../src/TestToken.sol";

/// @notice Completes the registration of the 22 Elyra Agent Market agents if Deploy.s.sol stopped halfway
///         (e.g. a transaction ran out of gas). Safe to run any number of times: an agent already registered by the
///         operator is not registered again, and only missing bonds are topped up to 100 tELY.
///         OPERATOR=0x... REGISTRY=0x... BOND=0x... TELY=0x... forge script script/FinishAgents.s.sol --rpc-url sepolia --broadcast --slow --interactives 1
contract FinishAgents is Script {
    uint256 constant AGENT_BOND = 100 ether;

    function run() external {
        address operator = vm.envAddress("OPERATOR");
        AgentRegistry registry = AgentRegistry(vm.envAddress("REGISTRY"));
        AgentBond bond = AgentBond(vm.envAddress("BOND"));
        TestToken tEly = TestToken(vm.envAddress("TELY"));
        require(address(registry).code.length > 0 && address(bond).code.length > 0, "REGISTRY or BOND has no code on this network");

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

        // what is already there
        uint256 count = registry.agentCount();
        uint256[22] memory idOf;
        for (uint256 id = 1; id <= count; id++) {
            AgentRegistry.Agent memory a = registry.getAgent(id);
            if (a.owner != operator) continue;
            for (uint256 i; i < 22; i++) if (idOf[i] == 0 && keccak256(bytes(a.name)) == keccak256(bytes(names[i]))) { idOf[i] = id; break; }
        }
        uint256 needed;
        for (uint256 i; i < 22; i++) { uint256 b = idOf[i] == 0 ? 0 : bond.bondOf(idOf[i]); if (b < AGENT_BOND) needed += AGENT_BOND - b; }
        console2.log("tELY still to bond:", needed / 1 ether);

        vm.startBroadcast(operator);
        if (needed > 0) {
            if (tEly.balanceOf(operator) < needed) tEly.faucet();
            if (tEly.allowance(operator, address(bond)) < needed) tEly.approve(address(bond), needed);
        }
        for (uint256 i; i < 22; i++) {
            if (idOf[i] == 0) {
                idOf[i] = registry.register(names[i], services[i], pricing[i], "https://elyraprotocol.com/testnet/market", bytes32(0), operator);
                console2.log("registered", names[i], idOf[i]);
            }
            uint256 b = bond.bondOf(idOf[i]);
            if (b < AGENT_BOND) { bond.deposit(idOf[i], AGENT_BOND - b); console2.log("bonded", names[i], idOf[i]); }
        }
        vm.stopBroadcast();
        console2.log("all 22 Elyra agents registered and bonded");
    }
}

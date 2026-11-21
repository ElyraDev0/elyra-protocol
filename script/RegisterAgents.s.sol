// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentBond} from "../src/AgentBond.sol";
import {TestToken} from "../src/TestToken.sol";

/// @notice TESTNET ONLY. Registers the Elyra Agent Market demo agents (AI agents run by the Elyra team) and bonds
///         each one with 100 tELY, so the market opens with real, bonded agents that deliver real work.
///         REGISTRY=0x... BOND=0x... TELY=0x... forge script script/RegisterAgents.s.sol --rpc-url <sepolia rpc> --broadcast --slow
contract RegisterAgents is Script {
    function run() external {
        require(block.chainid == 11155111 || block.chainid == 2700, "Testnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        AgentRegistry registry = AgentRegistry(vm.envAddress("REGISTRY"));
        AgentBond bond = AgentBond(vm.envAddress("BOND"));
        TestToken tEly = TestToken(vm.envAddress("TELY"));
        address me = vm.addr(pk);

        string[8] memory names = ["Elyra Orchestrator", "Elyra Token Checker", "Elyra Code Reviewer", "Elyra KOL Checker", "Elyra Translator", "Elyra Tx Decoder", "Elyra Contract Inspector", "Elyra Wallet Profiler"];
        string[8] memory services = ["orchestrate:missions", "token-audit:erc20", "code-review:solidity", "kol-check:x", "translate:any", "tx-decode:ethereum", "contract-inspect:evm", "wallet-profile:ethereum"];
        string[8] memory pricing = ["6 tUSDC/mission", "4 tUSDC/report", "3 tUSDC/review", "5 tUSDC/profile", "1 tUSDC/text", "2 tUSDC/tx", "3 tUSDC/contract", "3 tUSDC/wallet"];

        vm.startBroadcast(pk);
        tEly.approve(address(bond), 800 ether);
        for (uint256 i; i < 8; i++) {
            uint256 id = registry.register(names[i], services[i], pricing[i], "https://elyraprotocol.com/testnet/market", bytes32(0), me);
            bond.deposit(id, 100 ether);
            console2.log(names[i], "-> agent id", id);
        }
        vm.stopBroadcast();
    }
}

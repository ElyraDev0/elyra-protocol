// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentBond} from "../src/AgentBond.sol";
import {TestToken} from "../src/TestToken.sol";

/// @notice TESTNET ONLY. Second wave of Elyra Agent Market agents (13 new skills), each bonded with 100 tELY.
///         REGISTRY=0x... BOND=0x... TELY=0x... forge script script/RegisterAgentsV2.s.sol --rpc-url <sepolia rpc> --broadcast --slow
contract RegisterAgentsV2 is Script {
    function run() external {
        require(block.chainid == 11155111 || block.chainid == 2700, "Testnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        AgentRegistry registry = AgentRegistry(vm.envAddress("REGISTRY"));
        AgentBond bond = AgentBond(vm.envAddress("BOND"));
        TestToken tEly = TestToken(vm.envAddress("TELY"));
        address me = vm.addr(pk);

        string[13] memory names = ["Elyra Approval Auditor", "Elyra Multisig Inspector", "Elyra NFT Checker", "Elyra Name Resolver", "Elyra Gas Advisor", "Elyra Tokenomics Analyst", "Elyra Governance Brief", "Elyra Audit Reader", "Elyra Test Writer", "Elyra Gas Optimizer", "Elyra FAQ Builder", "Elyra Announcer", "Elyra Verifier"];
        string[13] memory services = ["approvals:ethereum", "multisig-inspect:safe", "nft-check:erc721", "ens-resolve:ethereum", "gas-advice:ethereum", "tokenomics:analysis", "governance:brief", "audit:explain", "tests:foundry", "gas-optimize:solidity", "faq:write", "announce:write", "verify:delivery"];
        string[13] memory pricing = ["0.4 tUSDC/wallet", "0.3 tUSDC/safe", "0.4 tUSDC/collection", "0.1 tUSDC/lookup", "0.1 tUSDC/check", "0.4 tUSDC/report", "0.3 tUSDC/brief", "0.4 tUSDC/report", "0.6 tUSDC/contract", "0.5 tUSDC/contract", "0.3 tUSDC/faq", "0.2 tUSDC/post", "0.3 tUSDC/check"];

        vm.startBroadcast(pk);
        if (tEly.balanceOf(me) < 1300 ether) { try tEly.faucet() {} catch {} }
        require(tEly.balanceOf(me) >= 1300 ether, "Need 1,300 tELY for the bonds: claim the tELY faucet first");
        tEly.approve(address(bond), 1300 ether);
        for (uint256 i; i < 13; i++) {
            uint256 id = registry.register(names[i], services[i], pricing[i], "https://elyraprotocol.com/testnet/market", bytes32(0), me);
            bond.deposit(id, 100 ether);
            console2.log(names[i], "-> agent id", id);
        }
        vm.stopBroadcast();
    }
}

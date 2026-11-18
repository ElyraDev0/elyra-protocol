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

/// @notice Deploys the whole Elyra protocol on a TESTNET with test tokens, wires it and registers one demo agent.
///         Sepolia:          forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --verify
///         Orbinum testnet:  forge script script/Deploy.s.sol --rpc-url orbinum_testnet --broadcast
///                           (then verify on Sourcify, see docs/ORBINUM.md)
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        // testnets only: this script deploys TEST tokens. Sepolia (11155111) or Orbinum testnet (2700)
        require(block.chainid == 11155111 || block.chainid == 2700, "Testnet only: Sepolia or Orbinum testnet");
        vm.startBroadcast(pk);

        TestToken tEly = new TestToken("Elyra Test ELY", "tELY", 18, 5_000 ether);
        TestToken tUsdc = new TestToken("Elyra Test USDC", "tUSDC", 6, 1_000 * 1e6);

        ElyraGuard guard = new ElyraGuard(me);
        AgentRegistry registry = new AgentRegistry(guard);
        // testnet timings are short so people can try every path in one sitting
        AgentBond bond = new AgentBond(IERC20(address(tEly)), registry, guard, 1 hours);
        JobEscrow escrow = new JobEscrow(registry, bond, guard, 1 hours);
        CreditMeter meter = new CreditMeter(registry, guard, 1 hours);

        registry.setReporters(address(escrow), address(meter));
        bond.setEscrow(address(escrow));

        // caps (same shape as the planned mainnet year one): 10 tUSDC per job, 10 tUSDC at stake per wallet, 20k in total
        guard.setTokenCaps(address(tUsdc), 10 * 1e6, 20_000 * 1e6, 10 * 1e6);
        guard.setParams(me, me, 100, 100 ether, 100_000 ether, 1_000 ether);
        // automatic dispute rules: 0.50 tUSDC to open a dispute, max 3 open per client,
        // agents suspended with at least 5 bad outcomes AND more than 30% bad
        guard.setDisputeDeposit(address(tUsdc), 5e5);
        guard.setDisputeRules(3, 5, 3_000);
        // the monitor's wallet: it can only switch the pause ON (optional: GUARDIAN in .env)
        address guardianWallet = vm.envOr("GUARDIAN", address(0));
        if (guardianWallet != address(0)) guard.setGuardian(guardianWallet);

        // one demo agent owned by the deployer, with a bond
        uint256 demo = registry.register("Elyra Demo - Summarizer", "summarize:en", "1 tUSDC/request", "https://elyraprotocol.com/agents/demo", bytes32(0), me);
        tEly.faucet();
        tEly.approve(address(bond), 1_000 ether);
        bond.deposit(demo, 1_000 ether);

        vm.stopBroadcast();

        console2.log("----- Elyra deployed on chain", block.chainid, "-----");
        console2.log("agentRegistry:", address(registry));
        console2.log("jobEscrow:    ", address(escrow));
        console2.log("agentBond:    ", address(bond));
        console2.log("creditMeter:  ", address(meter));
        console2.log("guard:        ", address(guard));
        console2.log("tELY:         ", address(tEly));
        console2.log("tUSDC:        ", address(tUsdc));
        console2.log("demo agent id:", demo);
    }
}

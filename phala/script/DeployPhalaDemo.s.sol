// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ElyraGuard} from "../../src/ElyraGuard.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {AgentBond} from "../../src/AgentBond.sol";
import {JobEscrow} from "../../src/JobEscrow.sol";
import {TestToken} from "../../src/TestToken.sol";
import {ElyraCourt} from "../contracts/ElyraCourt.sol";
import {TeeBadgeRegistry} from "../contracts/TeeBadgeRegistry.sol";

/// @notice LOCAL DEMO (anvil): the Elyra protocol + ElyraCourt + TeeBadgeRegistry, one agent, one disputed job.
///         env: JUDGE (address printed by the judge), DEPLOYER_KEY, AGENT_KEY, CLIENT_KEY, TASK_TEXT, RESULT_TEXT
contract DeployPhalaDemo is Script {
    function run() external {
        address judge = vm.envAddress("JUDGE");
        uint256 dk = vm.envUint("DEPLOYER_KEY"); uint256 ak = vm.envUint("AGENT_KEY"); uint256 ck = vm.envUint("CLIENT_KEY");
        address deployer = vm.addr(dk);

        vm.startBroadcast(dk);
        TestToken ely = new TestToken("tELY", "tELY", 18, 5_000 ether);
        TestToken usdc = new TestToken("tUSDC", "tUSDC", 6, 10_000e6);
        ElyraGuard guard = new ElyraGuard(deployer);
        AgentRegistry reg = new AgentRegistry(guard);
        AgentBond bond = new AgentBond(IERC20(address(ely)), reg, guard, 1 hours);
        JobEscrow esc = new JobEscrow(reg, bond, guard, 1 hours);
        reg.setReporters(address(esc), deployer);
        bond.setEscrow(address(esc));
        guard.setTokenCaps(address(usdc), 5_000e6, 50_000_000e6, 10_000e6);
        address[] memory p = new address[](1); p[0] = deployer;
        address[] memory e = new address[](1); e[0] = address(0);
        TimelockController tl = new TimelockController(2 days, p, e, address(0));
        ElyraCourt court = new ElyraCourt(esc, guard, address(tl), judge, bytes32(0), "local-demo");
        TeeBadgeRegistry badges = new TeeBadgeRegistry(reg, court);
        guard.setParams(address(court), deployer, 100, 100 ether, 50_000 ether, 1_000 ether);
        guard.setDisputeDeposit(address(usdc), 1e6);
        payable(judge).transfer(1 ether);                       // gas for the judge key
        vm.stopBroadcast();

        vm.startBroadcast(ak);
        uint256 agentId = reg.register("Sentinel (demo)", "token", "10 tUSDC", "", 0, address(0));
        ely.faucet(); ely.approve(address(bond), type(uint256).max); bond.deposit(agentId, 1_000 ether);
        vm.stopBroadcast();

        vm.startBroadcast(ck);
        usdc.faucet(); usdc.approve(address(esc), type(uint256).max);
        uint256 jobId = esc.openJob(agentId, address(usdc), 10e6, uint64(block.timestamp + 1 days), keccak256(bytes(vm.envString("TASK_TEXT"))));
        vm.stopBroadcast();

        vm.broadcast(ak);
        esc.deliver(jobId, keccak256(bytes(vm.envString("RESULT_TEXT"))));
        vm.broadcast(ck);
        esc.dispute(jobId);

        console.log("ESCROW", address(esc));
        console.log("COURT", address(court));
        console.log("BADGES", address(badges));
        console.log("REGISTRY", address(reg));
        console.log("BOND", address(bond));
        console.log("AGENT_ID", agentId);
        console.log("JOB_ID", jobId);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ElyraGuard} from "../src/ElyraGuard.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentBond} from "../src/AgentBond.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {TestToken} from "../src/TestToken.sol";

/// @notice The patterns the testnet Agent Market relies on: agents hiring agents, operator-run agents that pay
///         their users, micro-payments, "silence means acceptance", court splits and larger simulated jobs.
contract MarketplaceTest is Test {
    TestToken ely; TestToken usdc;
    ElyraGuard guard; AgentRegistry reg; AgentBond bond; JobEscrow esc;
    address resolverAddr = makeAddr("resolver");
    address treasury = makeAddr("treasury");
    address client = makeAddr("client");
    address operator = makeAddr("operator");       // runs agents for others (managed agents)
    address user = makeAddr("user");               // owns the earnings of a managed agent
    address orchOwner = makeAddr("orchestrator");
    uint256 orch; uint256 tokenChecker; uint256 kolChecker; uint256 userAgent;

    function setUp() public {
        ely = new TestToken("tELY", "tELY", 18, 5_000 ether);
        usdc = new TestToken("tUSDC", "tUSDC", 6, 10_000e6);
        guard = new ElyraGuard(address(this), 1 hours);
        reg = new AgentRegistry(guard);
        bond = new AgentBond(IERC20(address(ely)), reg, guard, 1 hours);
        esc = new JobEscrow(reg, bond, guard, 1 hours);
        reg.setReporters(address(esc), makeAddr("creditMeter"));
        bond.setEscrow(address(esc));
        guard.setTokenCaps(address(usdc), 5_000e6, 50_000_000e6, 10_000e6);
        guard.setParams(resolverAddr, treasury, 100, 100 ether, 50_000 ether, 1_000 ether);
        guard.setDisputeDeposit(address(usdc), 1e6);

        vm.prank(orchOwner); orch = reg.register("Elyra Orchestrator", "orchestrate", "2 tUSDC", "", 0, address(0));
        vm.startPrank(operator);
        tokenChecker = reg.register("Elyra Token Checker", "token", "0.4 tUSDC", "", 0, address(0));
        kolChecker = reg.register("Elyra KOL Checker", "kol", "0.5 tUSDC", "", 0, address(0));
        userAgent = reg.register("Nova", "explain", "0.2 tUSDC", "", 0, user);     // run by the operator, pays the user
        vm.stopPrank();

        for (uint256 i; i < 2; i++) {
            address a = i == 0 ? client : orchOwner;
            vm.prank(a); usdc.faucet();
            vm.prank(a); usdc.approve(address(esc), type(uint256).max);
        }
    }

    function _open(address from, uint256 agentId, uint256 amount) internal returns (uint256 id) {
        vm.prank(from);
        id = esc.openJob(agentId, address(usdc), amount, uint64(vm.getBlockTimestamp() + 1 days), keccak256("spec"));
    }
    function _deliver(address by, uint256 id) internal { vm.prank(by); esc.deliver(id, keccak256("result")); }

    // ---------------- agents hiring agents ----------------
    /// The Orchestrator is paid 2 tUSDC, hires two agents with 75% of it at most, and ends with a profit.
    function test_orchestrator_hires_agents_within_budget() public {
        uint256 mission = _open(client, orch, 2e6);
        uint256 a = _open(orchOwner, tokenChecker, 0.4e6);
        uint256 b = _open(orchOwner, kolChecker, 0.5e6);
        _deliver(operator, a); _deliver(operator, b);
        vm.startPrank(orchOwner); esc.release(a); esc.release(b); vm.stopPrank();
        _deliver(orchOwner, mission);
        vm.prank(client); esc.release(mission);

        uint256 spent = 0.4e6 + 0.5e6;
        assertLe(spent, 2e6 * 75 / 100);
        assertEq(usdc.balanceOf(orchOwner), 10_000e6 - spent + 1.98e6);            // 2 tUSDC minus the 1% fee
        assertEq(usdc.balanceOf(operator), 0.396e6 + 0.495e6);
        assertEq(usdc.balanceOf(client) + usdc.balanceOf(orchOwner) + usdc.balanceOf(operator) + usdc.balanceOf(treasury), 20_000e6);
        assertEq(usdc.balanceOf(address(esc)), 0);
        (uint64 done,,,) = reg.reputationOf(orch);
        assertEq(done, 1);
    }

    /// An agent's client can be another agent's owner: reputation follows each agent separately.
    function test_sub_jobs_build_each_agents_reputation() public {
        uint256 a = _open(orchOwner, tokenChecker, 0.4e6);
        _deliver(operator, a);
        vm.prank(orchOwner); esc.release(a);
        (uint64 tc,,,) = reg.reputationOf(tokenChecker);
        (uint64 oc,,,) = reg.reputationOf(orch);
        assertEq(tc, 1); assertEq(oc, 0);
        assertEq(esc.completedAsClient(orchOwner), 1);
    }

    // ---------------- managed agents ----------------
    /// An agent run by an operator pays its user, not the operator; only the operator (owner) can deliver.
    function test_managed_agent_pays_its_user() public {
        uint256 id = _open(client, userAgent, 0.2e6);
        vm.prank(user); vm.expectRevert(JobEscrow.NotAllowed.selector); esc.deliver(id, 0);
        _deliver(operator, id);
        vm.prank(client); esc.release(id);
        assertEq(usdc.balanceOf(user), 0.198e6);
        assertEq(usdc.balanceOf(operator), 0);
        assertEq(reg.payoutOf(userAgent), user);
        assertEq(reg.ownerOf(userAgent), operator);
    }

    // ---------------- silence means acceptance ----------------
    function test_dispute_window_then_anyone_pays_the_agent() public {
        uint256 id = _open(client, tokenChecker, 0.4e6);
        _deliver(operator, id);
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        vm.prank(client); vm.expectRevert(JobEscrow.TooLate.selector); esc.dispute(id);
        esc.release(id);                                                             // any address, e.g. the market's keeper
        assertEq(usdc.balanceOf(operator), 0.396e6);
        assertEq(esc.lockedOf(address(usdc)), 0);
    }

    // ---------------- the Elyra Court ----------------
    /// A split ruling (50/50) settles the job and the deposit, and nothing stays in escrow.
    function test_court_split_ruling_settles_everything() public {
        uint256 id = _open(client, tokenChecker, 4e6);
        _deliver(operator, id);
        vm.prank(client); esc.dispute(id);
        vm.prank(resolverAddr); esc.resolve(id, 5_000, 0, keccak256("AI judge: partial delivery"));
        assertEq(usdc.balanceOf(client) + usdc.balanceOf(operator) + usdc.balanceOf(treasury), 10_000e6);
        assertEq(usdc.balanceOf(address(esc)), 0);
        assertGt(usdc.balanceOf(operator), 0);
        assertLt(usdc.balanceOf(client), 10_000e6);
    }

    /// Only the court's resolver can rule.
    function test_only_resolver_rules() public {
        uint256 id = _open(client, tokenChecker, 4e6);
        _deliver(operator, id);
        vm.prank(client); esc.dispute(id);
        vm.prank(operator); vm.expectRevert(JobEscrow.NotAllowed.selector); esc.resolve(id, 0, 0, 0);
    }

    // ---------------- larger simulated jobs (to exercise juries on testnet) ----------------
    function test_large_jobs_up_to_the_cap() public {
        _open(client, tokenChecker, 5_000e6);
        vm.prank(orchOwner); vm.expectRevert(JobEscrow.CapExceeded.selector);
        esc.openJob(tokenChecker, address(usdc), 5_000e6 + 1, uint64(vm.getBlockTimestamp() + 1 days), 0);
    }

    // ---------------- fuzz: micro-payments never lose a unit ----------------
    function testFuzz_micro_jobs_conserve(uint32 raw) public {
        uint256 amount = bound(uint256(raw), 1, 3e6);                               // up to 3 tUSDC, down to 1 unit
        uint256 id = _open(client, userAgent, amount);
        _deliver(operator, id);
        vm.prank(client); esc.release(id);
        uint256 fee = amount * 100 / 10_000;
        assertEq(usdc.balanceOf(user), amount - fee);
        assertEq(usdc.balanceOf(user) + usdc.balanceOf(treasury), amount);
        assertEq(usdc.balanceOf(address(esc)), 0);
    }

    /// Whatever the ruling, client + agent + treasury always hold exactly what was there before.
    function testFuzz_court_rulings_conserve(uint32 raw, uint16 bps) public {
        uint256 amount = bound(uint256(raw), 1, 3e6);
        uint16 clientBps = uint16(bound(uint256(bps), 0, 10_000));
        uint256 id = _open(client, tokenChecker, amount);
        _deliver(operator, id);
        vm.prank(client); esc.dispute(id);
        vm.prank(resolverAddr); esc.resolve(id, clientBps, 0, 0);
        assertEq(usdc.balanceOf(client) + usdc.balanceOf(operator) + usdc.balanceOf(treasury), 10_000e6);
        assertEq(usdc.balanceOf(address(esc)), 0);
        assertEq(esc.lockedOf(address(usdc)), 0);
    }
}

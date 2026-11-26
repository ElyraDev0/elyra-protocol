// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ElyraGuard} from "../src/ElyraGuard.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentBond} from "../src/AgentBond.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {CreditMeter} from "../src/CreditMeter.sol";
import {TestToken} from "../src/TestToken.sol";

/// @notice Regression tests for the issues reported privately before the public testnet:
///         (1) dust jobs with 1-second deadlines forcing refunds and suspensions, (2) fees rounding to zero on tiny
///         amounts (free reputation farming) — reported by bai bo; (3) owner-key risk: timelocked parameters,
///         hard slash cap, resolver separate from the owner.
contract SecurityTest is Test {
    TestToken ely; TestToken usdc;
    ElyraGuard guard; AgentRegistry reg; AgentBond bond; JobEscrow esc; CreditMeter meter;
    address owner = address(this);
    address agentOwner = makeAddr("agentOwner");
    uint256 clientPk = 0xC11E47;
    address client;
    address resolverAddr = makeAddr("resolver");
    address treasury = makeAddr("treasury");
    address attacker = makeAddr("attacker");
    uint256 agentId;

    function setUp() public {
        client = vm.addr(clientPk);
        ely = new TestToken("tELY", "tELY", 18, 5_000 ether);
        usdc = new TestToken("tUSDC", "tUSDC", 6, 1_000e6);
        guard = new ElyraGuard(owner, 1 hours);
        reg = new AgentRegistry(guard);
        bond = new AgentBond(IERC20(address(ely)), reg, guard, 1 hours);
        esc = new JobEscrow(reg, bond, guard, 1 hours);
        meter = new CreditMeter(reg, guard, 1 hours);
        reg.setReporters(address(esc), address(meter));
        bond.setEscrow(address(esc));
        guard.setTokenCaps(address(usdc), 500e6, 10_000e6, 0);
        guard.setParams(resolverAddr, treasury, 100, 100 ether, 50_000 ether, 1_000 ether);
        guard.setTokenMinimums(address(usdc), 1e6, 0.01e6);   // 1 tUSDC minimum job, 0.01 tUSDC minimum fee
        guard.setMinJobDuration(2 hours);
        guard.setDisputeRules(3, 5, 3_000);

        vm.prank(agentOwner);
        agentId = reg.register("Translator", "translate:en-de", "1 USDC/page", "ipfs://x", bytes32(0), address(0));
        for (uint256 i; i < 2; i++) {
            address w = i == 0 ? client : attacker;
            vm.prank(w); usdc.faucet();
            vm.prank(w); usdc.approve(address(esc), type(uint256).max);
            vm.prank(w); usdc.approve(address(meter), type(uint256).max);
        }
    }

    function _now() internal view returns (uint64) { return uint64(vm.getBlockTimestamp()); }

    // ---------- (1) dust jobs and short deadlines ----------
    function test_one_second_deadline_rejected() public {
        vm.prank(attacker); vm.expectRevert(JobEscrow.BadInput.selector);
        esc.openJob(agentId, address(usdc), 1e6, _now() + 1, bytes32(0));
    }
    function test_deadline_never_shorter_than_confirm_window() public {
        guard.setMinJobDuration(0);
        assertEq(esc.minDuration(), 1 hours);
        vm.prank(attacker); vm.expectRevert(JobEscrow.BadInput.selector);
        esc.openJob(agentId, address(usdc), 1e6, _now() + 1 hours - 1, bytes32(0));
        vm.prank(client);
        esc.openJob(agentId, address(usdc), 1e6, _now() + 1 hours, bytes32(0));
    }
    function test_guard_min_duration_applies_when_longer() public {
        assertEq(esc.minDuration(), 2 hours);
        vm.prank(attacker); vm.expectRevert(JobEscrow.BadInput.selector);
        esc.openJob(agentId, address(usdc), 1e6, _now() + 1 hours, bytes32(0));
    }
    function test_dust_job_rejected() public {
        vm.prank(attacker); vm.expectRevert(JobEscrow.TooSmall.selector);
        esc.openJob(agentId, address(usdc), 99, _now() + 1 days, bytes32(0));
    }
    function test_dust_credit_deposit_rejected() public {
        vm.prank(attacker); vm.expectRevert(CreditMeter.BadInput.selector);
        meter.deposit(agentId, address(usdc), 99);
    }
    function test_griefing_refunds_need_real_time_and_money() public {
        // the agent gets at least 2 hours; the attacker must lock 1 tUSDC per job and wait
        vm.prank(attacker);
        uint256 id = esc.openJob(agentId, address(usdc), 1e6, _now() + 2 hours, bytes32(0));
        vm.prank(attacker); vm.expectRevert(JobEscrow.TooEarly.selector);
        esc.refund(id);
        vm.prank(agentOwner); esc.deliver(id, keccak256("done in time"));
        vm.prank(attacker); vm.expectRevert(JobEscrow.WrongStatus.selector);
        esc.refund(id);
    }

    // ---------- (2) fees never round to zero ----------
    function test_min_fee_on_small_job() public {
        vm.prank(client);
        uint256 id = esc.openJob(agentId, address(usdc), 1e6, _now() + 1 days, bytes32(0));
        vm.prank(agentOwner); esc.deliver(id, bytes32(0));
        vm.prank(client); esc.release(id);
        assertEq(usdc.balanceOf(treasury), 0.01e6);          // 1% of 1 tUSDC = 0.01: equals the floor
        assertEq(usdc.balanceOf(agentOwner), 0.99e6);
    }
    function test_min_fee_beats_rounding() public {
        guard.setTokenMinimums(address(usdc), 1e6, 0.05e6);
        vm.prank(client);
        uint256 id = esc.openJob(agentId, address(usdc), 1e6, _now() + 1 days, bytes32(0));
        vm.prank(agentOwner); esc.deliver(id, bytes32(0));
        vm.prank(client); esc.release(id);
        assertEq(usdc.balanceOf(treasury), 0.05e6);
    }
    function test_min_fee_fixed_at_open() public {
        vm.prank(client);
        uint256 id = esc.openJob(agentId, address(usdc), 1e6, _now() + 1 days, bytes32(0));
        guard.setTokenMinimums(address(usdc), 1e6, 1e6);    // raised later: does not touch the open job
        vm.prank(agentOwner); esc.deliver(id, bytes32(0));
        vm.prank(client); esc.release(id);
        assertEq(usdc.balanceOf(treasury), 0.01e6);
    }
    function test_fee_math_bounds() public view {
        assertEq(esc.feeOf(99, 100, 0), 0);                  // what used to happen
        assertEq(esc.feeOf(99, 100, 10), 10);                // the floor applies
        assertEq(esc.feeOf(5, 100, 10), 5);                  // never above the amount
        assertEq(esc.feeOf(100e6, 100, 0.01e6), 1e6);        // big jobs: the % fee
    }
    function test_min_fee_on_credit_settlement() public {
        vm.prank(client); meter.deposit(agentId, address(usdc), 2e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(clientPk, meter.voucherDigest(client, agentId, address(usdc), 0, 100));
        vm.prank(agentOwner); meter.settle(client, agentId, address(usdc), 100, abi.encodePacked(r, s, v));
        assertEq(usdc.balanceOf(treasury), 100);             // the whole micro-settlement goes to the fee
        assertEq(usdc.balanceOf(agentOwner), 0);
    }
    function test_min_fee_cannot_exceed_min_amount() public {
        vm.expectRevert(ElyraGuard.BadInput.selector);
        guard.setTokenMinimums(address(usdc), 1e6, 2e6);
    }

    // ---------- (3) owner-key risk ----------
    function test_slash_cap_is_hard_coded() public {
        vm.expectRevert(ElyraGuard.SlashCapTooHigh.selector);
        guard.setParams(resolverAddr, treasury, 100, 100 ether, 50_000 ether, 1_001 ether);
    }
    function test_delay_has_a_floor() public {
        vm.expectRevert(ElyraGuard.BadInput.selector);
        new ElyraGuard(owner, 59 minutes);
    }
    function test_after_setup_owner_cannot_change_directly() public {
        guard.finishSetup();
        vm.expectRevert(ElyraGuard.NotOwner.selector);
        guard.setParams(owner, owner, 500, 1, 1, 1_000 ether);
        vm.expectRevert(ElyraGuard.NotOwner.selector);
        guard.setTokenCaps(address(usdc), 1, 1, 1);
        vm.expectRevert(ElyraGuard.NotOwner.selector);
        guard.setTokenMinimums(address(usdc), 0, 0);
        vm.expectRevert(ElyraGuard.NotOwner.selector);
        guard.setMinJobDuration(0);
        vm.expectRevert(ElyraGuard.NotOwner.selector);
        guard.setGuardian(attacker);
    }
    function test_timelocked_change_waits_for_delay() public {
        guard.finishSetup();
        address newResolver = makeAddr("court");
        bytes memory data = abi.encodeCall(ElyraGuard.setParams, (newResolver, treasury, 200, 100 ether, 50_000 ether, 500 ether));
        guard.schedule(data);
        vm.expectRevert(ElyraGuard.TooEarly.selector);
        guard.execute(data);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        guard.execute(data);
        assertEq(guard.resolver(), newResolver);
        assertEq(guard.feeBps(), 200);
        vm.expectRevert(ElyraGuard.NotScheduled.selector);  // one schedule, one execution
        guard.execute(data);
    }
    function test_timelock_respects_hard_limits() public {
        guard.finishSetup();
        bytes memory data = abi.encodeCall(ElyraGuard.setParams, (resolverAddr, treasury, 600, 100 ether, 50_000 ether, 1_000 ether));
        guard.schedule(data);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.expectRevert(ElyraGuard.CallFailed.selector);
        guard.execute(data);
    }
    function test_scheduled_change_expires_and_can_be_cancelled() public {
        guard.finishSetup();
        bytes memory data = abi.encodeCall(ElyraGuard.setMinJobDuration, (3 hours));
        bytes32 id = guard.schedule(data);
        guard.cancel(id);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        vm.expectRevert(ElyraGuard.NotScheduled.selector);
        guard.execute(data);
        guard.schedule(data);
        vm.warp(vm.getBlockTimestamp() + 1 hours + 14 days + 1);
        vm.expectRevert(ElyraGuard.Expired.selector);
        guard.execute(data);
    }
    function test_only_owner_schedules_and_executes() public {
        guard.finishSetup();
        bytes memory data = abi.encodeCall(ElyraGuard.setMinJobDuration, (3 hours));
        vm.prank(attacker); vm.expectRevert(ElyraGuard.NotOwner.selector);
        guard.schedule(data);
        guard.schedule(data);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(attacker); vm.expectRevert(ElyraGuard.NotOwner.selector);
        guard.execute(data);
        vm.prank(attacker); vm.expectRevert(ElyraGuard.NotOwner.selector);
        guard.finishSetup();
    }
    function test_pause_stays_immediate_after_setup() public {
        guard.finishSetup();
        guard.setPaused(true);
        assertTrue(guard.paused());
        vm.prank(client); vm.expectRevert(JobEscrow.Paused.selector);
        esc.openJob(agentId, address(usdc), 1e6, _now() + 1 days, bytes32(0));
    }
    function test_resolver_is_not_the_owner() public view {
        assertEq(guard.resolver(), resolverAddr);
        assertTrue(guard.resolver() != guard.owner());
    }
    function test_owner_cannot_resolve() public {
        vm.prank(client);
        uint256 id = esc.openJob(agentId, address(usdc), 10e6, _now() + 1 days, bytes32(0));
        vm.prank(agentOwner); esc.deliver(id, bytes32(0));
        vm.prank(client); esc.dispute(id);
        vm.expectRevert(JobEscrow.NotAllowed.selector);      // msg.sender is the owner here
        esc.resolve(id, 10_000, 0, bytes32(0));
    }
}

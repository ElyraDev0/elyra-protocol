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

contract ElyraTest is Test {
    TestToken ely; TestToken usdc;
    ElyraGuard guard; AgentRegistry reg; AgentBond bond; JobEscrow esc; CreditMeter meter;
    address owner = address(this);
    address agentOwner = makeAddr("agentOwner");
    uint256 clientPk = 0xC11E47;
    address client;
    address resolverAddr = makeAddr("resolver");
    address treasury = makeAddr("treasury");
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

        vm.prank(agentOwner);
        agentId = reg.register("Translator", "translate:en-de", "0.5 USDC/page", "ipfs://x", bytes32(0), address(0));
        vm.prank(client); usdc.faucet();
        vm.prank(client); usdc.approve(address(esc), type(uint256).max);
        vm.prank(client); usdc.approve(address(meter), type(uint256).max);
        vm.prank(agentOwner); ely.faucet();
        vm.prank(agentOwner); ely.approve(address(bond), type(uint256).max);
    }

    function _open(uint256 amount) internal returns (uint256 id) {
        vm.prank(client);
        id = esc.openJob(agentId, address(usdc), amount, uint64(vm.getBlockTimestamp() + 1 days), keccak256("spec"));
    }

    // ---------------- registry ----------------
    function test_register_counts() public view {
        assertEq(reg.agentCountOf(agentOwner), 1);
        assertEq(reg.latestAgentOf(agentOwner), agentId);
        assertEq(reg.ownerOf(agentId), agentOwner);
        assertEq(reg.payoutOf(agentId), agentOwner);
    }
    function test_only_owner_updates() public {
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        reg.setActive(agentId, false);
    }
    function test_reputation_not_writable_by_others() public {
        vm.expectRevert(AgentRegistry.NotReporter.selector);
        reg.record(agentId, 1, 100);
    }

    // ---------------- escrow: happy path ----------------
    function test_job_release_pays_agent_minus_fee() public {
        uint256 id = _open(50e6);
        assertEq(esc.openJobsOf(agentId), 1);
        vm.prank(agentOwner); esc.deliver(id, keccak256("result"));
        vm.prank(client); esc.release(id);
        assertEq(usdc.balanceOf(agentOwner), 49.5e6);
        assertEq(usdc.balanceOf(treasury), 0.5e6);
        assertEq(esc.completedAsClient(client), 1);
        assertEq(esc.openJobsOf(agentId), 0);
        assertEq(esc.lockedOf(address(usdc)), 0);
        (uint64 completed,,, uint128 earned) = reg.reputationOf(agentId);
        assertEq(completed, 1); assertEq(earned, 49.5e6);
    }
    function test_anyone_releases_after_window() public {
        uint256 id = _open(50e6);
        vm.prank(agentOwner); esc.deliver(id, keccak256("r"));
        vm.expectRevert(JobEscrow.TooEarly.selector);
        esc.release(id);
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        esc.release(id);
        assertEq(usdc.balanceOf(agentOwner), 49.5e6);
    }
    function test_fee_fixed_at_open() public {
        uint256 id = _open(100e6);
        guard.setParams(resolverAddr, treasury, 500, 100 ether, 50_000 ether, 1_000 ether);
        vm.prank(agentOwner); esc.deliver(id, bytes32(0));
        vm.prank(client); esc.release(id);
        assertEq(usdc.balanceOf(treasury), 1e6); // still 1%
    }

    // ---------------- escrow: refund ----------------
    function test_refund_after_deadline() public {
        uint256 id = _open(50e6);
        vm.prank(client); vm.expectRevert(JobEscrow.TooEarly.selector); esc.refund(id);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.prank(client); esc.refund(id);
        assertEq(usdc.balanceOf(client), 1_000e6);
        vm.prank(agentOwner); vm.expectRevert(JobEscrow.WrongStatus.selector); esc.deliver(id, bytes32(0));
    }
    function test_late_delivery_rejected() public {
        uint256 id = _open(50e6);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.prank(agentOwner); vm.expectRevert(JobEscrow.TooLate.selector); esc.deliver(id, bytes32(0));
    }

    // ---------------- caps & pause ----------------
    function test_job_cap() public {
        vm.prank(client); vm.expectRevert(JobEscrow.CapExceeded.selector);
        esc.openJob(agentId, address(usdc), 501e6, uint64(vm.getBlockTimestamp() + 1 days), 0);
    }
    function test_unknown_token_rejected() public {
        vm.prank(client); vm.expectRevert(JobEscrow.CapExceeded.selector);
        esc.openJob(agentId, address(ely), 1 ether, uint64(vm.getBlockTimestamp() + 1 days), 0);
    }
    function test_pause_blocks_new_jobs_but_not_refunds_or_releases() public {
        uint256 a = _open(50e6);
        uint256 b = _open(50e6);
        guard.setPaused(true);
        vm.prank(client); vm.expectRevert(JobEscrow.Paused.selector);
        esc.openJob(agentId, address(usdc), 1e6, uint64(vm.getBlockTimestamp() + 1 days), 0);
        vm.prank(agentOwner); esc.deliver(a, 0);
        vm.prank(client); esc.release(a);                 // still works
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.prank(client); esc.refund(b);                  // still works
        assertEq(esc.lockedOf(address(usdc)), 0);
    }
    function test_guard_only_owner_and_fee_cap() public {
        vm.prank(client); vm.expectRevert(ElyraGuard.NotOwner.selector); guard.setPaused(true);
        vm.expectRevert(ElyraGuard.FeeTooHigh.selector);
        guard.setParams(resolverAddr, treasury, 501, 0, 0, 0);
    }

    // ---------------- bonds & disputes ----------------
    function test_bond_withdraw_cooldown_and_open_jobs() public {
        vm.prank(agentOwner); bond.deposit(agentId, 1_000 ether);
        assertTrue(bond.isVerified(agentId));
        uint256 id = _open(10e6);
        vm.prank(agentOwner); bond.requestWithdraw(agentId, 1_000 ether);
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        vm.prank(agentOwner); vm.expectRevert(AgentBond.OpenJobs.selector); bond.withdraw(agentId);
        vm.prank(agentOwner); esc.deliver(id, 0);
        vm.prank(client); esc.release(id);
        vm.prank(agentOwner); bond.withdraw(agentId);
        assertEq(bond.bondOf(agentId), 0);
        assertEq(ely.balanceOf(agentOwner), 5_000 ether);
    }
    function test_pause_never_blocks_bond_withdrawal() public {
        vm.prank(agentOwner); bond.deposit(agentId, 500 ether);
        vm.prank(agentOwner); bond.requestWithdraw(agentId, 500 ether);
        guard.setPaused(true);
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        vm.prank(agentOwner); bond.withdraw(agentId);
        assertEq(bond.bondOf(agentId), 0);
    }
    function test_only_escrow_can_slash() public {
        vm.expectRevert(AgentBond.NotEscrow.selector);
        bond.slash(agentId, 1, address(this));
    }
    function test_dispute_lost_splits_and_slashes_capped() public {
        vm.prank(agentOwner); bond.deposit(agentId, 3_000 ether);
        uint256 id = _open(100e6);
        vm.prank(agentOwner); esc.deliver(id, 0);
        vm.prank(client); esc.dispute(id);
        vm.prank(client); vm.expectRevert(JobEscrow.NotAllowed.selector); esc.resolve(id, 10_000, 0, 0);
        vm.prank(resolverAddr); esc.resolve(id, 8_000, 5_000 ether, keccak256("reason"));
        assertEq(usdc.balanceOf(client), 1_000e6 - 100e6 + 80e6);
        assertEq(usdc.balanceOf(agentOwner), 20e6);
        assertEq(ely.balanceOf(client), 1_000 ether);     // capped at maxSlashPerJob
        assertEq(bond.bondOf(agentId), 2_000 ether);
        (,, uint64 lost,) = reg.reputationOf(agentId);
        assertEq(lost, 1);
    }
    function test_dispute_timeout_never_stuck() public {
        uint256 id = _open(100e6);
        vm.prank(agentOwner); esc.deliver(id, 0);
        vm.prank(client); esc.dispute(id);
        vm.expectRevert(JobEscrow.TooEarly.selector); esc.resolveTimeout(id);
        vm.warp(vm.getBlockTimestamp() + 30 days + 1);
        esc.resolveTimeout(id);
        assertEq(usdc.balanceOf(agentOwner), 50e6);
        assertEq(esc.lockedOf(address(usdc)), 0);
    }

    // ---------------- guardian ----------------
    function test_guardian_can_only_pause() public {
        address g = makeAddr("guardian");
        vm.prank(g); vm.expectRevert(ElyraGuard.NotOwner.selector); guard.guardianPause();   // not set yet
        guard.setGuardian(g);
        vm.prank(g); guard.guardianPause();
        assertTrue(guard.paused());
        vm.prank(g); vm.expectRevert(ElyraGuard.NotOwner.selector); guard.setPaused(false);   // cannot un-pause
        vm.prank(g); vm.expectRevert(ElyraGuard.NotOwner.selector); guard.setTokenCaps(address(usdc), 1, 1, 1);
        vm.prank(g); vm.expectRevert(ElyraGuard.NotOwner.selector); guard.setGuardian(g);
        vm.prank(client); vm.expectRevert(JobEscrow.Paused.selector);
        esc.openJob(agentId, address(usdc), 1e6, uint64(vm.getBlockTimestamp() + 1 days), 0);
        guard.setPaused(false);                                                                  // only the owner re-opens
        _open(1e6);
    }

    // ---------------- automatic dispute rules ----------------
    function _delivered(uint256 amount) internal returns (uint256 id) {
        id = _open(amount);
        vm.prank(agentOwner); esc.deliver(id, 0);
    }
    function test_dispute_needs_deposit_and_agent_can_concede() public {
        guard.setDisputeDeposit(address(usdc), 1e6);
        uint256 id = _delivered(10e6);
        vm.prank(client); esc.dispute(id);
        assertEq(usdc.balanceOf(client), 1_000e6 - 11e6);
        assertEq(esc.lockedOf(address(usdc)), 11e6);
        vm.prank(client); vm.expectRevert(JobEscrow.NotAllowed.selector); esc.concede(id);
        vm.prank(agentOwner); esc.concede(id);
        assertEq(usdc.balanceOf(client), 1_000e6);                 // job + deposit back
        assertEq(esc.lockedOf(address(usdc)), 0);
        assertEq(esc.openDisputesOf(client), 0);
        (, uint64 refunded, uint64 lost,) = reg.reputationOf(agentId);
        assertEq(refunded, 1); assertEq(lost, 0);
    }
    function test_client_can_withdraw_dispute() public {
        guard.setDisputeDeposit(address(usdc), 1e6);
        uint256 id = _delivered(10e6);
        vm.prank(client); esc.dispute(id);
        vm.prank(client); esc.withdrawDispute(id);
        assertEq(usdc.balanceOf(agentOwner) + usdc.balanceOf(treasury), 10e6);
        assertEq(usdc.balanceOf(client), 1_000e6 - 10e6);           // deposit back
        assertEq(usdc.balanceOf(address(esc)), 0);
    }
    function test_timeout_deposit_to_agent_counts_as_bad() public {
        guard.setDisputeDeposit(address(usdc), 1e6);
        uint256 id = _delivered(10e6);
        vm.prank(client); esc.dispute(id);
        vm.warp(vm.getBlockTimestamp() + 30 days + 1);
        esc.resolveTimeout(id);
        assertEq(usdc.balanceOf(agentOwner), 6e6);                 // half the job + the deposit
        assertEq(usdc.balanceOf(client), 1_000e6 - 11e6 + 5e6);
        assertEq(reg.timeoutsOf(agentId), 1);
        assertEq(usdc.balanceOf(address(esc)), 0);
    }
    function test_resolver_client_right_gets_deposit_back() public {
        guard.setDisputeDeposit(address(usdc), 1e6);
        uint256 id = _delivered(10e6);
        vm.prank(client); esc.dispute(id);
        vm.prank(resolverAddr); esc.resolve(id, 10_000, 0, 0);
        assertEq(usdc.balanceOf(client), 1_000e6);
    }
    function test_max_open_disputes_per_client() public {
        guard.setDisputeRules(1, 0, 0);
        uint256 a = _delivered(5e6);
        uint256 b = _delivered(5e6);
        vm.prank(client); esc.dispute(a);
        vm.prank(client); vm.expectRevert(JobEscrow.TooManyDisputes.selector); esc.dispute(b);
        vm.prank(agentOwner); esc.concede(a);
        vm.prank(client); esc.dispute(b);                          // a slot is free again
        assertEq(esc.disputesOpenedBy(client), 2);
    }
    function test_agent_suspended_after_too_many_bad_outcomes_and_pardon() public {
        guard.setDisputeRules(0, 2, 5_000);                        // suspended with >= 2 bad AND > 50% bad
        for (uint256 i = 0; i < 2; i++) {
            uint256 id = _open(1e6);
            vm.warp(vm.getBlockTimestamp() + 1 days + 1);
            vm.prank(client); esc.refund(id);                      // not delivered = bad outcome
        }
        assertTrue(reg.isSuspended(agentId));
        assertFalse(reg.isActive(agentId));
        vm.prank(client); vm.expectRevert(JobEscrow.BadInput.selector);
        esc.openJob(agentId, address(usdc), 1e6, uint64(vm.getBlockTimestamp() + 1 days), 0);
        vm.prank(client); vm.expectRevert(CreditMeter.BadInput.selector);
        meter.deposit(agentId, address(usdc), 1e6);
        guard.pardon(agentId, 2);                                  // the owner forgives (public, logged)
        assertFalse(reg.isSuspended(agentId));
        _open(1e6);
    }
    function test_good_agent_not_suspended_by_one_bad_outcome() public {
        guard.setDisputeRules(0, 3, 3_000);
        for (uint256 i = 0; i < 5; i++) { uint256 id = _delivered(1e6); vm.prank(client); esc.release(id); }
        uint256 r = _open(1e6);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.prank(client); esc.refund(r);
        assertFalse(reg.isSuspended(agentId));
    }

    // ---------------- credit meter ----------------
    function _sign(uint256 cumulative, uint256 epoch) internal view returns (bytes memory) {
        bytes32 d = meter.voucherDigest(client, agentId, address(usdc), epoch, cumulative);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(clientPk, d);
        return abi.encodePacked(r, s, v);
    }
    function test_credits_settle_and_close() public {
        vm.prank(client); meter.deposit(agentId, address(usdc), 20e6);
        bytes memory sig = _sign(5e6, 0);
        vm.prank(agentOwner); meter.settle(client, agentId, address(usdc), 5e6, sig);
        assertEq(usdc.balanceOf(agentOwner), 4.95e6);
        // replaying the same voucher pays nothing
        vm.prank(agentOwner); vm.expectRevert(CreditMeter.BadInput.selector);
        meter.settle(client, agentId, address(usdc), 5e6, sig);
        // a bigger voucher pays only the difference
        bytes memory sig8 = _sign(8e6, 0);
        vm.prank(agentOwner); meter.settle(client, agentId, address(usdc), 8e6, sig8);
        assertEq(usdc.balanceOf(agentOwner), 4.95e6 + 2.97e6);
        // close: client gets the rest after the notice
        vm.prank(client); meter.requestClose(agentId, address(usdc));
        vm.prank(client); vm.expectRevert(CreditMeter.TooEarly.selector); meter.close(agentId, address(usdc));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(client); meter.close(agentId, address(usdc));
        assertEq(usdc.balanceOf(client), 1_000e6 - 8e6);
        // old vouchers are dead in the next epoch
        vm.prank(client); meter.deposit(agentId, address(usdc), 10e6);
        bytes memory oldSig = _sign(9e6, 0);
        vm.prank(agentOwner); vm.expectRevert(CreditMeter.BadSignature.selector);
        meter.settle(client, agentId, address(usdc), 9e6, oldSig);
    }
    function test_credits_wrong_signer() public {
        vm.prank(client); meter.deposit(agentId, address(usdc), 20e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, meter.voucherDigest(client, agentId, address(usdc), 0, 5e6));
        vm.prank(agentOwner); vm.expectRevert(CreditMeter.BadSignature.selector);
        meter.settle(client, agentId, address(usdc), 5e6, abi.encodePacked(r, s, v));
    }
    function test_credits_only_agent_owner_settles() public {
        vm.prank(client); meter.deposit(agentId, address(usdc), 20e6);
        bytes memory sig = _sign(5e6, 0);
        vm.expectRevert(CreditMeter.NotAllowed.selector);
        meter.settle(client, agentId, address(usdc), 5e6, sig);
    }

    // ---------------- start small: wallet caps ----------------
    function test_wallet_cap_across_jobs_and_credits() public {
        guard.setTokenCaps(address(usdc), 10e6, 10_000e6, 10e6);
        uint256 a = _open(6e6);
        vm.prank(client); vm.expectRevert(JobEscrow.CapExceeded.selector);
        esc.openJob(agentId, address(usdc), 5e6, uint64(vm.getBlockTimestamp() + 1 days), 0); // 6 + 5 > 10
        _open(4e6);                                                                    // 6 + 4 = 10 ok
        vm.prank(agentOwner); esc.deliver(a, 0);
        vm.prank(client); esc.release(a);                                              // frees 6
        assertEq(esc.exposureOf(address(usdc), client), 4e6);
        _open(6e6);
        // the credit meter has its own wallet cap
        vm.prank(client); meter.deposit(agentId, address(usdc), 10e6);
        vm.prank(client); vm.expectRevert(CreditMeter.CapExceeded.selector);
        meter.deposit(agentId, address(usdc), 1e6);
        bytes memory sig3 = _sign(3e6, 0);
        vm.prank(agentOwner); meter.settle(client, agentId, address(usdc), 3e6, sig3);
        vm.prank(client); meter.deposit(agentId, address(usdc), 3e6);                  // spent credit frees room
        assertEq(meter.exposureOf(address(usdc), client), 10e6);
    }
    function test_only_owner_changes_caps_and_can_raise_them() public {
        guard.setTokenCaps(address(usdc), 10e6, 5_000e6, 10e6);
        vm.prank(client); vm.expectRevert(ElyraGuard.NotOwner.selector);
        guard.setTokenCaps(address(usdc), 100e6, 50_000e6, 100e6);   // nobody else can touch the caps
        guard.setTokenCaps(address(usdc), 100e6, 50_000e6, 100e6);   // the owner (Safe) can raise them when it decides
        assertEq(guard.walletCap(address(usdc)), 100e6);
        _open(60e6);                                                 // larger jobs now allowed
    }

    // ---------------- faucet ----------------
    function test_faucet_once_a_day() public {
        vm.prank(client); vm.expectRevert(TestToken.Wait.selector); usdc.faucet();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(client); usdc.faucet();
        assertEq(usdc.balanceOf(client), 2_000e6);
    }

    // ---------------- fuzz: money is conserved ----------------
    function testFuzz_dispute_paths_conserve(uint96 raw, uint8 path) public {
        guard.setDisputeDeposit(address(usdc), 1e6);
        uint256 amount = bound(uint256(raw), 1, 500e6);
        uint256 id = _delivered(amount);
        vm.prank(client); esc.dispute(id);
        uint256 p = path % 4;
        if (p == 0) { vm.prank(agentOwner); esc.concede(id); }
        else if (p == 1) { vm.prank(client); esc.withdrawDispute(id); }
        else if (p == 2) { vm.prank(resolverAddr); esc.resolve(id, 7_000, 0, 0); }
        else { vm.warp(vm.getBlockTimestamp() + 30 days + 1); esc.resolveTimeout(id); }
        assertEq(usdc.balanceOf(client) + usdc.balanceOf(agentOwner) + usdc.balanceOf(treasury), 1_000e6);
        assertEq(usdc.balanceOf(address(esc)), 0);
        assertEq(esc.lockedOf(address(usdc)), 0);
    }

    function testFuzz_release_conserves(uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1, 500e6);
        uint256 id = _open(amount);
        vm.prank(agentOwner); esc.deliver(id, 0);
        vm.prank(client); esc.release(id);
        assertEq(usdc.balanceOf(agentOwner) + usdc.balanceOf(treasury), amount);
        assertEq(usdc.balanceOf(address(esc)), 0);
    }
}

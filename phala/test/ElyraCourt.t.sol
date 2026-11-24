// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ElyraGuard} from "../../src/ElyraGuard.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {AgentBond} from "../../src/AgentBond.sol";
import {JobEscrow} from "../../src/JobEscrow.sol";
import {TestToken} from "../../src/TestToken.sol";
import {ElyraCourt} from "../contracts/ElyraCourt.sol";
import {TeeBadgeRegistry} from "../contracts/TeeBadgeRegistry.sol";

/// @notice The Court executes only verdicts signed by the TEE judge key; the key changes only through the timelock;
///         badges are issued only by the judge and die with expiry, owner change or opt-out.
contract ElyraCourtTest is Test {
    TestToken ely; TestToken usdc;
    ElyraGuard guard; AgentRegistry reg; AgentBond bond; JobEscrow esc;
    ElyraCourt court; TeeBadgeRegistry badges; TimelockController tl;

    uint256 judgePk = 0xA11CE; address judge;
    address client = makeAddr("client");
    address agentOwner = makeAddr("agentOwner");
    address treasury = makeAddr("treasury");
    address proposer = makeAddr("proposer");
    uint256 agentId;
    bytes32 constant COMPOSE = keccak256("app-compose.json v1");

    function setUp() public {
        judge = vm.addr(judgePk);
        ely = new TestToken("tELY", "tELY", 18, 5_000 ether);
        usdc = new TestToken("tUSDC", "tUSDC", 6, 10_000e6);
        guard = new ElyraGuard(address(this));
        reg = new AgentRegistry(guard);
        bond = new AgentBond(IERC20(address(ely)), reg, guard, 1 hours);
        esc = new JobEscrow(reg, bond, guard, 1 hours);
        reg.setReporters(address(esc), makeAddr("creditMeter"));
        bond.setEscrow(address(esc));
        guard.setTokenCaps(address(usdc), 5_000e6, 50_000_000e6, 10_000e6);

        address[] memory p = new address[](1); p[0] = proposer;
        address[] memory e = new address[](1); e[0] = address(0);          // anyone executes once the delay passed
        tl = new TimelockController(2 days, p, e, address(0));
        court = new ElyraCourt(esc, guard, address(tl), judge, COMPOSE, "ipfs://quote-v1");
        badges = new TeeBadgeRegistry(reg, court);
        guard.setParams(address(court), treasury, 100, 100 ether, 50_000 ether, 1_000 ether);   // the Court is the resolver
        guard.setDisputeDeposit(address(usdc), 1e6);

        vm.prank(agentOwner); agentId = reg.register("Sentinel", "token", "2 tUSDC", "", 0, address(0));
        vm.startPrank(agentOwner); ely.faucet(); ely.approve(address(bond), type(uint256).max); bond.deposit(agentId, 1_000 ether); vm.stopPrank();
        vm.startPrank(client); usdc.faucet(); usdc.approve(address(esc), type(uint256).max); vm.stopPrank();
    }

    // ---------------- helpers ----------------
    function _disputedJob(uint256 amount) internal returns (uint256 id) {
        vm.prank(client); id = esc.openJob(agentId, address(usdc), amount, uint64(block.timestamp + 1 days), keccak256("spec"));
        vm.prank(agentOwner); esc.deliver(id, keccak256("result"));
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(client); esc.dispute(id);
    }
    function _verdict(uint256 id, uint16 bps, uint256 slash) internal view returns (ElyraCourt.Verdict memory v) {
        v = ElyraCourt.Verdict(id, bps, slash, keccak256("evidence"), keccak256("prompt"), keccak256("models"),
            keccak256("receipts"), uint64(block.timestamp), uint64(block.timestamp + 1 hours));
    }
    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
    function _status(uint256 id) internal view returns (JobEscrow.Status st) { (,,,,,,,, st,,,) = esc.jobs(id); }

    // ---------------- verdicts ----------------
    function test_signed_verdict_resolves_and_anyone_can_relay() public {
        uint256 id = _disputedJob(100e6);
        ElyraCourt.Verdict memory v = _verdict(id, 8_000, 50 ether);
        bytes memory sig = _sign(judgePk, court.verdictDigest(v));
        uint256 before = usdc.balanceOf(client);
        vm.prank(makeAddr("keeper")); court.submitVerdict(v, sig);
        assertEq(uint8(_status(id)), uint8(JobEscrow.Status.Resolved));
        assertEq(usdc.balanceOf(client) - before, 80e6 + 1e6);      // 80% back + the dispute deposit (client was right)
        assertEq(bond.bondOf(agentId), 950 ether);                  // capped slash applied
    }

    function test_rejects_a_signature_that_is_not_the_judge() public {
        uint256 id = _disputedJob(10e6);
        ElyraCourt.Verdict memory v = _verdict(id, 10_000, 0);
        bytes memory sig = _sign(0xB0B, court.verdictDigest(v));
        vm.expectRevert(ElyraCourt.NotJudge.selector);
        court.submitVerdict(v, sig);
    }

    function test_a_verdict_executes_once() public {
        uint256 id = _disputedJob(10e6);
        ElyraCourt.Verdict memory v = _verdict(id, 0, 0);
        bytes memory sig = _sign(judgePk, court.verdictDigest(v));
        court.submitVerdict(v, sig);
        vm.expectRevert(JobEscrow.WrongStatus.selector);
        court.submitVerdict(v, sig);
    }

    function test_rejects_verdicts_signed_before_the_dispute() public {
        vm.prank(client); uint256 id = esc.openJob(agentId, address(usdc), 10e6, uint64(block.timestamp + 1 days), keccak256("spec"));
        vm.prank(agentOwner); esc.deliver(id, keccak256("result"));
        ElyraCourt.Verdict memory v = _verdict(id, 10_000, 0);             // signed now, before any dispute
        bytes memory sig = _sign(judgePk, court.verdictDigest(v));
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(client); esc.dispute(id);
        vm.expectRevert(ElyraCourt.BadVerdict.selector);
        court.submitVerdict(v, sig);
    }

    function test_rejects_expired_or_long_lived_verdicts() public {
        uint256 id = _disputedJob(10e6);
        ElyraCourt.Verdict memory v = _verdict(id, 5_000, 0);
        bytes memory sig = _sign(judgePk, court.verdictDigest(v));
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(ElyraCourt.Expired.selector);
        court.submitVerdict(v, sig);

        ElyraCourt.Verdict memory w = _verdict(id, 5_000, 0);
        w.expiresAt = uint64(block.timestamp + 3 days);
        bytes memory sig2 = _sign(judgePk, court.verdictDigest(w));
        vm.expectRevert(ElyraCourt.BadVerdict.selector);
        court.submitVerdict(w, sig2);
    }

    function test_rejects_out_of_bounds_rulings() public {
        uint256 id = _disputedJob(10e6);
        ElyraCourt.Verdict memory v = _verdict(id, 10_001, 0);
        bytes memory sig = _sign(judgePk, court.verdictDigest(v));
        vm.expectRevert(ElyraCourt.BadVerdict.selector);
        court.submitVerdict(v, sig);
        ElyraCourt.Verdict memory w = _verdict(id, 10_000, 1_001 ether);   // above guard.maxSlashPerJob
        bytes memory sig2 = _sign(judgePk, court.verdictDigest(w));
        vm.expectRevert(ElyraCourt.BadVerdict.selector);
        court.submitVerdict(w, sig2);
    }

    function test_operator_cannot_bypass_the_court() public {
        uint256 id = _disputedJob(10e6);
        vm.expectRevert(JobEscrow.NotAllowed.selector);
        esc.resolve(id, 10_000, 0, bytes32(0));                       // this test contract is the guard owner
    }

    function test_timeout_still_frees_funds_without_a_verdict() public {
        uint256 id = _disputedJob(10e6);
        vm.warp(block.timestamp + esc.DISPUTE_TIMEOUT() + 1);
        esc.resolveTimeout(id);
        assertEq(uint8(_status(id)), uint8(JobEscrow.Status.Resolved));
    }

    // ---------------- governance ----------------
    function test_judge_changes_only_through_the_timelock() public {
        address newJudge = vm.addr(0xC0FFEE);
        vm.expectRevert(ElyraCourt.NotGovernor.selector);
        court.setJudge(newJudge, keccak256("v2"), "ipfs://quote-v2");

        bytes memory data = abi.encodeCall(ElyraCourt.setJudge, (newJudge, keccak256("v2"), "ipfs://quote-v2"));
        vm.prank(proposer); tl.schedule(address(court), 0, data, bytes32(0), bytes32(0), 2 days);
        vm.expectRevert();                                            // too early
        tl.execute(address(court), 0, data, bytes32(0), bytes32(0));
        vm.warp(block.timestamp + 2 days);
        tl.execute(address(court), 0, data, bytes32(0), bytes32(0));
        assertEq(court.judge(), newJudge);

        uint256 id = _disputedJob(10e6);                              // the old key no longer rules
        ElyraCourt.Verdict memory v = _verdict(id, 10_000, 0);
        bytes memory sig = _sign(judgePk, court.verdictDigest(v));
        vm.expectRevert(ElyraCourt.NotJudge.selector);
        court.submitVerdict(v, sig);
    }

    // ---------------- TEE badges ----------------
    function _badge(uint8 level, uint64 life) internal view returns (TeeBadgeRegistry.Badge memory b) {
        b = TeeBadgeRegistry.Badge(agentId, agentOwner, keccak256("agent-compose"), level, uint64(block.timestamp), uint64(block.timestamp + life));
    }

    function test_badge_issued_by_the_judge_only() public {
        TeeBadgeRegistry.Badge memory b = _badge(2, 7 days);
        bytes memory bad = _sign(0xB0B, badges.badgeDigest(b));
        vm.expectRevert(TeeBadgeRegistry.NotAttestor.selector);
        badges.setBadge(b, bad);
        badges.setBadge(b, _sign(judgePk, badges.badgeDigest(b)));
        (uint8 level,,) = badges.badgeOf(agentId);
        assertEq(level, 2);
    }

    function test_badge_expires_and_cannot_be_replayed_or_restored_after_opt_out() public {
        TeeBadgeRegistry.Badge memory b = _badge(1, 1 days);
        bytes memory sig = _sign(judgePk, badges.badgeDigest(b));
        badges.setBadge(b, sig);
        vm.expectRevert(TeeBadgeRegistry.BadBadge.selector);         // same badge again
        badges.setBadge(b, sig);
        vm.warp(block.timestamp + 1 days + 1);
        (uint8 level,,) = badges.badgeOf(agentId);
        assertEq(level, 0);

        TeeBadgeRegistry.Badge memory c = _badge(1, 7 days);
        badges.setBadge(c, _sign(judgePk, badges.badgeDigest(c)));
        vm.prank(agentOwner); badges.removeBadge(agentId);          // opt out
        (level,,) = badges.badgeOf(agentId);
        assertEq(level, 0);
        bytes memory again = _sign(judgePk, badges.badgeDigest(c));
        vm.expectRevert(TeeBadgeRegistry.BadBadge.selector);         // the removed badge cannot come back
        badges.setBadge(c, again);
    }

    function test_badge_rejects_wrong_wallet_and_long_lifetimes() public {
        TeeBadgeRegistry.Badge memory b = _badge(1, 8 days);
        bytes memory s1 = _sign(judgePk, badges.badgeDigest(b));
        vm.expectRevert(TeeBadgeRegistry.BadBadge.selector);
        badges.setBadge(b, s1);
        TeeBadgeRegistry.Badge memory c = _badge(1, 1 days);
        c.agentWallet = makeAddr("someoneElse");
        bytes memory s2 = _sign(judgePk, badges.badgeDigest(c));
        vm.expectRevert(TeeBadgeRegistry.BadBadge.selector);
        badges.setBadge(c, s2);
    }
}

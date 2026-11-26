// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {ElyraGuard} from "./ElyraGuard.sol";

interface IOpenJobs {
    function openJobsOf(uint256 agentId) external view returns (uint256);
}

/// @title AgentBond — ELY locked by an agent's owner as a guarantee
/// @notice Withdrawals need a cool-down and no open jobs, so an agent can't run away right after a bad job.
///         Only JobEscrow (set once) can take part of a bond, and only when a dispute is lost, capped per job.
///         The pause stops NEW bonds; it never blocks withdrawals.
contract AgentBond is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable ely;
    AgentRegistry public immutable registry;
    ElyraGuard public immutable guard;
    uint64 public immutable cooldown;
    address public immutable deployer;
    address public escrow;

    mapping(uint256 => uint256) public bondOf;
    mapping(uint256 => uint256) public pendingOf;   // amount requested for withdrawal
    mapping(uint256 => uint64) public unlockAt;

    event Bonded(uint256 indexed agentId, address indexed from, uint256 amount, uint256 total);
    event WithdrawRequested(uint256 indexed agentId, uint256 amount, uint64 unlockAt);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event Slashed(uint256 indexed agentId, address indexed to, uint256 amount);

    error Paused();
    error NotOwner();
    error NotEscrow();
    error BadAmount();
    error CapExceeded();
    error TooEarly();
    error OpenJobs();
    error AlreadySet();

    constructor(IERC20 ely_, AgentRegistry registry_, ElyraGuard guard_, uint64 cooldown_) {
        ely = ely_;
        registry = registry_;
        guard = guard_;
        cooldown = cooldown_;
        deployer = msg.sender;
    }

    function setEscrow(address escrow_) external {
        if (msg.sender != deployer) revert NotOwner();
        if (escrow != address(0)) revert AlreadySet();
        escrow = escrow_;
    }

    /// @notice add ELY to an agent's bond (anyone can top up; only the owner can withdraw)
    function deposit(uint256 agentId, uint256 amount) external nonReentrant {
        if (guard.paused()) revert Paused();
        if (amount == 0 || registry.ownerOf(agentId) == address(0)) revert BadAmount();
        uint256 max = guard.maxBondPerAgent();
        if (max != 0 && bondOf[agentId] + amount > max) revert CapExceeded();
        uint256 before = ely.balanceOf(address(this));
        ely.safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = ely.balanceOf(address(this)) - before;
        bondOf[agentId] += got;
        emit Bonded(agentId, msg.sender, got, bondOf[agentId]);
    }

    function requestWithdraw(uint256 agentId, uint256 amount) external {
        if (registry.ownerOf(agentId) != msg.sender) revert NotOwner();
        if (amount == 0 || amount > bondOf[agentId]) revert BadAmount();
        pendingOf[agentId] = amount;
        unlockAt[agentId] = uint64(block.timestamp) + cooldown;
        emit WithdrawRequested(agentId, amount, unlockAt[agentId]);
    }

    function withdraw(uint256 agentId) external nonReentrant {
        if (registry.ownerOf(agentId) != msg.sender) revert NotOwner();
        uint256 amount = pendingOf[agentId];
        if (amount == 0) revert BadAmount();
        if (block.timestamp < unlockAt[agentId]) revert TooEarly();
        if (escrow != address(0) && IOpenJobs(escrow).openJobsOf(agentId) != 0) revert OpenJobs();
        if (amount > bondOf[agentId]) amount = bondOf[agentId]; // a dispute may have reduced the bond meanwhile
        pendingOf[agentId] = 0;
        bondOf[agentId] -= amount;
        ely.safeTransfer(msg.sender, amount);
        emit Withdrawn(agentId, msg.sender, amount);
    }

    /// @notice only JobEscrow, only after a lost dispute; capped by the guard and by the bond itself
    function slash(uint256 agentId, uint256 amount, address to) external nonReentrant returns (uint256 taken) {
        if (msg.sender != escrow) revert NotEscrow();
        uint256 cap = guard.maxSlashPerJob();
        if (cap > guard.MAX_SLASH_PER_JOB()) cap = guard.MAX_SLASH_PER_JOB();
        taken = amount;
        if (taken > cap) taken = cap;
        if (taken > bondOf[agentId]) taken = bondOf[agentId];
        if (taken == 0) return 0;
        bondOf[agentId] -= taken;
        if (pendingOf[agentId] > bondOf[agentId]) pendingOf[agentId] = bondOf[agentId];
        ely.safeTransfer(to, taken);
        emit Slashed(agentId, to, taken);
    }

    function isVerified(uint256 agentId) external view returns (bool) {
        return bondOf[agentId] >= guard.minBond() && guard.minBond() > 0;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ElyraGuard — caps, fees and the emergency pause shared by every Elyra contract
/// @notice The owner (the project wallet) can:
///         - pause NEW deposits, bonds and jobs (never withdrawals, refunds or releases: see the other contracts);
///         - set per-token caps, the minimum bond, the protocol fee (hard-capped at 5%) and the dispute resolver.
///         It holds no funds and has no function that can move users' tokens.
///         GUARDIAN: a separate wallet used by the automatic monitor. It can ONLY switch the pause ON (never off,
///         never change a parameter). Switching the pause off is reserved to the owner.
///         DISPUTE RULES: deposit to open a dispute, max open disputes per client, automatic suspension of agents
///         with too many bad outcomes (refunds, lost disputes, disputes ended by timeout).
///         START SMALL: the protocol launches with low caps (e.g. 10 USDC at stake per wallet). Only the owner (the
///         project wallet) can change them; every change is a public transaction and emits an event.
contract ElyraGuard {
    uint16 public constant MAX_FEE_BPS = 500; // 5% hard cap, can never be exceeded

    address public owner;
    address public pendingOwner;
    bool public paused;

    address public resolver;      // decides disputed jobs (split only, see JobEscrow)
    address public feeRecipient;  // receives the protocol fee
    uint16 public feeBps;         // fee on released payments, in basis points (100 = 1%)

    uint256 public minBond;            // ELY needed to be "verified"
    uint256 public maxBondPerAgent;    // 0 = no limit
    uint256 public maxSlashPerJob;     // max ELY a lost dispute can take from a bond

    /// @notice per payment token: max amount per job / per credit deposit (0 = token not accepted)
    mapping(address => uint256) public jobCap;
    /// @notice per payment token: max total held by EACH contract at the same time
    mapping(address => uint256) public totalCap;
    /// @notice per payment token: max one wallet can have at stake in each contract at the same time (0 = no wallet limit)
    mapping(address => uint256) public walletCap;

    /// @notice wallet of the automatic monitor: it can only pause (address(0) = none)
    address public guardian;
    /// @notice per payment token: deposit a client must put down to open a dispute (0 = free)
    mapping(address => uint256) public disputeDeposit;
    /// @notice max disputes one client can have open at the same time (0 = no limit)
    uint16 public maxOpenDisputes;
    /// @notice an agent is suspended (no new jobs, no new credits) when it has at least `suspendMinBad` bad outcomes
    ///         AND bad outcomes are more than `suspendBadBps` of all its outcomes. suspendMinBad = 0 switches it off.
    uint16 public suspendMinBad;
    uint16 public suspendBadBps;
    /// @notice bad outcomes the owner has forgiven for an agent (manual, rare): only the ones above this count
    mapping(uint256 => uint64) public pardonedBad;

    event Paused(bool paused);
    event OwnershipTransferStarted(address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event TokenCaps(address indexed token, uint256 jobCap, uint256 totalCap, uint256 walletCap);
    event GuardianSet(address guardian);
    event GuardianPaused(address by);
    event DisputeDeposit(address indexed token, uint256 amount);
    event DisputeRules(uint16 maxOpenDisputes, uint16 suspendMinBad, uint16 suspendBadBps);
    event Pardoned(uint256 indexed agentId, uint64 baseline);
    event Params(address resolver, address feeRecipient, uint16 feeBps, uint256 minBond, uint256 maxBondPerAgent, uint256 maxSlashPerJob);

    error NotOwner();
    error FeeTooHigh();
    error ZeroAddress();
    error BadInput();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        resolver = owner_;
        feeRecipient = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    /// @notice set (or remove, with address(0)) the guardian wallet used by the automatic monitor
    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice emergency stop for the monitor: the guardian (or the owner) can switch the pause ON. Only the owner can switch it off.
    function guardianPause() external {
        if (msg.sender != guardian && msg.sender != owner) revert NotOwner();
        if (paused) return;
        paused = true;
        emit Paused(true);
        emit GuardianPaused(msg.sender);
    }

    function setDisputeDeposit(address token, uint256 amount) external onlyOwner {
        disputeDeposit[token] = amount;
        emit DisputeDeposit(token, amount);
    }

    function setDisputeRules(uint16 maxOpenDisputes_, uint16 suspendMinBad_, uint16 suspendBadBps_) external onlyOwner {
        if (suspendBadBps_ > 10_000) revert BadInput();
        maxOpenDisputes = maxOpenDisputes_;
        suspendMinBad = suspendMinBad_;
        suspendBadBps = suspendBadBps_;
        emit DisputeRules(maxOpenDisputes_, suspendMinBad_, suspendBadBps_);
    }

    /// @notice forgive an agent's bad outcomes up to `baseline` (e.g. after a bug that was not its fault). Public and logged.
    function pardon(uint256 agentId, uint64 baseline) external onlyOwner {
        pardonedBad[agentId] = baseline;
        emit Pardoned(agentId, baseline);
    }

    function setTokenCaps(address token, uint256 jobCap_, uint256 totalCap_, uint256 walletCap_) external onlyOwner {
        jobCap[token] = jobCap_;
        totalCap[token] = totalCap_;
        walletCap[token] = walletCap_;
        emit TokenCaps(token, jobCap_, totalCap_, walletCap_);
    }

    function setParams(address resolver_, address feeRecipient_, uint16 feeBps_, uint256 minBond_, uint256 maxBondPerAgent_, uint256 maxSlashPerJob_)
        external
        onlyOwner
    {
        if (resolver_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        resolver = resolver_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        minBond = minBond_;
        maxBondPerAgent = maxBondPerAgent_;
        maxSlashPerJob = maxSlashPerJob_;
        emit Params(resolver_, feeRecipient_, feeBps_, minBond_, maxBondPerAgent_, maxSlashPerJob_);
    }

    /// @notice two-step ownership transfer (e.g. from the deployer to the project wallet)
    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingOwner = to;
        emit OwnershipTransferStarted(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}

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
///         TIMELOCK: after the initial setup (`finishSetup`), every parameter change must be scheduled first and can
///         only be executed `delay` seconds later, so users see it coming and can leave. Pausing stays immediate.
///         HARD LIMITS: fee ≤ 5%, slash per job ≤ MAX_SLASH_PER_JOB, timelock delay ≥ MIN_DELAY. They are constants.
contract ElyraGuard {
    uint16 public constant MAX_FEE_BPS = 500; // 5% hard cap, can never be exceeded
    uint256 public constant MAX_SLASH_PER_JOB = 1_000 ether; // a lost dispute can never take more than this from a bond
    uint64 public constant MIN_DELAY = 1 hours;              // shortest timelock any deployment can use
    uint64 public constant GRACE = 14 days;                  // a scheduled change expires if not executed in time

    /// @notice timelock delay for parameter changes, fixed at deployment (e.g. 1 hour on testnet, 48 hours on mainnet)
    uint64 public immutable delay;
    /// @notice false only during the initial setup by the deployer; once true it can never go back
    bool public setupDone;
    /// @notice scheduled changes: keccak256(call data) => earliest execution time (0 = not scheduled)
    mapping(bytes32 => uint64) public scheduledAt;

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
    /// @notice per payment token: smallest job / credit deposit accepted (stops dust jobs used for griefing or farming)
    mapping(address => uint256) public minAmount;
    /// @notice per payment token: smallest protocol fee charged on a paid job or settlement (the % fee never rounds to 0)
    mapping(address => uint256) public minFee;
    /// @notice shortest time a client can give an agent to deliver (JobEscrow also enforces its confirmation window)
    uint64 public minJobDuration;

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
    event TokenMinimums(address indexed token, uint256 minAmount, uint256 minFee);
    event MinJobDuration(uint64 duration);
    event SetupFinished();
    event ChangeScheduled(bytes32 indexed id, bytes data, uint64 executableAt);
    event ChangeCancelled(bytes32 indexed id);
    event ChangeExecuted(bytes32 indexed id);

    error NotOwner();
    error FeeTooHigh();
    error ZeroAddress();
    error BadInput();
    error SlashCapTooHigh();
    error NotScheduled();
    error TooEarly();
    error Expired();
    error CallFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev parameter setters: the owner directly during setup, afterwards only through the timelock (`execute`)
    modifier onlyConfig() {
        if (setupDone ? msg.sender != address(this) : msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, uint64 delay_) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (delay_ < MIN_DELAY) revert BadInput();
        delay = delay_;
        owner = owner_;
        resolver = owner_;
        feeRecipient = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    // ----- timelock -----

    /// @notice ends the setup: from now on every parameter change goes through schedule → wait `delay` → execute
    function finishSetup() external onlyOwner {
        setupDone = true;
        emit SetupFinished();
    }

    /// @notice announce a parameter change (the ABI-encoded call to one of the setters below)
    function schedule(bytes calldata data) external onlyOwner returns (bytes32 id) {
        id = keccak256(data);
        uint64 at = uint64(block.timestamp) + delay;
        scheduledAt[id] = at;
        emit ChangeScheduled(id, data, at);
    }

    function cancel(bytes32 id) external onlyOwner {
        if (scheduledAt[id] == 0) revert NotScheduled();
        delete scheduledAt[id];
        emit ChangeCancelled(id);
    }

    /// @notice apply a scheduled change once its delay has passed
    function execute(bytes calldata data) external onlyOwner {
        bytes32 id = keccak256(data);
        uint64 at = scheduledAt[id];
        if (at == 0) revert NotScheduled();
        if (block.timestamp < at) revert TooEarly();
        if (block.timestamp > at + GRACE) revert Expired();
        delete scheduledAt[id];
        (bool ok,) = address(this).call(data);
        if (!ok) revert CallFailed();
        emit ChangeExecuted(id);
    }

    // ----- parameters (timelocked after setup) -----

    /// @notice set (or remove, with address(0)) the guardian wallet used by the automatic monitor
    function setGuardian(address guardian_) external onlyConfig {
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

    function setDisputeDeposit(address token, uint256 amount) external onlyConfig {
        disputeDeposit[token] = amount;
        emit DisputeDeposit(token, amount);
    }

    function setDisputeRules(uint16 maxOpenDisputes_, uint16 suspendMinBad_, uint16 suspendBadBps_) external onlyConfig {
        if (suspendBadBps_ > 10_000) revert BadInput();
        maxOpenDisputes = maxOpenDisputes_;
        suspendMinBad = suspendMinBad_;
        suspendBadBps = suspendBadBps_;
        emit DisputeRules(maxOpenDisputes_, suspendMinBad_, suspendBadBps_);
    }

    /// @notice forgive an agent's bad outcomes up to `baseline` (e.g. after a bug that was not its fault). Public and logged.
    function pardon(uint256 agentId, uint64 baseline) external onlyConfig {
        pardonedBad[agentId] = baseline;
        emit Pardoned(agentId, baseline);
    }

    function setTokenCaps(address token, uint256 jobCap_, uint256 totalCap_, uint256 walletCap_) external onlyConfig {
        jobCap[token] = jobCap_;
        totalCap[token] = totalCap_;
        walletCap[token] = walletCap_;
        emit TokenCaps(token, jobCap_, totalCap_, walletCap_);
    }

    function setParams(address resolver_, address feeRecipient_, uint16 feeBps_, uint256 minBond_, uint256 maxBondPerAgent_, uint256 maxSlashPerJob_)
        external
        onlyConfig
    {
        if (resolver_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (maxSlashPerJob_ > MAX_SLASH_PER_JOB) revert SlashCapTooHigh();
        resolver = resolver_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        minBond = minBond_;
        maxBondPerAgent = maxBondPerAgent_;
        maxSlashPerJob = maxSlashPerJob_;
        emit Params(resolver_, feeRecipient_, feeBps_, minBond_, maxBondPerAgent_, maxSlashPerJob_);
    }

    /// @notice smallest job / credit deposit and smallest fee for a token (minFee can never exceed minAmount)
    function setTokenMinimums(address token, uint256 minAmount_, uint256 minFee_) external onlyConfig {
        if (minFee_ > minAmount_) revert BadInput();
        minAmount[token] = minAmount_;
        minFee[token] = minFee_;
        emit TokenMinimums(token, minAmount_, minFee_);
    }

    function setMinJobDuration(uint64 duration) external onlyConfig {
        if (duration > 30 days) revert BadInput();
        minJobDuration = duration;
        emit MinJobDuration(duration);
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

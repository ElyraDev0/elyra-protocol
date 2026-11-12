// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {AgentBond} from "./AgentBond.sol";
import {ElyraGuard} from "./ElyraGuard.sol";

/// @title JobEscrow — a client's payment waits here until the work is delivered
/// @notice open → deliver → release (client confirms, or anyone after the confirmation window)
///         open → refund (client, after the deadline, if nothing was delivered)
///         deliver → dispute (client, inside the window, puts down a small deposit) →
///             concede (agent gives the money back) · withdrawDispute (client changes idea, agent is paid)
///             resolve (resolver: split only) · timeout after DISPUTE_TIMEOUT (50/50, the deposit goes to the agent)
///         No external arbitration: jobs are small (≈10 $), so the rules are automatic and cost nothing.
///         The pause stops NEW jobs only. Refunds, releases and dispute exits always work.
contract JobEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { None, Open, Delivered, Released, Refunded, Disputed, Resolved }

    struct Job {
        uint256 agentId;
        address client;
        address token;
        uint256 amount;
        uint64 deadline;
        uint64 deliveredAt;
        uint64 disputedAt;
        uint16 feeBps;       // fixed when the job is opened
        Status status;
        bytes32 specHash;    // hash of the task description (kept off-chain)
        bytes32 resultHash;  // hash of the delivered result (kept off-chain)
        uint256 deposit;     // dispute deposit put down by the client (same token)
    }

    uint64 public constant MAX_JOB_DURATION = 90 days;
    uint64 public constant DISPUTE_TIMEOUT = 30 days;

    AgentRegistry public immutable registry;
    AgentBond public immutable bond;
    ElyraGuard public immutable guard;
    uint64 public immutable confirmWindow;

    uint256 public jobCount;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => uint256) public openJobsOf;          // per agent: jobs not yet closed
    mapping(address => uint256) public lockedOf;            // per token: total held right now
    mapping(address => uint256) public completedAsClient;   // per client: jobs paid on delivery (Genesis quest)
    mapping(address => uint256) public latestJobOf;         // per client: last job id
    mapping(address => mapping(address => uint256)) public exposureOf; // token => client => amount in open jobs
    mapping(address => uint256) public openDisputesOf;      // per client: disputes not yet closed
    mapping(address => uint256) public disputesOpenedBy;    // per client: all disputes ever opened (public track record)

    event JobOpened(uint256 indexed id, uint256 indexed agentId, address indexed client, address token, uint256 amount, uint64 deadline);
    event JobDelivered(uint256 indexed id, bytes32 resultHash);
    event JobReleased(uint256 indexed id, uint256 toAgent, uint256 fee);
    event JobRefunded(uint256 indexed id);
    event JobDisputed(uint256 indexed id);
    event JobResolved(uint256 indexed id, uint16 clientBps, uint256 slashed, bytes32 reasonHash);
    event DisputeConceded(uint256 indexed id);
    event DisputeWithdrawn(uint256 indexed id);

    error Paused();
    error BadInput();
    error CapExceeded();
    error WrongStatus();
    error NotAllowed();
    error TooEarly();
    error TooLate();
    error TooManyDisputes();

    constructor(AgentRegistry registry_, AgentBond bond_, ElyraGuard guard_, uint64 confirmWindow_) {
        registry = registry_;
        bond = bond_;
        guard = guard_;
        confirmWindow = confirmWindow_;
    }

    function openJob(uint256 agentId, address token, uint256 amount, uint64 deadline, bytes32 specHash) external nonReentrant returns (uint256 id) {
        if (guard.paused()) revert Paused();
        if (!registry.isActive(agentId)) revert BadInput();
        uint256 cap = guard.jobCap(token);
        if (cap == 0 || amount == 0 || amount > cap) revert CapExceeded();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_JOB_DURATION) revert BadInput();

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = IERC20(token).balanceOf(address(this)) - before;
        if (lockedOf[token] + got > guard.totalCap(token)) revert CapExceeded();
        uint256 wcap = guard.walletCap(token);
        if (wcap != 0 && exposureOf[token][msg.sender] + got > wcap) revert CapExceeded();
        lockedOf[token] += got;
        exposureOf[token][msg.sender] += got;

        id = ++jobCount;
        jobs[id] = Job({
            agentId: agentId, client: msg.sender, token: token, amount: got, deadline: deadline, deliveredAt: 0, disputedAt: 0,
            feeBps: guard.feeBps(), status: Status.Open, specHash: specHash, resultHash: bytes32(0), deposit: 0
        });
        openJobsOf[agentId] += 1;
        latestJobOf[msg.sender] = id;
        emit JobOpened(id, agentId, msg.sender, token, got, deadline);
    }

    /// @notice the agent's owner submits the result before the deadline
    function deliver(uint256 id, bytes32 resultHash) external {
        Job storage j = jobs[id];
        if (j.status != Status.Open) revert WrongStatus();
        if (msg.sender != registry.ownerOf(j.agentId)) revert NotAllowed();
        if (block.timestamp > j.deadline) revert TooLate();
        j.status = Status.Delivered;
        j.deliveredAt = uint64(block.timestamp);
        j.resultHash = resultHash;
        emit JobDelivered(id, resultHash);
    }

    /// @notice client confirms; after the confirmation window anyone can trigger it
    function release(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.status != Status.Delivered) revert WrongStatus();
        if (msg.sender != j.client && block.timestamp <= j.deliveredAt + confirmWindow) revert TooEarly();
        _payAgent(id, j);
    }

    function _payAgent(uint256 id, Job storage j) internal {
        j.status = Status.Released;
        uint256 fee = (j.amount * j.feeBps) / 10_000;
        _close(j);
        completedAsClient[j.client] += 1;
        registry.record(j.agentId, registry.COMPLETED(), j.amount - fee);
        if (fee != 0) IERC20(j.token).safeTransfer(guard.feeRecipient(), fee);
        IERC20(j.token).safeTransfer(registry.payoutOf(j.agentId), j.amount - fee);
        emit JobReleased(id, j.amount - fee, fee);
    }

    /// @notice nothing delivered by the deadline: the client takes everything back, without asking anyone
    function refund(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.status != Status.Open) revert WrongStatus();
        if (msg.sender != j.client) revert NotAllowed();
        if (block.timestamp <= j.deadline) revert TooEarly();
        j.status = Status.Refunded;
        _close(j);
        registry.record(j.agentId, registry.REFUNDED(), 0);
        IERC20(j.token).safeTransfer(j.client, j.amount);
        emit JobRefunded(id);
    }

    /// @notice the client contests a delivery, inside the confirmation window, putting down the dispute deposit
    ///         (it comes back if the client is right; it goes to the agent if the client is wrong or nobody decides)
    function dispute(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.status != Status.Delivered) revert WrongStatus();
        if (msg.sender != j.client) revert NotAllowed();
        if (block.timestamp > j.deliveredAt + confirmWindow) revert TooLate();
        uint256 maxOpen = guard.maxOpenDisputes();
        if (maxOpen != 0 && openDisputesOf[msg.sender] >= maxOpen) revert TooManyDisputes();
        uint256 dep = guard.disputeDeposit(j.token);
        if (dep != 0) {
            uint256 before = IERC20(j.token).balanceOf(address(this));
            IERC20(j.token).safeTransferFrom(msg.sender, address(this), dep);
            dep = IERC20(j.token).balanceOf(address(this)) - before;
            lockedOf[j.token] += dep;
        }
        j.deposit = dep;
        j.status = Status.Disputed;
        j.disputedAt = uint64(block.timestamp);
        openDisputesOf[msg.sender] += 1;
        disputesOpenedBy[msg.sender] += 1;
        emit JobDisputed(id);
    }

    /// @notice the agent agrees with the client: full refund + deposit back. Counts as a refund, not as a lost dispute.
    function concede(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.status != Status.Disputed) revert WrongStatus();
        if (msg.sender != registry.ownerOf(j.agentId)) revert NotAllowed();
        j.status = Status.Refunded;
        _close(j);
        uint256 dep = _endDispute(j);
        registry.record(j.agentId, registry.REFUNDED(), 0);
        IERC20(j.token).safeTransfer(j.client, j.amount + dep);
        emit DisputeConceded(id);
        emit JobRefunded(id);
    }

    /// @notice the client changes idea: the agent is paid as a normal release, the deposit goes back to the client
    function withdrawDispute(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.status != Status.Disputed) revert WrongStatus();
        if (msg.sender != j.client) revert NotAllowed();
        uint256 dep = _endDispute(j);
        if (dep != 0) IERC20(j.token).safeTransfer(j.client, dep);
        emit DisputeWithdrawn(id);
        _payAgent(id, j);
    }

    /// @notice the resolver can only split the escrowed payment between client and agent, and apply a capped bond penalty
    function resolve(uint256 id, uint16 clientBps, uint256 slashAmount, bytes32 reasonHash) external nonReentrant {
        Job storage j = jobs[id];
        if (j.status != Status.Disputed) revert WrongStatus();
        if (msg.sender != guard.resolver()) revert NotAllowed();
        if (clientBps > 10_000) revert BadInput();
        _settleDispute(id, j, clientBps, slashAmount, reasonHash, false);
    }

    /// @notice if the resolver never decides, after DISPUTE_TIMEOUT anyone can close the job 50/50 — funds never get stuck
    function resolveTimeout(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.status != Status.Disputed) revert WrongStatus();
        if (block.timestamp <= j.disputedAt + DISPUTE_TIMEOUT) revert TooEarly();
        _settleDispute(id, j, 5_000, 0, bytes32("timeout"), true);
    }

    function _endDispute(Job storage j) internal returns (uint256 dep) {
        dep = j.deposit;
        j.deposit = 0;
        openDisputesOf[j.client] -= 1;
        lockedOf[j.token] -= dep;
    }

    function _settleDispute(uint256 id, Job storage j, uint16 clientBps, uint256 slashAmount, bytes32 reasonHash, bool timedOut) internal {
        j.status = Status.Resolved;
        _close(j);
        uint256 dep = _endDispute(j);
        uint256 toClient = (j.amount * clientBps) / 10_000;
        uint256 toAgent = j.amount - toClient;
        uint256 slashed;
        if (clientBps > 5_000) {
            toClient += dep;                                   // client was right: deposit back
            registry.record(j.agentId, registry.DISPUTE_LOST(), 0);
            if (slashAmount != 0) slashed = bond.slash(j.agentId, slashAmount, j.client);
        } else if (timedOut) {
            toAgent += dep;                                    // nobody decided: deposit to the agent, bad outcome for the agent
            registry.record(j.agentId, registry.DISPUTE_TIMEOUT(), toAgent);
        } else {
            toAgent += dep;                                    // client was wrong: deposit to the agent
            completedAsClient[j.client] += 1;
            registry.record(j.agentId, registry.COMPLETED(), toAgent);
        }
        if (toClient != 0) IERC20(j.token).safeTransfer(j.client, toClient);
        if (toAgent != 0) IERC20(j.token).safeTransfer(registry.payoutOf(j.agentId), toAgent);
        emit JobResolved(id, clientBps, slashed, reasonHash);
    }

    function _close(Job storage j) internal {
        openJobsOf[j.agentId] -= 1;
        lockedOf[j.token] -= j.amount;
        exposureOf[j.token][j.client] -= j.amount;
    }
}

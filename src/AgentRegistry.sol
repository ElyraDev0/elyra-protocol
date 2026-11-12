// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ElyraGuard} from "./ElyraGuard.sol";

/// @title AgentRegistry — a public identity for every AI agent
/// @notice Anyone can register an agent. Only its owner can change it. Reputation counters are written only by the
///         Elyra payment contracts (JobEscrow, CreditMeter), set once at deployment, and can never be edited by hand.
///         AUTOMATIC SUSPENSION: an agent with too many bad outcomes (refunds + lost disputes + disputes ended by timeout)
///         is not "active" any more, so it cannot get new jobs or credits. Rules are in ElyraGuard.
contract AgentRegistry {
    struct Agent {
        address owner;
        address payout;       // where payments go
        bool active;
        uint64 createdAt;
        bytes32 profileHash;  // hash of the full profile at profileURI (so it can't change silently)
        string name;
        string services;      // e.g. "translate:en-de,summarize"
        string pricing;       // e.g. "0.50 USDC/page"
        string profileURI;
    }
    struct Reputation {
        uint64 completed;     // jobs paid and delivered
        uint64 refunded;      // jobs not delivered by the deadline
        uint64 disputesLost;
        uint128 earned;       // total paid to the agent (in payment-token units, mixed tokens are summed as-is)
    }

    uint256 public agentCount;
    mapping(uint256 => Agent) private _agents;
    mapping(uint256 => Reputation) public reputationOf;
    mapping(address => uint256) public agentCountOf;   // agents registered by an owner (used by the Genesis quests)
    mapping(address => uint256) public latestAgentOf;  // last agent id registered by an owner
    mapping(uint256 => uint64) public timeoutsOf;      // per agent: disputes closed 50/50 by timeout

    ElyraGuard public immutable guard;

    address public immutable deployer;
    address public escrow;   // JobEscrow
    address public meter;    // CreditMeter

    event AgentRegistered(uint256 indexed id, address indexed owner, string name);
    event AgentUpdated(uint256 indexed id);
    event AgentActive(uint256 indexed id, bool active);
    event JobRecorded(uint256 indexed id, uint8 outcome, uint256 amount);

    error NotOwner();
    error NotReporter();
    error BadInput();
    error AlreadySet();
    error UnknownAgent();

    uint8 public constant COMPLETED = 1;
    uint8 public constant REFUNDED = 2;
    uint8 public constant DISPUTE_LOST = 3;
    uint8 public constant EARNED = 4; // credits settled, no job
    uint8 public constant DISPUTE_TIMEOUT = 5; // dispute closed 50/50 by timeout (counts as a bad outcome)

    constructor(ElyraGuard guard_) {
        deployer = msg.sender;
        guard = guard_;
    }

    /// @notice set the two reporting contracts. Callable once, by the deployer.
    function setReporters(address escrow_, address meter_) external {
        if (msg.sender != deployer) revert NotOwner();
        if (escrow != address(0)) revert AlreadySet();
        if (escrow_ == address(0) || meter_ == address(0)) revert BadInput();
        escrow = escrow_;
        meter = meter_;
    }

    function register(string calldata name, string calldata services, string calldata pricing, string calldata profileURI, bytes32 profileHash, address payout)
        external
        returns (uint256 id)
    {
        _check(name, services, pricing, profileURI);
        id = ++agentCount;
        _agents[id] = Agent({
            owner: msg.sender, payout: payout == address(0) ? msg.sender : payout, active: true, createdAt: uint64(block.timestamp),
            profileHash: profileHash, name: name, services: services, pricing: pricing, profileURI: profileURI
        });
        agentCountOf[msg.sender] += 1;
        latestAgentOf[msg.sender] = id;
        emit AgentRegistered(id, msg.sender, name);
    }

    function update(uint256 id, string calldata name, string calldata services, string calldata pricing, string calldata profileURI, bytes32 profileHash, address payout)
        external
    {
        Agent storage a = _own(id);
        _check(name, services, pricing, profileURI);
        a.name = name;
        a.services = services;
        a.pricing = pricing;
        a.profileURI = profileURI;
        a.profileHash = profileHash;
        if (payout != address(0)) a.payout = payout;
        emit AgentUpdated(id);
    }

    function setActive(uint256 id, bool active) external {
        _own(id).active = active;
        emit AgentActive(id, active);
    }

    /// @notice written only by JobEscrow / CreditMeter
    function record(uint256 id, uint8 outcome, uint256 amount) external {
        if (msg.sender != escrow && msg.sender != meter) revert NotReporter();
        Reputation storage r = reputationOf[id];
        if (outcome == COMPLETED) { r.completed += 1; r.earned += uint128(amount); }
        else if (outcome == REFUNDED) r.refunded += 1;
        else if (outcome == DISPUTE_LOST) r.disputesLost += 1;
        else if (outcome == EARNED) r.earned += uint128(amount);
        else if (outcome == DISPUTE_TIMEOUT) { timeoutsOf[id] += 1; r.earned += uint128(amount); }
        emit JobRecorded(id, outcome, amount);
    }

    // ---------------- views ----------------
    function getAgent(uint256 id) external view returns (Agent memory) {
        if (_agents[id].owner == address(0)) revert UnknownAgent();
        return _agents[id];
    }
    function ownerOf(uint256 id) external view returns (address) { return _agents[id].owner; }
    function payoutOf(uint256 id) external view returns (address) { return _agents[id].payout; }
    /// @notice active = switched on by its owner AND not suspended
    function isActive(uint256 id) external view returns (bool) { return _agents[id].active && !isSuspended(id); }

    /// @notice bad outcomes counted for suspension (after the owner's pardon, if any)
    function badOutcomes(uint256 id) public view returns (uint256 bad, uint256 total) {
        Reputation storage r = reputationOf[id];
        bad = uint256(r.refunded) + r.disputesLost + timeoutsOf[id];
        uint256 base = guard.pardonedBad(id);
        bad = bad > base ? bad - base : 0;
        total = uint256(r.completed) + bad;
    }

    function isSuspended(uint256 id) public view returns (bool) {
        uint256 minBad = guard.suspendMinBad();
        if (minBad == 0) return false;
        (uint256 bad, uint256 total) = badOutcomes(id);
        if (bad < minBad) return false;
        return bad * 10_000 > uint256(guard.suspendBadBps()) * total;
    }

    // ---------------- internal ----------------
    function _own(uint256 id) internal view returns (Agent storage a) {
        a = _agents[id];
        if (a.owner == address(0)) revert UnknownAgent();
        if (a.owner != msg.sender) revert NotOwner();
    }
    function _check(string calldata name, string calldata services, string calldata pricing, string calldata uri) internal pure {
        if (bytes(name).length == 0 || bytes(name).length > 64 || bytes(services).length > 256 || bytes(pricing).length > 64 || bytes(uri).length > 256) revert BadInput();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {ElyraCourt} from "./ElyraCourt.sol";

/// @title TeeBadgeRegistry — opt-in "TEE-verified" badges for agents that run inside a Phala CVM
/// @notice The attestor is the Elyra judge itself (court.judge()): its key lives in an attested TEE, so a badge
///         cannot be issued by hand. The judge verifies the agent's TDX quote (dcap-qvl), replays RTMR3 against the
///         submitted app-compose.json, checks report_data = keccak256("ELYRA_AGENT_V1", chainId, registry, agentId,
///         wallet), and signs a short-lived `Badge`. Anyone may submit it. The agent owner can remove it at any time.
///         level 1 = TEE (key and runtime attested) · level 2 = TEE + open source (compose pins public image digests).
contract TeeBadgeRegistry is EIP712 {
    struct Badge {
        uint256 agentId;
        address agentWallet;   // must be the agent's owner on the registry when the badge is set AND when read
        bytes32 composeHash;   // sha256(app-compose.json) the agent was attested with
        uint8 level;
        uint64 issuedAt;
        uint64 expiresAt;
    }
    struct Record {
        address wallet;
        bytes32 composeHash;
        uint8 level;
        uint64 expiresAt;
    }

    bytes32 public constant BADGE_TYPEHASH = keccak256(
        "Badge(uint256 agentId,address agentWallet,bytes32 composeHash,uint8 level,uint64 issuedAt,uint64 expiresAt)"
    );
    uint64 public constant MAX_BADGE_LIFETIME = 7 days;

    AgentRegistry public immutable registry;
    ElyraCourt public immutable court;
    mapping(uint256 => Record) public records;
    mapping(uint256 => uint64) public lastIssuedAt;   // kept after removal: an old badge cannot be re-submitted

    event BadgeSet(uint256 indexed agentId, address wallet, bytes32 composeHash, uint8 level, uint64 expiresAt);
    event BadgeRemoved(uint256 indexed agentId);

    error BadBadge();
    error NotAttestor();
    error NotOwner();

    constructor(AgentRegistry registry_, ElyraCourt court_) EIP712("ElyraTeeBadge", "1") {
        registry = registry_;
        court = court_;
    }

    function badgeDigest(Badge calldata b) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            BADGE_TYPEHASH, b.agentId, b.agentWallet, b.composeHash, b.level, b.issuedAt, b.expiresAt
        )));
    }

    function setBadge(Badge calldata b, bytes calldata signature) external {
        if (b.level == 0 || b.level > 2) revert BadBadge();
        if (b.issuedAt > block.timestamp || b.expiresAt <= block.timestamp) revert BadBadge();
        if (b.expiresAt - b.issuedAt > MAX_BADGE_LIFETIME) revert BadBadge();
        if (b.issuedAt <= lastIssuedAt[b.agentId]) revert BadBadge();   // no replay: each badge is newer than the last
        if (registry.ownerOf(b.agentId) != b.agentWallet) revert BadBadge();
        if (ECDSA.recover(badgeDigest(b), signature) != court.judge()) revert NotAttestor();
        records[b.agentId] = Record(b.agentWallet, b.composeHash, b.level, b.expiresAt);
        lastIssuedAt[b.agentId] = b.issuedAt;
        emit BadgeSet(b.agentId, b.agentWallet, b.composeHash, b.level, b.expiresAt);
    }

    /// @notice opt out: the agent's owner removes its badge
    function removeBadge(uint256 agentId) external {
        if (msg.sender != registry.ownerOf(agentId)) revert NotOwner();
        delete records[agentId];
        emit BadgeRemoved(agentId);
    }

    /// @notice 0 = no valid badge (none, expired, or the agent changed owner since)
    function badgeOf(uint256 agentId) external view returns (uint8 level, bytes32 composeHash, uint64 expiresAt) {
        Record memory r = records[agentId];
        if (r.expiresAt <= block.timestamp || r.wallet != registry.ownerOf(agentId)) return (0, bytes32(0), 0);
        return (r.level, r.composeHash, r.expiresAt);
    }
}

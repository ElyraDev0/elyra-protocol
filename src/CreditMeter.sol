// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {ElyraGuard} from "./ElyraGuard.sol";

/// @title CreditMeter — prepaid credit for thousands of tiny requests, one settlement
/// @notice 1. The client deposits a credit for an agent.
///         2. Each request carries a voucher signed by the client: "up to now you may take `cumulative`".
///         3. The agent settles the latest voucher whenever it likes: one transaction for many requests.
///         4. The client can always get back what was not used, after a notice period (the agent can still settle meanwhile).
///         The pause stops NEW deposits only.
contract CreditMeter is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(address client,uint256 agentId,address token,uint256 epoch,uint256 cumulative)");

    struct Channel {
        uint256 deposit;   // total deposited in this epoch
        uint256 settled;   // total already paid to the agent in this epoch
        uint64 closeAt;    // 0 = open; otherwise the client can withdraw the rest from this time
        uint64 epoch;      // increases at every close, so old vouchers can never be replayed
    }

    AgentRegistry public immutable registry;
    ElyraGuard public immutable guard;
    uint64 public immutable notice;

    mapping(bytes32 => Channel) public channels;
    mapping(address => uint256) public lockedOf;
    mapping(address => mapping(address => uint256)) public exposureOf; // token => client => unspent credit

    event Deposited(address indexed client, uint256 indexed agentId, address token, uint256 amount, uint64 epoch);
    event Settled(address indexed client, uint256 indexed agentId, address token, uint256 paid, uint256 fee, uint256 cumulative);
    event CloseRequested(address indexed client, uint256 indexed agentId, address token, uint64 closeAt);
    event Closed(address indexed client, uint256 indexed agentId, address token, uint256 refunded);

    error Paused();
    error BadInput();
    error CapExceeded();
    error NotAllowed();
    error BadSignature();
    error TooEarly();

    constructor(AgentRegistry registry_, ElyraGuard guard_, uint64 notice_) EIP712("Elyra CreditMeter", "1") {
        registry = registry_;
        guard = guard_;
        notice = notice_;
    }

    function key(address client, uint256 agentId, address token) public pure returns (bytes32) {
        return keccak256(abi.encode(client, agentId, token));
    }

    function deposit(uint256 agentId, address token, uint256 amount) external nonReentrant {
        if (guard.paused()) revert Paused();
        if (!registry.isActive(agentId) || amount == 0) revert BadInput();
        Channel storage c = channels[key(msg.sender, agentId, token)];
        uint256 cap = guard.jobCap(token);
        uint256 wcap = guard.walletCap(token);
        if (cap == 0 || c.deposit - c.settled + amount > cap) revert CapExceeded();
        if (wcap != 0 && exposureOf[token][msg.sender] + amount > wcap) revert CapExceeded();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = IERC20(token).balanceOf(address(this)) - before;
        if (lockedOf[token] + got > guard.totalCap(token)) revert CapExceeded();
        lockedOf[token] += got;
        exposureOf[token][msg.sender] += got;
        c.deposit += got;
        c.closeAt = 0; // topping up cancels a pending close
        emit Deposited(msg.sender, agentId, token, got, c.epoch);
    }

    /// @notice the voucher digest a client signs (EIP-712 typed data)
    function voucherDigest(address client, uint256 agentId, address token, uint256 epoch, uint256 cumulative) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, client, agentId, token, epoch, cumulative)));
    }

    /// @notice the agent's owner settles the latest voucher
    function settle(address client, uint256 agentId, address token, uint256 cumulative, bytes calldata signature) external nonReentrant {
        if (msg.sender != registry.ownerOf(agentId)) revert NotAllowed();
        Channel storage c = channels[key(client, agentId, token)];
        if (cumulative <= c.settled || cumulative > c.deposit) revert BadInput();
        if (!SignatureChecker.isValidSignatureNow(client, voucherDigest(client, agentId, token, c.epoch, cumulative), signature)) revert BadSignature();
        uint256 amount = cumulative - c.settled;
        c.settled = cumulative;
        lockedOf[token] -= amount;
        exposureOf[token][client] -= amount;
        uint256 fee = (amount * guard.feeBps()) / 10_000;
        registry.record(agentId, registry.EARNED(), amount - fee);
        if (fee != 0) IERC20(token).safeTransfer(guard.feeRecipient(), fee);
        IERC20(token).safeTransfer(registry.payoutOf(agentId), amount - fee);
        emit Settled(client, agentId, token, amount - fee, fee, cumulative);
    }

    function requestClose(uint256 agentId, address token) external {
        Channel storage c = channels[key(msg.sender, agentId, token)];
        if (c.deposit == 0) revert BadInput();
        c.closeAt = uint64(block.timestamp) + notice;
        emit CloseRequested(msg.sender, agentId, token, c.closeAt);
    }

    /// @notice after the notice period the client takes back everything not settled; old vouchers stop working
    function close(uint256 agentId, address token) external nonReentrant {
        Channel storage c = channels[key(msg.sender, agentId, token)];
        if (c.closeAt == 0 || block.timestamp < c.closeAt) revert TooEarly();
        uint256 rest = c.deposit - c.settled;
        lockedOf[token] -= rest;
        exposureOf[token][msg.sender] -= rest;
        c.deposit = 0;
        c.settled = 0;
        c.closeAt = 0;
        c.epoch += 1;
        if (rest != 0) IERC20(token).safeTransfer(msg.sender, rest);
        emit Closed(msg.sender, agentId, token, rest);
    }
}

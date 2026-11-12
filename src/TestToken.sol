// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken — TESTNET ONLY. Free tokens from a faucet, no value.
/// @notice Used on Sepolia as test ELY (tELY) and test USDC (tUSDC). Never deploy this on mainnet.
contract TestToken is ERC20 {
    uint8 private immutable _dec;
    uint256 public immutable faucetAmount;
    mapping(address => uint256) public lastFaucet;

    error Wait();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 faucetAmount_) ERC20(name_, symbol_) {
        _dec = decimals_;
        faucetAmount = faucetAmount_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    /// @notice once every 24 hours per address
    function faucet() external {
        if (lastFaucet[msg.sender] != 0 && block.timestamp < lastFaucet[msg.sender] + 1 days) revert Wait();
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
    }
}

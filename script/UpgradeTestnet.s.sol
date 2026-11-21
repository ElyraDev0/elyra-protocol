// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ElyraGuard} from "../src/ElyraGuard.sol";
import {TestToken} from "../src/TestToken.sol";

/// @notice TESTNET ONLY. Lets the testnet simulate large jobs (up to 5,000 tUSDC) so the dispute courts can be tried on
///         big amounts: deploys a new test USDC with a 10,000/day faucet and sets its caps. Run by the guard owner.
///         GUARD=0x... forge script script/UpgradeTestnet.s.sol --rpc-url <sepolia rpc> --broadcast --slow
contract UpgradeTestnet is Script {
    function run() external {
        require(block.chainid == 11155111 || block.chainid == 2700, "Testnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        ElyraGuard guard = ElyraGuard(vm.envAddress("GUARD"));
        vm.startBroadcast(pk);
        TestToken usdc = new TestToken("Elyra Test USDC", "tUSDC", 6, 10_000 * 1e6);
        // per job 5,000 · per wallet 10,000 at stake · 50M in total (testnet)
        guard.setTokenCaps(address(usdc), 5_000 * 1e6, 50_000_000 * 1e6, 10_000 * 1e6);
        guard.setDisputeDeposit(address(usdc), 1e6);
        vm.stopBroadcast();
        console2.log("new tUSDC:", address(usdc));
    }
}

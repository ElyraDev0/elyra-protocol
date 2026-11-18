// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {TestToken} from "../src/TestToken.sol";

/// @notice TESTNET ONLY. Runs one complete Elyra job end to end, so anyone can see the protocol working on-chain:
///         a client pays 1 tUSDC into escrow -> the demo agent delivers -> the client releases -> the agent is paid
///         and its on-chain reputation is updated.
///         The client is a separate throwaway wallet derived from your key, funded with a little gas by the script.
///
///         ESCROW=0x... REGISTRY=0x... TUSDC=0x... AGENT_ID=1 \
///         forge script script/DemoJob.s.sol --rpc-url orbinum_testnet --broadcast --slow
contract DemoJob is Script {
    function run() external {
        require(block.chainid == 11155111 || block.chainid == 2700, "Testnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");                       // agent owner (the deployer)
        uint256 clientPk = uint256(keccak256(abi.encode(pk, "elyra-demo-client"))); // throwaway testnet client
        address client = vm.addr(clientPk);

        JobEscrow escrow = JobEscrow(vm.envAddress("ESCROW"));
        AgentRegistry registry = AgentRegistry(vm.envAddress("REGISTRY"));
        TestToken tUsdc = TestToken(vm.envAddress("TUSDC"));
        uint256 agentId = vm.envOr("AGENT_ID", uint256(1));
        address payout = registry.payoutOf(agentId);

        // 1. give the client a little gas for its transactions
        if (client.balance < 0.05 ether) {
            vm.startBroadcast(pk);
            payable(client).transfer(0.1 ether);
            vm.stopBroadcast();
        }

        // 2. client: free test USDC, approve, open a 1 tUSDC job for the demo agent
        uint256 agentBefore = tUsdc.balanceOf(payout);
        vm.startBroadcast(clientPk);
        if (tUsdc.balanceOf(client) < 1e6) tUsdc.faucet();
        tUsdc.approve(address(escrow), 1e6);
        uint256 jobId = escrow.openJob(agentId, address(tUsdc), 1e6, uint64(block.timestamp + 1 days), keccak256("Summarize the Elyra whitepaper in 5 bullet points"));
        vm.stopBroadcast();

        // 3. agent: delivers the result (only its hash goes on-chain)
        vm.startBroadcast(pk);
        escrow.deliver(jobId, keccak256("ipfs://demo-result"));
        vm.stopBroadcast();

        // 4. client: happy with the result, releases the payment
        vm.startBroadcast(clientPk);
        escrow.release(jobId);
        vm.stopBroadcast();

        console2.log("----- Elyra demo job completed on chain", block.chainid, "-----");
        console2.log("job id:          ", jobId);
        console2.log("client wallet:   ", client);
        console2.log("agent paid (tUSDC, 6 decimals):", tUsdc.balanceOf(payout) - agentBefore);
    }
}

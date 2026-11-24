// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {JobEscrow} from "../../src/JobEscrow.sol";
import {ElyraGuard} from "../../src/ElyraGuard.sol";

/// @title ElyraCourt — executes AI-court verdicts that were signed inside a TEE (Phala Cloud, dstack)
/// @notice Set as `guard.resolver()`, this contract becomes the ONLY way a disputed job can be resolved by a ruling.
///         A ruling is an EIP-712 `Verdict` signed by `judge`: an address whose private key was derived inside the
///         judge CVM (`getKey`) and bound to its code by a TDX quote (report_data = keccak256("ELYRA_JUDGE_V1",
///         chainId, court, judge)). Anyone may relay a verdict: the signature is the authority, not the sender.
///         The judge can only be changed by `governor` (a TimelockController), so a change is public days in advance.
///         Bounds are enforced twice: here and again inside JobEscrow.resolve (split only, capped slash).
///         If no verdict ever arrives, JobEscrow.resolveTimeout still closes the job 50/50: funds never get stuck.
contract ElyraCourt is EIP712 {
    struct Verdict {
        uint256 jobId;
        uint16 clientBps;      // share of the escrow returned to the client, 0..10000
        uint256 slashAmount;   // ELY taken from the agent bond (capped by guard.maxSlashPerJob)
        bytes32 evidenceRoot;  // keccak256 of the canonical evidence bundle the judge decided on
        bytes32 promptHash;    // keccak256 of the judge's system prompt + output schema
        bytes32 modelsHash;    // keccak256 of the model ids used
        bytes32 receiptsHash;  // keccak256 of the confidential-inference receipt ids
        uint64 issuedAt;
        uint64 expiresAt;
    }

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(uint256 jobId,uint16 clientBps,uint256 slashAmount,bytes32 evidenceRoot,bytes32 promptHash,bytes32 modelsHash,bytes32 receiptsHash,uint64 issuedAt,uint64 expiresAt)"
    );
    uint64 public constant MAX_VERDICT_LIFETIME = 1 days;

    JobEscrow public immutable escrow;
    ElyraGuard public immutable guard;

    address public governor;          // TimelockController
    address public judge;             // key derived inside the judge CVM
    bytes32 public judgeComposeHash;  // sha256(app-compose.json) of the judge app, as attested
    string public judgeQuoteCid;      // where the TDX quote + event log + app-compose.json are published

    event JudgeSet(address indexed judge, bytes32 composeHash, string quoteCid);
    event GovernorSet(address indexed governor);
    event Ruled(uint256 indexed jobId, uint16 clientBps, uint256 slashAmount, bytes32 evidenceRoot, bytes32 promptHash,
        bytes32 modelsHash, bytes32 receiptsHash, address relayer);

    error NotGovernor();
    error NotJudge();
    error BadVerdict();
    error Expired();
    error ZeroAddress();

    constructor(JobEscrow escrow_, ElyraGuard guard_, address governor_, address judge_, bytes32 composeHash_, string memory quoteCid_)
        EIP712("ElyraCourt", "1")
    {
        if (governor_ == address(0) || judge_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        guard = guard_;
        governor = governor_;
        judge = judge_;
        judgeComposeHash = composeHash_;
        judgeQuoteCid = quoteCid_;
        emit GovernorSet(governor_);
        emit JudgeSet(judge_, composeHash_, quoteCid_);
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    /// @notice the EIP-712 digest the judge signs (exposed so off-chain code and tests can check their encoding)
    function verdictDigest(Verdict calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            VERDICT_TYPEHASH, v.jobId, v.clientBps, v.slashAmount, v.evidenceRoot, v.promptHash, v.modelsHash,
            v.receiptsHash, v.issuedAt, v.expiresAt
        )));
    }

    /// @notice executes a verdict signed by the judge. Callable by anyone (the judge CVM, a party, a keeper).
    function submitVerdict(Verdict calldata v, bytes calldata signature) external {
        if (v.clientBps > 10_000) revert BadVerdict();
        if (v.slashAmount > guard.maxSlashPerJob()) revert BadVerdict();
        if (v.expiresAt < block.timestamp || v.issuedAt > block.timestamp) revert Expired();
        if (v.expiresAt - v.issuedAt > MAX_VERDICT_LIFETIME) revert BadVerdict();
        if (ECDSA.recover(verdictDigest(v), signature) != judge) revert NotJudge();
        // a verdict must be issued after the dispute was opened: nothing can be signed in advance
        (,,,,,, uint64 disputedAt,,,,,) = escrow.jobs(v.jobId);
        if (disputedAt == 0 || v.issuedAt < disputedAt) revert BadVerdict();
        // JobEscrow checks the job is still Disputed: a verdict can be executed once
        escrow.resolve(v.jobId, v.clientBps, v.slashAmount, keccak256(abi.encode(v.evidenceRoot, v.receiptsHash)));
        emit Ruled(v.jobId, v.clientBps, v.slashAmount, v.evidenceRoot, v.promptHash, v.modelsHash, v.receiptsHash, msg.sender);
    }

    /// @notice new judge key (e.g. a new judge app). Timelocked: the governor is a TimelockController.
    function setJudge(address judge_, bytes32 composeHash_, string calldata quoteCid_) external onlyGovernor {
        if (judge_ == address(0)) revert ZeroAddress();
        judge = judge_;
        judgeComposeHash = composeHash_;
        judgeQuoteCid = quoteCid_;
        emit JudgeSet(judge_, composeHash_, quoteCid_);
    }

    function setGovernor(address governor_) external onlyGovernor {
        if (governor_ == address(0)) revert ZeroAddress();
        governor = governor_;
        emit GovernorSet(governor_);
    }
}

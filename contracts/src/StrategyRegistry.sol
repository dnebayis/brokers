// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title StrategyRegistry
/// @notice Holds the live target basket (tokens + weights) for each strategy.
///         v1 has a single strategy, THE_POLITICIAN (id 0). The registry is
///         strategy-aware so new strategies (ARK, whales, insiders) can be added
///         later without redeploying the collection.
/// @dev Two write paths:
///        - `setStrategy` (UPDATER_ROLE) — an ops/admin fallback (trusted tx sender);
///        - `setStrategyWithSig` — the production path: the indexer signs the target
///          vector EIP-712 and *anyone* can relay it. Authorization lives in the
///          signature, not the sender, so every update is publicly attributable to
///          `oracleSigner` and independently verifiable against public filings.
///      `epoch` is strictly monotonic (`+1` each update) which also makes each
///      signature single-use (replay- and reorder-proof).
contract StrategyRegistry is AccessControl, EIP712 {
    bytes32 public constant UPDATER_ROLE = keccak256("UPDATER_ROLE");

    /// @dev EIP-712 struct: the arrays are committed as packed keccak digests.
    ///      tokensHash   = keccak256(abi.encodePacked(tokens))       // 20 bytes each
    ///      weightsHash  = keccak256(abi.encodePacked(weightsBps))   // 2 bytes each
    bytes32 public constant UPDATE_TYPEHASH = keccak256(
        "Update(uint256 strategyId,bytes32 tokensHash,bytes32 weightsHash,uint64 epoch,uint256 deadline)"
    );

    uint16 public constant BPS = 10_000;

    /// @notice The indexer key authorized to sign strategy updates (settable by admin).
    address public oracleSigner;

    /// @notice Max basket turnover allowed per epoch, in bps (Σ|new−old|/2 over the token
    ///         union). Default BPS (100%) = disabled; admin tightens it so a single bad data
    ///         pull can't rotate the whole portfolio at once. Does not apply to the first update.
    uint16 public maxDriftBps = BPS;

    struct Strategy {
        address[] tokens; // ERC-8056 stock-token addresses on RH Chain
        uint16[] weightsBps; // parallel to tokens; must sum to BPS
        uint64 epoch; // monotonically increasing; bumps on each update
        uint64 updatedAt; // block timestamp of last update
        bool active;
    }

    mapping(uint256 strategyId => Strategy) private _strategies;
    uint256 public strategyCount;

    event StrategyCreated(uint256 indexed strategyId, string name);
    event StrategyUpdated(
        uint256 indexed strategyId, uint64 indexed epoch, address[] tokens, uint16[] weightsBps
    );
    event OracleSignerUpdated(address signer);
    event MaxDriftUpdated(uint16 bps);

    error LengthMismatch();
    error WeightsNotFull(uint256 sum);
    error EmptyBasket();
    error ZeroToken();
    error ZeroWeight();
    error DuplicateToken(address token);
    error UnknownStrategy();
    error SigExpired();
    error BadEpoch(uint64 expected, uint64 got);
    error BadSignature();
    error SignerNotSet();
    error DriftTooHigh(uint256 turnoverBps, uint256 maxBps);

    constructor(address admin, address updater) EIP712("CoattailStrategyRegistry", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPDATER_ROLE, updater);
    }

    /// @notice Set/rotate the oracle signing key (admin/governance).
    function setOracleSigner(address signer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oracleSigner = signer;
        emit OracleSignerUpdated(signer);
    }

    /// @notice Cap per-epoch basket turnover (bps). BPS = disabled.
    function setMaxDriftBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > BPS) revert WeightsNotFull(bps);
        maxDriftBps = bps;
        emit MaxDriftUpdated(bps);
    }

    /// @notice Register a new strategy slot (governance/admin action).
    function createStrategy(string calldata name) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 id) {
        id = strategyCount++;
        _strategies[id].active = true;
        emit StrategyCreated(id, name);
    }

    /// @notice Post a fresh target basket via the trusted role (ops/admin fallback).
    function setStrategy(uint256 strategyId, address[] calldata tokens, uint16[] calldata weightsBps)
        external
        onlyRole(UPDATER_ROLE)
    {
        _applyStrategy(strategyId, tokens, weightsBps);
    }

    /// @notice Production path: apply a basket the oracle signed EIP-712. Permissionless
    ///         to relay — the signature is the authorization. `epoch` must be exactly the
    ///         next epoch (so the same signature can't be replayed or reordered), and the
    ///         relay must land before `deadline`.
    function setStrategyWithSig(
        uint256 strategyId,
        address[] calldata tokens,
        uint16[] calldata weightsBps,
        uint64 epoch,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert SigExpired();
        if (oracleSigner == address(0)) revert SignerNotSet();

        Strategy storage s = _strategies[strategyId];
        uint64 expected = s.epoch + 1;
        if (epoch != expected) revert BadEpoch(expected, epoch);

        bytes32 structHash = keccak256(
            abi.encode(
                UPDATE_TYPEHASH,
                strategyId,
                keccak256(abi.encodePacked(tokens)),
                keccak256(abi.encodePacked(weightsBps)),
                epoch,
                deadline
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != oracleSigner) revert BadSignature();

        _applyStrategy(strategyId, tokens, weightsBps);
    }

    /// @dev Shared validation + write. Epoch bumps by exactly 1.
    function _applyStrategy(uint256 strategyId, address[] calldata tokens, uint16[] calldata weightsBps)
        internal
    {
        Strategy storage s = _strategies[strategyId];
        if (!s.active) revert UnknownStrategy();
        if (tokens.length == 0) revert EmptyBasket();
        if (tokens.length != weightsBps.length) revert LengthMismatch();

        // Canonical-basket validation (M-3): every token real and distinct, every weight non-zero,
        // and the vector summing to exactly 100%. Rejecting malformed baskets keeps Booster.poke
        // from double-counting a duplicate or reverting mid-loop on a zero address.
        uint256 sum;
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == address(0)) revert ZeroToken();
            if (weightsBps[i] == 0) revert ZeroWeight();
            for (uint256 j = i + 1; j < tokens.length; ++j) {
                if (tokens[j] == tokens[i]) revert DuplicateToken(tokens[i]);
            }
            sum += weightsBps[i];
        }
        if (sum != BPS) revert WeightsNotFull(sum);

        // Bound how far the basket can move in one epoch (skip on the first update).
        if (maxDriftBps < BPS && s.tokens.length != 0) {
            uint256 turnover = _turnoverBps(s.tokens, s.weightsBps, tokens, weightsBps);
            if (turnover > maxDriftBps) revert DriftTooHigh(turnover, maxDriftBps);
        }

        s.tokens = tokens;
        s.weightsBps = weightsBps;
        s.updatedAt = uint64(block.timestamp);
        unchecked {
            s.epoch += 1;
        }

        emit StrategyUpdated(strategyId, s.epoch, tokens, weightsBps);
    }

    /// @dev Basket turnover = ½·Σ|newWeight−oldWeight| over the union of tokens, in bps
    ///      (0 = identical, BPS = fully rotated). O(n·m) but baskets are ≤ ~25 and updates rare.
    function _turnoverBps(
        address[] memory oldTokens,
        uint16[] memory oldWeights,
        address[] calldata newTokens,
        uint16[] calldata newWeights
    ) internal pure returns (uint256) {
        uint256 l1;
        bool[] memory matched = new bool[](oldTokens.length);
        for (uint256 i; i < newTokens.length; ++i) {
            bool found;
            for (uint256 j; j < oldTokens.length; ++j) {
                if (!matched[j] && oldTokens[j] == newTokens[i]) {
                    matched[j] = true;
                    l1 += _absDiff(newWeights[i], oldWeights[j]);
                    found = true;
                    break;
                }
            }
            if (!found) l1 += newWeights[i]; // new token: old weight 0
        }
        for (uint256 j; j < oldTokens.length; ++j) {
            if (!matched[j]) l1 += oldWeights[j]; // dropped token: new weight 0
        }
        return l1 / 2;
    }

    function _absDiff(uint16 a, uint16 b) private pure returns (uint256) {
        return a >= b ? uint256(a) - b : uint256(b) - a;
    }

    // ---- views ----

    function getBasket(uint256 strategyId)
        external
        view
        returns (address[] memory tokens, uint16[] memory weightsBps, uint64 epoch)
    {
        Strategy storage s = _strategies[strategyId];
        if (!s.active) revert UnknownStrategy();
        return (s.tokens, s.weightsBps, s.epoch);
    }

    function epochOf(uint256 strategyId) external view returns (uint64) {
        return _strategies[strategyId].epoch;
    }
}

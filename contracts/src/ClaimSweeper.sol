// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBoosterClaimFor {
    function claimFor(uint256 tokenId) external;
}

/// @title ClaimSweeper
/// @notice Claims accrued stock for ANY number of Brokers in a single transaction.
/// @dev The Booster's `claimBatch` is hard-capped at 5 ids per call, so sweeping a large
///      collection from an EOA used to take ceil(n/5) separate transactions. `claimFor`
///      is permissionless and uncapped per-id — stock can only ever move to the Broker's
///      own token-bound wallet, never to the caller — so looping it here collapses the
///      whole sweep into one transaction. This contract is ownerless, holds no funds,
///      and takes no approvals; the per-transaction bound is simply block gas.
contract ClaimSweeper {
    IBoosterClaimFor public immutable booster;

    error ZeroAddress();
    error EmptyBatch();

    constructor(address booster_) {
        if (booster_ == address(0)) revert ZeroAddress();
        booster = IBoosterClaimFor(booster_);
    }

    /// @notice Claim every listed Broker's accrued stock into its own wallet, atomically.
    ///         Reverts as a whole if any single claim reverts (e.g. a nonexistent id).
    function claimMany(uint256[] calldata tokenIds) external {
        if (tokenIds.length == 0) revert EmptyBatch();
        for (uint256 i; i < tokenIds.length; ++i) {
            booster.claimFor(tokenIds[i]);
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title FeeSplitter
/// @notice Single entry point for all protocol swap-fee / royalty revenue. Routes ETH 80/10/10
///         to Booster / project treasury / buyback. Mint proceeds do NOT flow here — they go
///         directly to the creator (see CoattailBroker). The creator earns nothing from this
///         splitter; the 10% "project" cut funds the project's future (infra, audit, dev).
/// @dev The 80/10/10 economics are immutable. `flush()` is permissionless.
contract FeeSplitter is Ownable2Step {
    address payable public booster; // 80% — buys stock for Brokers (the flywheel)
    address payable public treasury; // 10% — project treasury (project future: infra/audit/dev)
    address payable public buyback; // 10% — $COAT buyback & burn sink (deflation / price support)

    uint16 public constant BOOSTER_BPS = 8000;
    uint16 public constant TREASURY_BPS = 1000;
    uint16 public constant BUYBACK_BPS = 1000;

    // M-1: a leg whose recipient reverts must not block the other two. Its share is parked in
    // `owed[recipient]` and excluded from future splits (via `totalOwed`), so distribution never
    // stalls and the split ratio is never distorted on retry. `release()` retries a parked leg.
    mapping(address recipient => uint256) public owed;
    uint256 public totalOwed;

    event Flushed(uint256 total, uint256 toBooster, uint256 toTreasury, uint256 toBuyback);
    event Parked(address indexed recipient, uint256 amount);
    event Released(address indexed recipient, uint256 amount);

    error ZeroAddress();
    error NothingOwed();

    constructor(address owner_, address payable booster_, address payable treasury_, address payable buyback_)
        Ownable(owner_)
    {
        if (booster_ == address(0) || treasury_ == address(0) || buyback_ == address(0)) {
            revert ZeroAddress();
        }
        booster = booster_;
        treasury = treasury_;
        buyback = buyback_;
    }

    receive() external payable {}

    /// @notice Push the freshly-received balance out along the split. Anyone may call. A failing
    ///         leg is parked in `owed` and retried later via `release`, never reverting the flush.
    function flush() external {
        uint256 bal = address(this).balance - totalOwed; // only distribute fresh funds
        if (bal == 0) return;

        uint256 toBooster = (bal * BOOSTER_BPS) / 10_000;
        uint256 toTreasury = (bal * TREASURY_BPS) / 10_000;
        uint256 toBuyback = bal - toBooster - toTreasury; // remainder avoids dust

        _payOrPark(booster, toBooster);
        _payOrPark(treasury, toTreasury);
        _payOrPark(buyback, toBuyback);

        emit Flushed(bal, toBooster, toTreasury, toBuyback);
    }

    /// @notice Retry a previously-parked payout to `to` (e.g. after the recipient is fixed).
    ///         Permissionless — it can only send funds already earmarked for that address.
    function release(address payable to) external {
        uint256 amt = owed[to];
        if (amt == 0) revert NothingOwed();
        owed[to] = 0;
        totalOwed -= amt;
        (bool ok,) = to.call{value: amt}("");
        if (!ok) {
            owed[to] = amt; // restore the earmark; funds never leave without a successful send
            totalOwed += amt;
            revert NothingOwed();
        }
        emit Released(to, amt);
    }

    function setSinks(address payable booster_, address payable treasury_, address payable buyback_)
        external
        onlyOwner
    {
        if (booster_ == address(0) || treasury_ == address(0) || buyback_ == address(0)) {
            revert ZeroAddress();
        }
        booster = booster_;
        treasury = treasury_;
        buyback = buyback_;
    }

    function _payOrPark(address payable to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok,) = to.call{value: amt}("");
        if (!ok) {
            owed[to] += amt;
            totalOwed += amt;
            emit Parked(to, amt);
        }
    }
}

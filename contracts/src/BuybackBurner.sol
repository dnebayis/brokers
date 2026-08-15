// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface ICoatBuybackRouter {
    function buy(uint256 minCoatOut, address to) external payable returns (uint256 out);
    function quoteBuy(uint256 ethIn) external view returns (uint256 out);
}

interface ICoatTwap {
    function consultPriceX96(uint32 secondsAgo) external view returns (uint256 priceX96);
}

interface ICoatBurn is IERC20 {
    function burn(uint256 amount) external;
}

/// @title BuybackBurner
/// @notice Permissionlessly converts bounded buffered-ETH batches into COAT and burns them,
///         guarded by a 30-minute TWAP and a maximum 5% spot deviation/slippage policy.
contract BuybackBurner {
    uint32 public constant TWAP_WINDOW = 30 minutes;
    // Gross spot is fee-free while execution pays 1% LP + 1% hook fees. Keep the
    // accepted gross deviation at 3% so the total protected execution floor stays 5%.
    uint256 public constant MAX_SPOT_DEVIATION_BPS = 300;
    uint256 public constant MAX_EXECUTION_DISCOUNT_BPS = 500;
    uint256 public constant BPS = 10_000;
    uint256 public constant Q96 = 1 << 96;
    uint256 public constant MAX_BUYBACK_BATCH = 0.01 ether;

    ICoatBuybackRouter public immutable router;
    ICoatTwap public immutable hook;
    ICoatBurn public immutable coat;

    event BuybackExecuted(address indexed caller, uint256 ethIn, uint256 coatBurned);

    error EmptyBalance();
    error SpotTooFarFromTwap(uint256 spot, uint256 twap);
    error InvalidBatch();

    constructor(ICoatBuybackRouter router_, ICoatTwap hook_, ICoatBurn coat_) {
        require(
            address(router_) != address(0) && address(hook_) != address(0) && address(coat_) != address(0),
            "zero"
        );
        router = router_;
        hook = hook_;
        coat = coat_;
    }

    receive() external payable {}

    function executeBuyback() external returns (uint256 burned) {
        uint256 balance = address(this).balance;
        if (balance == 0) revert EmptyBalance();
        return _executeBuyback(Math.min(balance, MAX_BUYBACK_BATCH));
    }

    /// @notice Allows a keeper to select a smaller executable batch if current pool depth is thin.
    function executeBuyback(uint256 ethIn) external returns (uint256 burned) {
        if (ethIn == 0 || ethIn > address(this).balance || ethIn > MAX_BUYBACK_BATCH) {
            revert InvalidBatch();
        }
        return _executeBuyback(ethIn);
    }

    function _executeBuyback(uint256 ethIn) internal returns (uint256 burned) {
        uint256 twapX96 = hook.consultPriceX96(TWAP_WINDOW);
        uint256 spot = router.quoteBuy(1 ether);
        uint256 twap = Math.mulDiv(twapX96, 1 ether, Q96);
        uint256 diff = spot > twap ? spot - twap : twap - spot;
        if (twap == 0 || Math.mulDiv(diff, BPS, twap) > MAX_SPOT_DEVIATION_BPS) {
            revert SpotTooFarFromTwap(spot, twap);
        }

        uint256 twapOut = Math.mulDiv(ethIn, twapX96, Q96);
        uint256 minOut = Math.mulDiv(twapOut, BPS - MAX_EXECUTION_DISCOUNT_BPS, BPS);
        burned = router.buy{value: ethIn}(minOut, address(this));
        coat.burn(burned);
        emit BuybackExecuted(msg.sender, ethIn, burned);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockWETH} from "./Mocks.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {TestnetAsset, TestnetV3Pool, TestnetRialtoPool} from "../src/testnet/TestnetVenue.sol";

contract TestnetVenueTest is Test {
    function test_chain46630VenueExercisesFullStockRouterPath() public {
        vm.chainId(46630);
        MockWETH weth = new MockWETH();
        TestnetAsset usdg = new TestnetAsset("Test USDG", "tUSDG", address(this));
        TestnetAsset stock = new TestnetAsset("Test AAPL", "tAAPL", address(this));
        TestnetV3Pool mid = new TestnetV3Pool(address(weth), address(usdg), 2_000, 1);
        TestnetRialtoPool stockPool = new TestnetRialtoPool(address(usdg), address(stock), 1, 200);
        usdg.mint(address(mid), 10_000 ether);
        stock.mint(address(stockPool), 1_000 ether);

        StockRouter router = new StockRouter(address(weth), address(this));
        router.setRoute(
            address(stock), address(mid), address(usdg), address(stockPool), StockRouter.PoolKind.Rialto
        );

        uint256 out = router.swapExactETHForStock{value: 1 ether}(
            address(stock), 9 ether, address(this), block.timestamp
        );
        assertEq(out, 10 ether);
        assertEq(stock.balanceOf(address(this)), 10 ether);
    }

    function test_venueCannotDeployOnMainnet() public {
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSignature("WrongTestnet(uint256)", 4663));
        new TestnetAsset("No", "NO", address(this));
    }
}

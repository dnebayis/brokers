// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {IAggregatorV3} from "../src/interfaces/IExternal.sol";

interface IRialtoPoolFork {
    function fermi() external view returns (address);
}

interface IFermiFork {
    function lastUpdateBlock() external view returns (uint256);
}

/// @notice Production route probe against the real mainnet pools and official feeds.
/// Run with REQUIRE_MAINNET_FORK=true in the release gate so a missing/wrong RPC fails.
contract ForkStockRoutesTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant MID_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function test_allManifestRoutesBuyOnRealPools() public {
        if (block.chainid != 4663) {
            require(!vm.envOr("REQUIRE_MAINNET_FORK", false), "required RH mainnet fork missing");
            return;
        }

        uint256 forkL2Block = block.number;
        emit log_named_uint("route probe L2 block", forkL2Block);

        address[5] memory stocks = [
            0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9,
            0x86923f96303D656E4aa86D9d42D1e57ad2023fdC,
            0x12f190a9F9d7D37a250758b26824B97CE941bF54,
            0x6330D8C3178a418788dF01a47479c0ce7CCF450b,
            0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5
        ];
        address[5] memory pools = [
            0x957BB4b86CCC706D44983fb889ED63c6F9Bdc662,
            0xaF7e236Fd675a4dE1A393516105dB8AFb53DC1EB,
            0x3785715B43Ed03Da120f4aE7B23bB1274d5E02Dd,
            0x33918df3a039312217524491f60e9e69000c30c9,
            0x2099FEde2Ae9C852c753280b6011E6D622868C08
        ];
        address[5] memory feeds = [
            0x6B22A786bAa607d76728168703a39Ea9C99f2cD0,
            0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72,
            0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C,
            0xA3a468A452940B7D6b69991207B508c609a98Ef2,
            0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a
        ];

        StockRouter router = new StockRouter(WETH, address(this));
        vm.deal(address(this), 1 ether);
        for (uint256 i; i < stocks.length; ++i) {
            router.setRoute(stocks[i], MID_POOL, USDG, pools[i], StockRouter.PoolKind.Rialto);
            (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(feeds[i]).latestRoundData();
            assertGt(answer, 0, "stock feed is non-positive");
            assertGt(updatedAt, 0, "stock feed has no timestamp");

            address fermi = IRialtoPoolFork(pools[i]).fermi();
            vm.roll(IFermiFork(fermi).lastUpdateBlock());
            uint256 out =
                router.swapExactETHForStock{value: 0.001 ether}(stocks[i], 1, address(this), block.timestamp);
            assertGt(out, 0, "route produced no stock");
        }
    }
}

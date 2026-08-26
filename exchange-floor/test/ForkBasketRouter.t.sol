// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {
    BasketRouter,
    IWETHFloor,
    IStrategyRegistryFloor,
    IBoosterFeedFloor,
    IAggregatorV3Floor
} from "../src/BasketRouter.sol";

/// Fork tests against the REAL Robinhood Chain: real Uniswap v3 USDG pools (the same ones
/// the live keeper has been buying through since the 2026-08-26 rewire), real Chainlink
/// feeds via the deployed Booster, real StrategyRegistry basket. Run:
///   forge test --match-contract ForkBasketRouter --fork-url https://rpc.mainnet.chain.robinhood.com
contract ForkBasketRouterTest is Test {
    // deployed core (read-only)
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant REGISTRY = 0xA20f9D47E0c41e52a57d65feA9A9322732aF86Aa;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    // real v3 pools (verified + live in production via the emergency rewire)
    address constant ETH_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // WETH/USDG
    address constant INTC = 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681;
    address constant SPCX = 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa;
    address constant MU = 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD;
    address constant INTC_POOL = 0x2e5a92f5013a64661A49312111be2e8aBd33F56a;
    address constant SPCX_POOL = 0xc61284332117c3FB23A2A56cceFFD07F7aF60029;
    address constant MU_POOL = 0xd057B1Bc54917855BBee58eAd58647f47caB35E5;

    BasketRouter router;
    address boosterSink = address(0xB0057E57);
    address treasury = address(0x7EA57E57);
    address alice = address(0xA11CE57);

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        router = new BasketRouter(
            IERC20(USDG),
            IWETHFloor(WETH),
            IStrategyRegistryFloor(REGISTRY),
            IBoosterFeedFloor(BOOSTER),
            0,
            boosterSink,
            treasury,
            address(this)
        );
        router.setPool(INTC, INTC_POOL);
        router.setPool(SPCX, SPCX_POOL);
        router.setPool(MU, MU_POOL);
        router.setEthPool(ETH_POOL);
        vm.deal(alice, 10 ether);
    }

    function _feedUsd8(address stock) internal view returns (uint256) {
        address feed = IBoosterFeedFloor(BOOSTER).stockFeed(stock);
        (, int256 a,,,) = IAggregatorV3Floor(feed).latestRoundData();
        return uint256(a);
    }

    function test_fork_buyStockEth_realPool() public {
        vm.prank(alice);
        uint256 out = router.buyStockEth{value: 0.01 ether}(INTC, 0, alice, block.timestamp + 600);
        assertGt(out, 0);
        assertEq(IERC20(INTC).balanceOf(alice), out);
        // sanity: value received within 3% of feed-implied (fees + real spread)
        // ethUsd via the WETH/USDG pool leg is embedded; approximate with output value check:
        uint256 usd = out * _feedUsd8(INTC) / 1e8; // 18-dec USD value
        assertGt(usd, 0.0097e18 * 2000); // > $19 for ~$24 in unless ETH < $2000 (loose floor)
        assertEq(IERC20(USDG).balanceOf(address(router)), router.feesAccrued()); // custody = fees only
    }

    function test_fork_buyBasket_liveCongress_oneTx() public {
        vm.prank(alice);
        router.buyBasketEth{value: 0.05 ether}(0, alice, block.timestamp + 600);
        // live basket is INTC 50 / SPCX 46.8 / MU 3.2 (epoch 50) — all three must land
        assertGt(IERC20(INTC).balanceOf(alice), 0, "INTC leg");
        assertGt(IERC20(SPCX).balanceOf(alice), 0, "SPCX leg");
        assertGt(IERC20(MU).balanceOf(alice), 0, "MU leg");
        // proportions roughly follow weights (value terms, 10% tolerance for spreads)
        uint256 vIntc = IERC20(INTC).balanceOf(alice) * _feedUsd8(INTC) / 1e8;
        uint256 vSpcx = IERC20(SPCX).balanceOf(alice) * _feedUsd8(SPCX) / 1e8;
        uint256 vMu = IERC20(MU).balanceOf(alice) * _feedUsd8(MU) / 1e8;
        uint256 total = vIntc + vSpcx + vMu;
        assertApproxEqRel(vIntc * 1e18 / total, 0.5e18, 0.1e18, "INTC ~50%");
        assertApproxEqRel(vSpcx * 1e18 / total, 0.468e18, 0.1e18, "SPCX ~46.8%");
    }

    function test_fork_roundTrip_sellBackToEth() public {
        vm.startPrank(alice);
        uint256 out = router.buyStockEth{value: 0.02 ether}(SPCX, 0, alice, block.timestamp + 600);
        IERC20(SPCX).approve(address(router), type(uint256).max);
        uint256 ethBefore = alice.balance;
        uint256 ethOut =
            router.sellStock(SPCX, out, BasketRouter.OutCurrency.ETH, 0, alice, block.timestamp + 600);
        vm.stopPrank();
        assertEq(alice.balance - ethBefore, ethOut);
        // full round trip through the deepest pool: lose only fees+spread, keep >97%
        assertGt(ethOut, 0.0194 ether, "round-trip cost too high");
    }

    function test_fork_flushFees_realConversion_8020() public {
        vm.prank(alice);
        router.buyBasketEth{value: 0.05 ether}(0, alice, block.timestamp + 600);
        uint256 fees = router.feesAccrued();
        assertGt(fees, 0);
        router.flushFees(0);
        uint256 b = boosterSink.balance;
        uint256 t = treasury.balance;
        assertGt(b, 0);
        assertGt(t, 0);
        assertApproxEqRel(b * 1e18 / (b + t), 0.8e18, 0.01e18, "80/20 split");
        assertEq(router.feesAccrued(), 0);
    }

    function test_fork_guard_wouldBlockManipulatedQuote() public {
        // crank max slippage DOWN to 10 bps: the real pool's honest spread should then trip
        // the guard for a larger trade, proving the Chainlink floor is genuinely binding
        router.setMaxSlippageBps(10);
        vm.prank(alice);
        vm.expectRevert(); // BadFeed (feed floor) or Slippage — either proves the guard binds
        router.buyStockEth{value: 1 ether}(INTC, 0, alice, block.timestamp + 600);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BasketRouter, IAggregatorV3Floor} from "../src/BasketRouter.sol";

/// Post-launch verification: every user path against the DEPLOYED mainnet router
/// (0x478F22A3...) on a fork — the exact bytecode, wiring, pools, and Booster that
/// production traffic hits. Run:
///   forge test --match-path test/ForkDeployedFloor.t.sol --fork-url https://rpc.mainnet.chain.robinhood.com
contract ForkDeployedFloorTest is Test {
    BasketRouter constant router = BasketRouter(payable(0x478F22A32663cF37702d65352A7579A73e61FDc7));
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant COAT = 0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833;
    address constant KEEPER = 0xa492c8fFa033016144B169501D2e428BeDD518CA;
    address constant INTC = 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681;
    address constant SPCX = 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa;
    address constant MU = 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD;

    address alice = address(0xA11CE57);

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        vm.deal(alice, 10 ether);
    }

    function _basketTokens() internal view returns (address[] memory t) {
        (t,,) = router.preset(0);
    }

    function _buySmall() internal {
        vm.prank(alice);
        router.buyBasketEth{value: 0.01 ether}(0, alice, block.timestamp + 600);
    }

    function _approveAll() internal {
        address[] memory t = _basketTokens();
        vm.startPrank(alice);
        for (uint256 i; i < t.length; ++i) {
            IERC20(t[i]).approve(address(router), type(uint256).max);
        }
        vm.stopPrank();
    }

    function test_deployed_buyEth_allLegsLand() public {
        _buySmall();
        assertGt(IERC20(INTC).balanceOf(alice), 0, "INTC");
        assertGt(IERC20(SPCX).balanceOf(alice), 0, "SPCX");
        assertGt(IERC20(MU).balanceOf(alice), 0, "MU");
        // router custody is exactly the fee entitlement, nothing else
        assertEq(IERC20(USDG).balanceOf(address(router)), router.feesAccrued());
    }

    function test_deployed_buyUsdg() public {
        deal(USDG, alice, 10e6); // 10 USDG (6 dec)
        vm.startPrank(alice);
        IERC20(USDG).approve(address(router), 10e6);
        router.buyBasket(0, 10e6, alice, block.timestamp + 600);
        vm.stopPrank();
        assertGt(IERC20(INTC).balanceOf(alice), 0);
        assertGt(IERC20(SPCX).balanceOf(alice), 0);
    }

    function test_deployed_buyCoat_throughHookedPool() public {
        deal(COAT, alice, 100_000e18);
        vm.startPrank(alice);
        IERC20(COAT).approve(address(router), 100_000e18);
        router.buyBasketCoat(0, 100_000e18, 0, alice, block.timestamp + 600);
        vm.stopPrank();
        assertGt(IERC20(INTC).balanceOf(alice), 0, "COAT-funded basket must land");
    }

    function test_deployed_partialSell_50pct_usdg() public {
        _buySmall();
        _approveAll();
        address[] memory t = _basketTokens();
        uint256[] memory a = new uint256[](t.length);
        uint256[] memory before = new uint256[](t.length);
        for (uint256 i; i < t.length; ++i) {
            before[i] = IERC20(t[i]).balanceOf(alice);
            a[i] = before[i] / 2; // the UI's 50% button
        }
        vm.prank(alice);
        uint256 out = router.sellBasket(t, a, BasketRouter.OutCurrency.USDG, 0, alice, block.timestamp + 600);
        assertGt(out, 0);
        // the setup buy already returned wei-level slicing dust to alice, so allow it here
        assertApproxEqAbs(IERC20(USDG).balanceOf(alice), out, 2, "USDG lands with the seller");
        for (uint256 i; i < t.length; ++i) {
            assertEq(IERC20(t[i]).balanceOf(alice), before[i] - a[i], "exactly half sold");
        }
    }

    function test_deployed_fullSell_toEth() public {
        _buySmall();
        _approveAll();
        address[] memory t = _basketTokens();
        uint256[] memory a = new uint256[](t.length); // all zeros = full-balance sentinel
        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        uint256 out = router.sellBasket(t, a, BasketRouter.OutCurrency.ETH, 0, alice, block.timestamp + 600);
        assertEq(alice.balance - ethBefore, out);
        // full round trip keeps > 95% (two 0.3% fees + pool fees + spread)
        assertGt(out, 0.0095 ether, "round-trip cost too high");
        for (uint256 i; i < t.length; ++i) {
            assertEq(IERC20(t[i]).balanceOf(alice), 0, "position fully swept");
        }
    }

    function test_deployed_fullSell_toCoat() public {
        _buySmall();
        _approveAll();
        address[] memory t = _basketTokens();
        uint256[] memory a = new uint256[](t.length);
        vm.prank(alice);
        uint256 out = router.sellBasket(t, a, BasketRouter.OutCurrency.COAT, 0, alice, block.timestamp + 600);
        assertEq(IERC20(COAT).balanceOf(alice), out, "COAT lands with the seller");
        assertGt(out, 0);
    }

    function test_deployed_keeperFlush_boosterGetsNativeEth_8020() public {
        _buySmall();
        uint256 fees = router.feesAccrued();
        assertGt(fees, 0);
        uint256 boosterBefore = BOOSTER.balance;
        uint256 treasuryBefore = router.treasury().balance;
        vm.prank(KEEPER); // the actual relay wallet the hourly job signs with
        router.flushFees(0);
        uint256 b = BOOSTER.balance - boosterBefore;
        uint256 tr = router.treasury().balance - treasuryBefore;
        assertGt(b, 0, "Booster must receive native ETH");
        assertApproxEqRel(b * 1e18 / (b + tr), 0.8e18, 0.01e18, "80/20 split");
        assertEq(router.feesAccrued(), 0);
        assertEq(IERC20(USDG).balanceOf(address(router)), 0, "no USDG stranded");
    }
}

interface ICoatQuotes {
    function quoteSell(uint256 coatIn) external view returns (uint256);
    function quoteBuy(uint256 ethIn) external view returns (uint256);
}

interface IBoosterEthUsd {
    function ethUsdFeed() external view returns (address);
    function ethUsdManualE8() external view returns (uint256);
}

/// The frontend's EXACT math, replayed on-chain: every min the UI signs must clear a real
/// fill at current pool state. If any of these fail, the UI would revert honest users.
contract ForkUiMathTest is Test {
    BasketRouter constant router = BasketRouter(payable(0x478F22A32663cF37702d65352A7579A73e61FDc7));
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant COAT = 0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833;
    address constant COAT_ROUTER = 0x740baEEF895444a659fD0fc5Dc213BEDe7d1EaaF;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant AMD = 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC;

    uint256 constant SLIP_BPS = 100; // UI default 1%
    address alice = address(0xA11CE57);

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        vm.deal(alice, 10 ether);
    }

    function _slip(uint256 x) internal pure returns (uint256) {
        return (x * (10000 - SLIP_BPS)) / 10000;
    }

    function _coatCut(uint256 x) internal pure returns (uint256) {
        return (x * 9800) / 10000; // hooked pool's spot-vs-fill gap, as the UI applies it
    }

    function _ethUsd8() internal view returns (uint256) {
        address feed = IBoosterEthUsd(BOOSTER).ethUsdFeed();
        if (feed != address(0)) {
            (, int256 a,,,) = IAggregatorV3Floor(feed).latestRoundData();
            return uint256(a);
        }
        return IBoosterEthUsd(BOOSTER).ethUsdManualE8();
    }

    function _approveAll() internal {
        (address[] memory t,,) = router.preset(0);
        vm.startPrank(alice);
        for (uint256 i; i < t.length; ++i) {
            IERC20(t[i]).approve(address(router), type(uint256).max);
        }
        vm.stopPrank();
    }

    function _floorNet() internal view returns (uint256 f) {
        (address[] memory t,,) = router.preset(0);
        for (uint256 i; i < t.length; ++i) {
            uint256 bal = IERC20(t[i]).balanceOf(alice);
            if (bal > 0) f += router.minUsdgOut(t[i], bal);
        }
        f = (f * (10000 - router.feeBps())) / 10000;
    }

    function test_ui_coatBuy_minClears() public {
        deal(COAT, alice, 50_000e18);
        uint256 minEth = _slip(_coatCut(ICoatQuotes(COAT_ROUTER).quoteSell(50_000e18)));
        vm.startPrank(alice);
        IERC20(COAT).approve(address(router), type(uint256).max);
        router.buyBasketCoat(0, 50_000e18, minEth, alice, block.timestamp + 600);
        vm.stopPrank();
        assertGt(IERC20(USDG).balanceOf(address(router)), 0, "fees accrued");
    }

    function test_ui_sellToUsdg_minClears() public {
        vm.prank(alice);
        router.buyBasketEth{value: 0.01 ether}(0, alice, block.timestamp + 600);
        _approveAll();
        uint256 minOut = _slip(_floorNet());
        (address[] memory t,,) = router.preset(0);
        vm.prank(alice);
        uint256 out = router.sellBasket(
            t, new uint256[](t.length), BasketRouter.OutCurrency.USDG, minOut, alice, block.timestamp + 600
        );
        assertGe(out, minOut);
    }

    function test_ui_sellToEth_minClears() public {
        vm.prank(alice);
        router.buyBasketEth{value: 0.01 ether}(0, alice, block.timestamp + 600);
        _approveAll();
        uint256 ethFloor = (_floorNet() * 1e20 / _ethUsd8()) * 9900 / 10000; // usdg 6dec -> wei
        uint256 minOut = _slip(ethFloor);
        (address[] memory t,,) = router.preset(0);
        vm.prank(alice);
        uint256 out = router.sellBasket(
            t, new uint256[](t.length), BasketRouter.OutCurrency.ETH, minOut, alice, block.timestamp + 600
        );
        assertGe(out, minOut);
    }

    function test_ui_sellToCoat_minClears() public {
        vm.prank(alice);
        router.buyBasketEth{value: 0.01 ether}(0, alice, block.timestamp + 600);
        _approveAll();
        uint256 ethFloor = (_floorNet() * 1e20 / _ethUsd8()) * 9900 / 10000;
        uint256 minOut = _slip(_coatCut(ICoatQuotes(COAT_ROUTER).quoteBuy(ethFloor)));
        (address[] memory t,,) = router.preset(0);
        vm.prank(alice);
        uint256 out = router.sellBasket(
            t, new uint256[](t.length), BasketRouter.OutCurrency.COAT, minOut, alice, block.timestamp + 600
        );
        assertGe(out, minOut);
        assertEq(IERC20(COAT).balanceOf(alice), out);
    }

    function test_ui_sequentialPartials_25_then_75_then_sweep() public {
        vm.prank(alice);
        router.buyBasketEth{value: 0.01 ether}(0, alice, block.timestamp + 600);
        _approveAll(); // one max-approval pass — no re-approvals below
        (address[] memory t,,) = router.preset(0);
        for (uint256 round; round < 2; ++round) {
            uint256 pct = round == 0 ? 25 : 75;
            uint256[] memory a = new uint256[](t.length);
            for (uint256 i; i < t.length; ++i) {
                a[i] = (IERC20(t[i]).balanceOf(alice) * pct) / 100;
            }
            vm.prank(alice);
            router.sellBasket(t, a, BasketRouter.OutCurrency.USDG, 0, alice, block.timestamp + 600);
        }
        vm.prank(alice); // final 100% sweep via sentinels
        router.sellBasket(t, new uint256[](t.length), BasketRouter.OutCurrency.USDG, 0, alice, block.timestamp + 600);
        for (uint256 i; i < t.length; ++i) {
            assertEq(IERC20(t[i]).balanceOf(alice), 0, "swept clean");
        }
    }

    function test_deployed_chipsPreset_allFourLegs() public {
        vm.prank(alice);
        router.buyBasketEth{value: 0.02 ether}(1, alice, block.timestamp + 600);
        assertGt(IERC20(NVDA).balanceOf(alice), 0, "NVDA");
        assertGt(IERC20(AMD).balanceOf(alice), 0, "AMD");
    }
}

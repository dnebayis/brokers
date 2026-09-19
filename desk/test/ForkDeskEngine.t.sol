// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeskNFT, IERC6551RegistryDesk} from "../src/DeskNFT.sol";
import {DeskAccount} from "../src/DeskAccount.sol";
import {CoatBonusPool, ICoattailBrokerView} from "../src/CoatBonusPool.sol";
import {
    DeskEngine,
    IWETHDesk,
    IDeskNFTView,
    IStrategyRegistryView,
    IBoosterFeedView
} from "../src/DeskEngine.sol";

/// Build order step 4: the engine against the REAL mainnet venues. Deploys the four Desk
/// contracts on a fork of chain 4663 (nothing deployed for real), opens a desk, funds it
/// with USDG and runs the live Congress basket through the same Uniswap v3 USDG pools the
/// Booster's StockRouter uses, with the Booster's own Chainlink feeds as the floor.
///
///   forge test --match-path test/ForkDeskEngine.t.sol -vv
contract ForkDeskEngineTest is Test {
    // mainnet (chain 4663) — see ADDRESSES.md and indexer/route-ready.mainnet.json
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant COAT = 0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833;
    address constant BROKERS = 0x1122dB21998707F8c2eD8182734356C947fA5e98;
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant STRATEGY_REGISTRY = 0xA20f9D47E0c41e52a57d65feA9A9322732aF86Aa;
    address constant REGISTRY_6551 = 0x000000006551c19487814612e58FE06813775758;
    address constant MID_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // WETH/USDG, 1 bp
    address constant INTC = 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681;
    address constant INTC_POOL = 0x2e5a92f5013a64661A49312111be2e8aBd33F56a;
    address constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
    address constant MSFT_POOL = 0xeb60bCD1D920ad6E102690CCFC6fB488899E1510;

    uint256 constant U = 1e6;
    address treasury = address(0x7EA5);
    address alice = address(0xA11CE);

    CoatBonusPool bonus;
    DeskAccount impl;
    DeskNFT desks;
    DeskEngine engine;

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        require(block.chainid == 4663, "mainnet fork");

        bonus = new CoatBonusPool(IERC20(COAT), ICoattailBrokerView(BROKERS), address(this), address(this));
        uint64 nonce = vm.getNonce(address(this));
        address predictedEngine = vm.computeCreateAddress(address(this), nonce + 2);
        impl = new DeskAccount(predictedEngine);
        desks = new DeskNFT(IERC20(COAT), address(bonus), IERC6551RegistryDesk(REGISTRY_6551), address(impl), address(this));
        engine = new DeskEngine(
            IERC20(USDG),
            IWETHDesk(WETH),
            IDeskNFTView(address(desks)),
            IStrategyRegistryView(STRATEGY_REGISTRY),
            IBoosterFeedView(BOOSTER),
            0,
            BOOSTER,
            treasury,
            address(this)
        );
        assertEq(address(engine), predictedEngine, "engine address prediction");

        engine.setPool(INTC, INTC_POOL);
        engine.setPool(MSFT, MSFT_POOL);
        engine.setEthPool(MID_POOL);
        desks.setMintOpen(true);
        desks.setMintPrice(0);
    }

    function _openDesk(uint256 fundUsdg) internal returns (uint256 id, address acct) {
        vm.prank(alice);
        (id, acct) = desks.mint();
        deal(USDG, acct, fundUsdg);
        assertEq(IERC20(USDG).balanceOf(acct), fundUsdg, "usdg funded");
    }

    function test_live_basket_is_intc_and_msft_with_feeds_and_pools() public view {
        (address[] memory tokens, uint16[] memory weights,) = IStrategyRegistryView(STRATEGY_REGISTRY).getBasket(0);
        assertEq(tokens.length, 2);
        for (uint256 i; i < tokens.length; ++i) {
            assertTrue(tokens[i] == INTC || tokens[i] == MSFT, "basket names covered by the test's pools");
            assertTrue(IBoosterFeedView(BOOSTER).stockFeed(tokens[i]) != address(0), "booster feed present");
            assertGt(weights[i], 0);
        }
    }

    function test_buys_the_live_basket_into_the_desk_wallet_at_real_pools() public {
        (uint256 id, address acct) = _openDesk(500 * U);
        (address[] memory tokens, uint16[] memory weights,) = IStrategyRegistryView(STRATEGY_REGISTRY).getBasket(0);

        engine.buyBasket(id, 500 * U);

        uint256 fee = (500 * U * engine.feeBps()) / engine.BPS();
        uint256 net = 500 * U - fee;
        assertEq(engine.feesAccrued(), fee, "0.5% fee kept by the engine");
        assertEq(engine.deployedUsdg(id), 500 * U, "gross cap accounting");
        assertEq(IERC20(USDG).balanceOf(address(engine)), fee, "engine holds only its fee");
        assertLt(IERC20(USDG).balanceOf(acct), 10, "desk spent down to slicing dust");

        for (uint256 i; i < tokens.length; ++i) {
            uint256 slice = (net * weights[i]) / engine.BPS();
            uint256 got = IERC20(tokens[i]).balanceOf(acct);
            uint256 floor = engine.minStockOut(tokens[i], slice);
            assertGe(got, floor, "fill above the chainlink floor");
            // and not absurdly above it either: the floor is 5% under oracle, so a real fill
            // sits within a few percent of oracle price.
            assertLt(got, (floor * 11_000) / 9_500, "fill near oracle price");
            // oracle-implied amount = floor / 0.95; deviation in bps, negative = below oracle
            uint256 oracleAmt = (floor * 10_000) / 9_500;
            console2.log("stock", tokens[i]);
            console2.log("  slice usdg (6dp)", slice);
            console2.log("  got (18dp)", got);
            console2.log("  vs oracle, bps (10000 = par)", (got * 10_000) / oracleAmt);
        }
    }

    function test_sells_back_to_usdg_and_flushes_fees_to_the_booster_as_eth() public {
        (uint256 id, address acct) = _openDesk(400 * U);
        engine.buyBasket(id, 400 * U);
        uint256 intcHeld = IERC20(INTC).balanceOf(acct);
        uint256 usdgBefore = IERC20(USDG).balanceOf(acct);

        engine.sellStock(id, INTC, intcHeld / 2);

        uint256 usdgBack = IERC20(USDG).balanceOf(acct) - usdgBefore;
        assertGt(usdgBack, engine.minUsdgOut(INTC, intcHeld / 2), "sell above the chainlink floor");
        assertEq(IERC20(INTC).balanceOf(acct), intcHeld - intcHeld / 2, "half the position left");
        assertLt(engine.deployedUsdg(id), 400 * U, "cap accounting released the returned usdg");

        uint256 fees = engine.feesAccrued();
        uint256 boosterEth = BOOSTER.balance;
        uint256 treasuryEth = treasury.balance;
        engine.flushFees(0);
        assertEq(engine.feesAccrued(), 0);
        uint256 toBooster = BOOSTER.balance - boosterEth;
        uint256 toTreasury = treasury.balance - treasuryEth;
        assertGt(toBooster, 0, "booster received native eth");
        assertEq(toBooster, ((toBooster + toTreasury) * 8000) / 10_000, "80/20 split");
        assertEq(IERC20(USDG).balanceOf(address(engine)), 0, "no usdg left in the engine");
        assertEq(IERC20(WETH).balanceOf(address(engine)), 0, "no weth left in the engine");
        assertGt(fees, 0);
    }

    function test_pilot_cap_holds_against_real_fills() public {
        (uint256 id,) = _openDesk(1_500 * U);
        engine.buyBasket(id, 1_500 * U);
        assertEq(engine.deployedUsdg(id), 1_000 * U, "clipped to the pilot cap");
        assertEq(engine.capLeftOf(id), 0);
        vm.expectRevert(abi.encodeWithSelector(DeskEngine.CapExceeded.selector, 500 * U, 0));
        engine.buyBasket(id, 500 * U);
    }

    function test_owner_can_pause_the_engine_and_pull_out() public {
        (uint256 id, address acct) = _openDesk(100 * U);
        vm.prank(alice);
        DeskAccount(payable(acct)).setEnginePaused(true);
        vm.expectRevert();
        engine.buyBasket(id, 100 * U);
        assertEq(IERC20(USDG).balanceOf(acct), 100 * U, "nothing moved while paused");
    }
}

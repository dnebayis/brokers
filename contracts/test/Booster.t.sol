// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoattailBroker, IBoosterHook, ICoatBurnable} from "../src/CoattailBroker.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";
import {Booster} from "../src/Booster.sol";
import {COAT} from "../src/COAT.sol";
import {IERC6551Registry, IStockRouter, IWETH, IAggregatorV3} from "../src/interfaces/IExternal.sol";
import {MockRegistry6551, MockWETH, MockERC20, MockRouter, MockAggregator} from "./Mocks.sol";

contract BoosterTest is Test {
    CoattailBroker broker;
    StrategyRegistry registry;
    Booster booster;
    COAT coat;
    MockRegistry6551 accReg;
    MockWETH weth;
    MockERC20 stock;
    MockRouter router;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");
    address user2 = makeAddr("user2");
    address impl = makeAddr("impl");
    uint256[] mintedIds;

    uint256 constant N = 4;
    uint256 constant RATE = 2; // stock out per WETH in
    uint256 constant BURN = 36_750 ether;

    function setUp() public {
        accReg = new MockRegistry6551();
        broker = new CoattailBroker(owner, treasury, IERC6551Registry(address(accReg)), impl, "");
        vm.prank(owner);
        broker.setMintOpen(true);

        // Four random-ID Brokers across two primary-minter wallets (cap = 2 each).
        uint256 unit = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        broker.mint{value: unit * 2}(2);
        vm.deal(user2, 1 ether);
        vm.prank(user2);
        broker.mint{value: unit * 2}(2);
        _collectOwned(user);
        _collectOwned(user2);
        assertEq(mintedIds.length, N);

        // strategy 0 = single stock, 100%
        registry = new StrategyRegistry(owner, owner);
        vm.prank(owner);
        registry.createStrategy("The Politician");
        stock = new MockERC20("Tokenized NVDA", "NVDA");
        address[] memory tokens = new address[](1);
        uint16[] memory weights = new uint16[](1);
        tokens[0] = address(stock);
        weights[0] = 10000;
        vm.prank(owner);
        registry.setStrategy(0, tokens, weights);

        // booster + venue mocks
        weth = new MockWETH();
        router = new MockRouter(RATE);
        booster = new Booster(broker, registry, IStockRouter(address(router)), IWETH(address(weth)), 0, owner);

        // $COAT (owner is distributor) + wiring
        coat = new COAT(owner, makeAddr("coatPoolManager"));
        vm.startPrank(owner);
        broker.setBooster(IBoosterHook(address(booster)));
        broker.setCoat(ICoatBurnable(address(coat)));
        coat.transfer(user, 2_000_000 ether);
        coat.transfer(user2, 2_000_000 ether);
        // existing accrual tests run without a price guard (min-out 0), explicitly.
        booster.setAllowUnguarded(address(stock), true);
        vm.stopPrank();

        // Each token is an independent earning share, regardless of its random ID.
        vm.prank(user);
        coat.approve(address(broker), type(uint256).max);
        vm.prank(user2);
        coat.approve(address(broker), type(uint256).max);
        for (uint256 i; i < N; ++i) {
            address tokenOwner = broker.ownerOf(mintedIds[i]);
            vm.prank(tokenOwner);
            broker.activate(mintedIds[i]);
        }
    }

    function test_activation_burnsCoat_andCountsShares() public view {
        assertEq(booster.activeShares(), N);
        assertTrue(broker.activated(mintedIds[0]));
        assertEq(coat.balanceOf(user), 2_000_000 ether - 2 * BURN);
        assertEq(coat.balanceOf(user2), 2_000_000 ether - 2 * BURN);
    }

    function test_poke_buysBasket_and_accrues() public {
        vm.deal(address(booster), 1 ether);
        booster.poke();
        assertEq(stock.balanceOf(address(booster)), 1 ether * RATE);
        // accPerShare = out * 1e18 / activeShares(=4)
        assertEq(booster.accPerShare(address(stock)), (1 ether * RATE) * 1e18 / N);
    }

    function test_oversizedDonationIsProcessedInResumableBatches() public {
        vm.deal(address(booster), 10 ether);
        booster.poke();
        assertEq(address(booster).balance, 9 ether);
        assertEq(stock.balanceOf(address(booster)), 2 ether);

        booster.poke(0.1 ether);
        assertEq(address(booster).balance, 8.9 ether);
        assertEq(stock.balanceOf(address(booster)), 2.2 ether);

        vm.expectRevert(Booster.InvalidPokeBatch.selector);
        booster.poke(2 ether);
    }

    function test_poke_skipsWhenNoActiveShares() public {
        // fresh broker with a minted-but-inactive token earns nothing
        uint256 p = broker.mintPriceWei();
        address inactiveMinter = makeAddr("inactiveMinter");
        vm.deal(inactiveMinter, 1 ether);
        vm.prank(inactiveMinter);
        broker.mint{value: p}(1);
        Booster b2 =
            new Booster(broker, registry, IStockRouter(address(router)), IWETH(address(weth)), 0, owner);
        vm.deal(address(b2), 1 ether);
        b2.poke(); // activeShares 0 -> no-op, ETH untouched
        assertEq(address(b2).balance, 1 ether);
        assertEq(b2.accPerShare(address(stock)), 0);
    }

    function test_claim_distributesProRata_toTBA() public {
        vm.deal(address(booster), 1 ether);
        booster.poke();

        uint256 owedEach = (1 ether * RATE) / N; // 0.5e18
        for (uint256 i; i < N; ++i) {
            uint256 tokenId = mintedIds[i];
            address tba = broker.accountOf(tokenId);
            vm.prank(broker.ownerOf(tokenId));
            booster.claim(tokenId);
            assertEq(stock.balanceOf(tba), owedEach);
        }
        assertEq(stock.balanceOf(address(booster)), 0);
    }

    function test_inactiveBroker_earnsNothing_afterTransfer() public {
        address buyer = makeAddr("buyer");
        uint256 tokenId = mintedIds[0];
        vm.deal(address(booster), 1 ether);
        booster.poke();

        // transfer token 1 -> deactivates it; accrued crystallizes to pending
        vm.prank(user);
        broker.transferFrom(user, buyer, tokenId);
        assertFalse(broker.activated(tokenId));
        assertEq(booster.activeShares(), N - 1);

        // a second poke now splits only among the 3 still-active brokers
        vm.deal(address(booster), 1 ether);
        booster.poke();

        // token 1 (inactive) is still owed exactly its first-poke share, no more
        (, uint256[] memory amts) = booster.claimable(tokenId);
        assertEq(amts[0], (1 ether * RATE) / N); // 0.5e18, unchanged by poke #2

        // buyer claims token 1's crystallized reward into the (transferred) wallet
        address tba = broker.accountOf(tokenId);
        vm.prank(buyer);
        booster.claim(tokenId);
        assertEq(stock.balanceOf(tba), (1 ether * RATE) / N);
    }

    function test_reactivation_requiresReburn_andResumesEarning() public {
        address buyer = makeAddr("buyer");
        uint256 tokenId = mintedIds[0];
        vm.prank(user);
        broker.transferFrom(user, buyer, tokenId);

        // buyer must own COAT + approve to re-activate
        vm.prank(owner);
        coat.transfer(buyer, BURN);
        vm.startPrank(buyer);
        coat.approve(address(broker), BURN);
        broker.activate(tokenId);
        vm.stopPrank();

        assertTrue(broker.activated(tokenId));
        assertEq(booster.activeShares(), N); // back to 4
    }

    function test_activate_revertsIfNotOwner() public {
        vm.expectRevert(CoattailBroker.NotOwner.selector);
        vm.prank(makeAddr("stranger"));
        broker.activate(mintedIds[0]);
    }

    function test_activate_revertsIfAlreadyActive() public {
        vm.expectRevert(CoattailBroker.AlreadyActivated.selector);
        vm.prank(user);
        broker.activate(mintedIds[0]);
    }

    // --- slippage guard ---

    function test_guard_revertsWhenNoFeedAndNotAllowed() public {
        vm.prank(owner);
        booster.setAllowUnguarded(address(stock), false);
        vm.deal(address(booster), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Booster.GuardMissing.selector, address(stock)));
        booster.poke();
    }

    function test_guard_revertsWhenNoEthPrice() public {
        vm.startPrank(owner);
        booster.setAllowUnguarded(address(stock), false);
        booster.setStockFeed(address(stock), IAggregatorV3(address(new MockAggregator(1000e8))));
        vm.stopPrank();
        vm.deal(address(booster), 1 ether);
        vm.expectRevert(Booster.NoEthPrice.selector);
        booster.poke();
    }

    function test_guard_blocksBadPrice() public {
        // Feeds say 1 ETH should buy 3 tokens (3000/1000); pool only gives RATE=2 → revert.
        vm.startPrank(owner);
        booster.setAllowUnguarded(address(stock), false);
        booster.setEthUsdFeed(IAggregatorV3(address(new MockAggregator(3000e8))));
        booster.setStockFeed(address(stock), IAggregatorV3(address(new MockAggregator(1000e8))));
        vm.stopPrank();
        vm.deal(address(booster), 1 ether);
        vm.expectRevert(bytes("slippage"));
        booster.poke();
    }

    function test_guard_allowsFairPrice() public {
        // Feeds say 1 ETH ≈ 1 token (3000/3000); pool gives 2 → well above floor, passes.
        vm.startPrank(owner);
        booster.setAllowUnguarded(address(stock), false);
        booster.setEthUsdFeed(IAggregatorV3(address(new MockAggregator(3000e8))));
        booster.setStockFeed(address(stock), IAggregatorV3(address(new MockAggregator(3000e8))));
        vm.stopPrank();
        vm.deal(address(booster), 1 ether);
        booster.poke();
        assertEq(booster.accPerShare(address(stock)), (1 ether * RATE) * 1e18 / N);
    }

    function test_guard_ethUsdManualFallback() public {
        // No ETH/USD feed on-chain → owner sets a manual price; guard still works.
        vm.startPrank(owner);
        booster.setAllowUnguarded(address(stock), false);
        booster.setStockFeed(address(stock), IAggregatorV3(address(new MockAggregator(3000e8))));
        booster.setEthUsdManual(3000e8);
        vm.stopPrank();
        vm.deal(address(booster), 1 ether);
        booster.poke(); // passes (expected 1e18, floor 0.95e18, out 2e18)
        assertGt(booster.accPerShare(address(stock)), 0);
    }

    function test_guard_minOut_view() public {
        vm.startPrank(owner);
        booster.setEthUsdFeed(IAggregatorV3(address(new MockAggregator(3000e8))));
        booster.setStockFeed(address(stock), IAggregatorV3(address(new MockAggregator(1000e8))));
        vm.stopPrank();
        // expected = 1e18 * 3000/1000 = 3e18; floor at 5% = 2.85e18
        assertEq(booster.minOut(address(stock), 1 ether), 2.85e18);
    }

    function test_setPokeThreshold() public {
        vm.prank(owner);
        booster.setPokeThreshold(0.001 ether);
        assertEq(booster.pokeThreshold(), 0.001 ether);
        // now a small buffer is pokeable
        vm.deal(address(booster), 0.001 ether);
        booster.poke();
        assertGt(booster.accPerShare(address(stock)), 0);
    }

    function test_setMaxSlippage_bounded() public {
        vm.prank(owner);
        vm.expectRevert(Booster.SlippageTooHigh.selector);
        booster.setMaxSlippageBps(10_001);
    }

    function test_setMaxSlippage_cappedAtCeiling() public {
        uint256 ceiling = booster.MAX_SLIPPAGE_CEILING_BPS();
        // owner cannot crank tolerance past the 20% ceiling (can't silently zero the guard)
        vm.prank(owner);
        vm.expectRevert(Booster.SlippageTooHigh.selector);
        booster.setMaxSlippageBps(ceiling + 1);

        vm.prank(owner);
        booster.setMaxSlippageBps(ceiling); // exactly at ceiling is ok
        assertEq(booster.maxSlippageBps(), ceiling);
    }

    function test_guard_multiplierAdjustedFeedIsNotScaledTwice() public {
        // Underlying share is $50. Official feed reports the corporate-action-adjusted
        // raw-token price: 0.5x => $25, 1x => $50, 2x => $100.
        vm.startPrank(owner);
        booster.setEthUsdFeed(IAggregatorV3(address(new MockAggregator(3000e8))));
        booster.setStockFeed(address(stock), IAggregatorV3(address(new MockAggregator(50e8))));
        vm.stopPrank();
        assertEq(booster.minOut(address(stock), 1 ether), 57e18);

        stock.setUiMultiplier(2e18);
        MockAggregator splitFeed = new MockAggregator(100e8);
        vm.prank(owner);
        booster.setStockFeed(address(stock), IAggregatorV3(address(splitFeed)));
        assertEq(booster.minOut(address(stock), 1 ether), 28.5e18);

        stock.setUiMultiplier(0.5e18);
        MockAggregator reverseSplitFeed = new MockAggregator(25e8);
        vm.prank(owner);
        booster.setStockFeed(address(stock), IAggregatorV3(address(reverseSplitFeed)));
        assertEq(booster.minOut(address(stock), 1 ether), 114e18);
    }

    function test_ownable2Step_transfer() public {
        address next = makeAddr("nextOwner");
        vm.prank(owner);
        booster.transferOwnership(next);
        assertEq(booster.owner(), owner); // not yet
        assertEq(booster.pendingOwner(), next);
        vm.prank(next);
        booster.acceptOwnership();
        assertEq(booster.owner(), next); // now
    }

    function test_claim_onlyOwner() public {
        vm.deal(address(booster), 1 ether);
        booster.poke();
        vm.expectRevert(Booster.NotBrokerOwner.selector);
        vm.prank(makeAddr("stranger"));
        booster.claim(mintedIds[0]);
    }

    function test_poke_belowThreshold_reverts() public {
        vm.deal(address(booster), 0.001 ether);
        vm.expectRevert();
        booster.poke();
    }

    function test_claimable_view_matches() public {
        vm.deal(address(booster), 1 ether);
        booster.poke();
        (address[] memory toks, uint256[] memory amts) = booster.claimable(mintedIds[0]);
        assertEq(toks[0], address(stock));
        assertEq(amts[0], (1 ether * RATE) / N);
    }

    // --- H-1: no ETH stranded as WETH ---

    function test_H1_poke_strandsNoWeth() public {
        vm.deal(address(booster), 1 ether);
        booster.poke();
        // poke wraps only what it spends; nothing is left behind as WETH.
        assertEq(weth.balanceOf(address(booster)), 0);
    }

    function test_H1_emptyBasket_returnsBeforeWrapping() public {
        // A strategy that is active but has no tokens posted yet.
        StrategyRegistry reg2 = new StrategyRegistry(owner, owner);
        vm.prank(owner);
        reg2.createStrategy("empty");
        Booster b2 = new Booster(broker, reg2, IStockRouter(address(router)), IWETH(address(weth)), 0, owner);
        vm.deal(address(b2), 1 ether);
        b2.poke(); // tokens.length == 0 -> early return, before any weth.deposit
        assertEq(address(b2).balance, 1 ether); // native ETH untouched
        assertEq(weth.balanceOf(address(b2)), 0); // nothing stranded
    }

    function test_H1_sweepWeth_recoversStrandedWeth() public {
        // Simulate legacy WETH sitting in the Booster (older poke or a stray deposit).
        vm.deal(address(booster), 3 ether);
        vm.prank(address(booster));
        weth.deposit{value: 3 ether}();
        assertEq(weth.balanceOf(address(booster)), 3 ether);

        address payable dest = payable(makeAddr("dest"));
        vm.prank(owner);
        booster.sweepWeth(dest);
        assertEq(weth.balanceOf(address(booster)), 0);
        assertEq(dest.balance, 3 ether); // recovered as native ETH
    }

    function test_H1_sweepWeth_onlyOwner() public {
        vm.expectRevert();
        vm.prank(user);
        booster.sweepWeth(payable(user));
    }

    // --- H-2: the reward-loop token set is hard-bounded ---

    function test_H2_knownTokenCap_enforced() public {
        uint256 cap = booster.MAX_KNOWN_TOKENS();
        uint256 n = cap + 1; // one past the limit
        address[] memory tokens = new address[](n);
        uint16[] memory weights = new uint16[](n);
        uint16 each = uint16(10_000 / n);

        vm.startPrank(owner);
        for (uint256 i; i < n; ++i) {
            MockERC20 t = new MockERC20("S", "S");
            tokens[i] = address(t);
            booster.setAllowUnguarded(address(t), true); // min-out 0 so swaps don't gate
            weights[i] = (i == 0) ? uint16(10_000 - each * uint16(n - 1)) : each;
        }
        registry.setStrategy(0, tokens, weights);
        vm.stopPrank();

        // large buffer so every per-token slice is non-zero and reaches _trackToken
        vm.deal(address(booster), 100 ether);
        vm.expectRevert(Booster.TokenCapReached.selector);
        booster.poke();
    }

    // --- M-4: fractional carry + safe token sweep ---

    function test_M4_fractionalRemainderIsCarried_notDiscarded() public {
        // Deactivate one broker so activeShares = 3 (a divisor that leaves a remainder).
        address buyer = makeAddr("buyer");
        uint256 transferredId = mintedIds[3];
        address transferredOwner = broker.ownerOf(transferredId);
        vm.prank(transferredOwner);
        broker.transferFrom(transferredOwner, buyer, transferredId);
        assertEq(booster.activeShares(), 3);

        // poke buys out = 1 ether * RATE = 2e18 stock, split across 3 shares → not divisible.
        vm.deal(address(booster), 1 ether);
        booster.poke();

        // token 1 claims: it gets the floored whole units, and the sub-unit remainder is
        // carried in pending (NOT discarded). Old behaviour left pending == 0 here.
        uint256 claimId = mintedIds[0];
        vm.prank(user);
        booster.claim(claimId);
        uint256 carried = booster.pending(claimId, address(stock));
        assertGt(carried, 0, "fractional remainder was discarded");
        assertLt(carried, 1e18, "carry should be a sub-unit remainder");
    }

    function test_M4_carryAccumulatesIntoWholeUnits() public {
        address buyer = makeAddr("buyer");
        uint256 transferredId = mintedIds[3];
        address transferredOwner = broker.ownerOf(transferredId);
        vm.prank(transferredOwner);
        broker.transferFrom(transferredOwner, buyer, transferredId); // activeShares = 3
        uint256 claimId = mintedIds[0];
        address tba = broker.accountOf(claimId);

        // Many small pokes then a single claim must deliver essentially floor(total/3),
        // with the carried fractions rolled in — strictly more than summing per-poke floors.
        uint256 pokes = 7;
        for (uint256 i; i < pokes; ++i) {
            vm.deal(address(booster), 1 ether);
            booster.poke();
        }
        vm.prank(user);
        booster.claim(claimId);

        uint256 got = stock.balanceOf(tba);
        uint256 perPokeFloor = (1 ether * RATE) / 3; // what naive per-poke flooring would give
        assertGt(got, perPokeFloor * pokes, "carry did not recover the accumulated fraction");
    }

    function test_M4_sweepToken_recoversOnlyNonOwed() public {
        // Accrue real rewards so there is genuine outstanding entitlement.
        vm.deal(address(booster), 1 ether);
        booster.poke();
        uint256 outstanding = booster.totalBought(address(stock)); // nothing claimed yet
        assertGt(outstanding, 0);

        // Someone airdrops extra stock into the Booster.
        stock.mint(address(booster), 5 ether);

        address dest = makeAddr("dest");
        vm.prank(owner);
        booster.sweepToken(address(stock), dest);

        // Only the airdrop is swept; the full entitlement is left untouched.
        assertEq(stock.balanceOf(dest), 5 ether);
        assertEq(stock.balanceOf(address(booster)), outstanding);
    }

    function test_M4_sweepToken_cannotTouchOwedRewards() public {
        vm.deal(address(booster), 1 ether);
        booster.poke();
        uint256 outstanding = stock.balanceOf(address(booster));

        // No airdrop: balance == outstanding, so a sweep must move nothing.
        address dest = makeAddr("dest");
        vm.prank(owner);
        booster.sweepToken(address(stock), dest);
        assertEq(stock.balanceOf(dest), 0, "sweep took owed rewards");
        assertEq(stock.balanceOf(address(booster)), outstanding);

        // and every active broker can still fully claim its share
        for (uint256 i; i < N; ++i) {
            uint256 tokenId = mintedIds[i];
            vm.prank(broker.ownerOf(tokenId));
            booster.claim(tokenId);
        }
        assertLe(stock.balanceOf(address(booster)), N, "brokers could not claim after sweep");
    }

    function test_M4_sweepToken_onlyOwner() public {
        vm.expectRevert();
        vm.prank(user);
        booster.sweepToken(address(stock), user);
    }

    function test_claimFor_isPermissionlessAndCannotRedirect() public {
        vm.deal(address(booster), 1 ether);
        booster.poke();
        uint256 tokenId = mintedIds[0];
        address tba = broker.accountOf(tokenId);
        address relayer = makeAddr("claimRelayer");
        vm.prank(relayer);
        booster.claimFor(tokenId);
        assertEq(stock.balanceOf(relayer), 0);
        assertEq(stock.balanceOf(tba), (1 ether * RATE) / N);
    }

    function test_claimBatch_isBoundedAndPaysEachTba() public {
        vm.deal(address(booster), 1 ether);
        booster.poke();
        uint256[] memory batch = new uint256[](2);
        batch[0] = mintedIds[0];
        batch[1] = mintedIds[1];
        booster.claimBatch(batch);
        assertEq(stock.balanceOf(broker.accountOf(batch[0])), (1 ether * RATE) / N);
        assertEq(stock.balanceOf(broker.accountOf(batch[1])), (1 ether * RATE) / N);

        uint256[] memory tooMany = new uint256[](booster.MAX_CLAIM_BATCH() + 1);
        vm.expectRevert(Booster.ClaimBatchTooLarge.selector);
        booster.claimBatch(tooMany);
    }

    function _collectOwned(address expectedOwner) internal {
        for (uint256 id = 1; id <= broker.MAX_SUPPLY(); ++id) {
            try broker.ownerOf(id) returns (address actualOwner) {
                if (actualOwner == expectedOwner) mintedIds.push(id);
            } catch {}
        }
    }
}

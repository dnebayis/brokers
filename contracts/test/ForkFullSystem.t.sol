// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BrokerAccount} from "../src/BrokerAccount.sol";
import {Booster} from "../src/Booster.sol";
import {COAT} from "../src/COAT.sol";
import {CoatFeeHook, IStateViewHook} from "../src/CoatFeeHook.sol";
import {CoatRouter, IPoolManagerFull, IStateView} from "../src/CoatRouter.sol";
import {CoattailBroker, IBoosterHook, ICoatBurnable} from "../src/CoattailBroker.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";
import {IERC6551Registry, IAggregatorV3, IStockRouter, IWETH} from "../src/interfaces/IExternal.sol";
import {Currency, PoolKey, IPoolManagerMinimal, HookFlags} from "../src/v4/V4Types.sol";

interface IPoolManagerLaunchE2E is IPoolManagerFull {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24);
}

interface IPositionManagerE2E {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
}

interface IAllowanceTransferE2E {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IRialtoPoolE2E {
    function fermi() external view returns (address);
}

interface IFermiE2E {
    function lastUpdateBlock() external view returns (uint256);
}

/// @notice One-fork production-path proof:
/// COAT v4 buy -> NFT mint/activation -> COAT sell -> hook -> FeeSplitter -> Booster ->
/// two-hop StockRouter -> live Rialto AAPL -> ERC-6551 claim -> transfer/reactivation.
contract ForkFullSystemTest is Test {
    IPoolManagerLaunchE2E constant PM = IPoolManagerLaunchE2E(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IPositionManagerE2E constant POSM = IPositionManagerE2E(0x58daec3116aae6D93017bAAea7749052E8a04fA7);
    IAllowanceTransferE2E constant PERMIT2 =
        IAllowanceTransferE2E(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IStateView constant STATE = IStateView(0xF3334192D15450CdD385c8B70e03f9A6bD9E673b);
    IERC6551Registry constant REGISTRY = IERC6551Registry(0x000000006551c19487814612e58FE06813775758);

    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant MID_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant AAPL_POOL = 0x957BB4b86CCC706D44983fb889ED63c6F9Bdc662;
    address constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;

    uint24 constant FEE = 10_000;
    int24 constant TICK_SPACING = 200;
    int24 constant TICK_LOWER = 138_000;
    int24 constant TICK_UPPER = 184_200;
    uint160 constant SQRT_PRICE_X96 = 799603176048022585010545010154905;
    uint256 constant LIQUIDITY = 111110341605252461876272;
    uint128 constant AMOUNT1_MAX = 1_000_000_000 ether;
    uint8 constant MINT_POSITION = 0x02;
    uint8 constant SETTLE_PAIR = 0x0d;

    COAT coat;
    StrategyRegistry strategy;
    CoattailBroker broker;
    StockRouter stockRouter;
    Booster booster;
    FeeSplitter splitter;
    CoatFeeHook hook;
    CoatRouter coatRouter;
    address treasury;
    address buyback;
    address alice;
    address bob;

    function test_fullProductionPathOnMainnetFork() public {
        if (block.chainid != 4663) {
            require(!vm.envOr("REQUIRE_MAINNET_FORK", false), "required RH mainnet fork missing");
            return;
        }
        emit log_named_uint("full-system fork L2 block", block.number);

        treasury = makeAddr("e2eTreasury");
        buyback = makeAddr("e2eBuyback");
        alice = makeAddr("e2eAlice");
        bob = makeAddr("e2eBob");

        coat = new COAT(address(this), address(PM));
        strategy = new StrategyRegistry(address(this), address(this));
        strategy.createStrategy("The Politician");
        broker = new CoattailBroker(address(this), treasury, REGISTRY, address(new BrokerAccount()), "");
        stockRouter = new StockRouter(WETH, address(this));
        booster =
            new Booster(broker, strategy, IStockRouter(address(stockRouter)), IWETH(WETH), 0, address(this));
        splitter =
            new FeeSplitter(address(this), payable(address(booster)), payable(treasury), payable(buyback));

        broker.setBooster(IBoosterHook(address(booster)));
        broker.setCoat(ICoatBurnable(address(coat)));
        broker.setMintOpen(true);
        stockRouter.setRoute(AAPL, MID_POOL, USDG, AAPL_POOL, StockRouter.PoolKind.Rialto);
        _setAaplStrategy(strategy);
        booster.setEthUsdManual(1_880e8);
        booster.setStockFeed(AAPL, IAggregatorV3(AAPL_FEED));
        booster.setPokeThreshold(1);

        hook = _mineAndDeployHook(coat, splitter);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(coat)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: address(hook)
        });
        _initializeAndSeed(coat, key);
        uint256 roundingRemainder = coat.balanceOf(address(this));
        if (roundingRemainder != 0) coat.burn(roundingRemainder);
        coat.enableTrading();
        vm.roll(coat.restrictionsEndBlock() + 1);

        coatRouter = new CoatRouter(IPoolManagerFull(address(PM)), STATE, address(coat), address(hook));
        vm.deal(alice, 0.1 ether);
        vm.prank(alice);
        uint256 coatBought = coatRouter.buy{value: 0.01 ether}(1, alice);
        assertGt(coatBought, 300_000 ether, "activation inventory not bought from live v4 pool");

        uint256 mintPrice = broker.MINT_PRICE();
        vm.prank(alice);
        broker.mint{value: 2 * mintPrice}(2);
        uint256[] memory ids = _ownedIds(alice, 2);
        uint256 firstId = ids[0];
        uint256 secondId = ids[1];
        vm.startPrank(alice);
        coat.approve(address(broker), type(uint256).max);
        broker.activate(firstId);
        broker.activate(secondId);
        coat.approve(address(coatRouter), type(uint256).max);
        uint256 ethBeforeSell = alice.balance;
        coatRouter.sell(200_000 ether, 1, alice);
        vm.stopPrank();
        assertGt(alice.balance, ethBeforeSell, "COAT sell produced no ETH");

        uint256 hookEth = address(hook).balance;
        uint256 hookCoat = coat.balanceOf(address(hook));
        uint256 supplyBeforeFlush = coat.totalSupply();
        assertGt(hookEth, 0, "sell produced no hook ETH fee");
        assertGt(hookCoat, 0, "buy produced no hook COAT fee");
        hook.flush();
        assertEq(coat.totalSupply(), supplyBeforeFlush - hookCoat, "buy fee was not truly burned");
        assertEq(address(splitter).balance, hookEth, "hook did not fund FeeSplitter");

        splitter.flush();
        uint256 boosterEth = address(booster).balance;
        assertEq(boosterEth, hookEth * 8_000 / 10_000, "80% Booster split mismatch");
        assertEq(treasury.balance, 2 * mintPrice + hookEth * 1_000 / 10_000);
        assertEq(buyback.balance, hookEth - boosterEth - hookEth * 1_000 / 10_000);

        // Foundry uses the L2 fork height for BLOCKNUMBER. Rialto Fermi uses Arbitrum's L1
        // block.number for freshness, so restore the live pricing contract's recorded L1 height.
        address fermi = IRialtoPoolE2E(AAPL_POOL).fermi();
        vm.roll(IFermiE2E(fermi).lastUpdateBlock());
        booster.poke();
        uint256 boughtAapl = booster.totalBought(AAPL);
        assertGt(boughtAapl, 0, "Booster bought no real AAPL");

        address account1 = broker.accountOf(firstId);
        vm.prank(alice);
        booster.claim(firstId);
        uint256 claimedAapl = IERC20(AAPL).balanceOf(account1);
        assertGt(claimedAapl, 0, "real AAPL did not reach ERC-6551 account");
        assertEq(booster.totalClaimed(AAPL), claimedAapl);
        assertEq(IERC20(AAPL).balanceOf(address(booster)), boughtAapl - claimedAapl);

        uint256 activationBurn = broker.ACTIVATION_BURN();
        vm.prank(alice);
        coat.transfer(bob, activationBurn);
        vm.prank(alice);
        broker.transferFrom(alice, bob, firstId);
        assertFalse(broker.activated(firstId));
        assertEq(booster.activeShares(), 1);
        vm.startPrank(bob);
        coat.approve(address(broker), type(uint256).max);
        broker.activate(firstId);
        vm.stopPrank();
        assertTrue(broker.activated(firstId));
        assertEq(booster.activeShares(), 2);

        emit log_named_uint("hook ETH fee", hookEth);
        emit log_named_uint("Booster ETH spent", boosterEth);
        emit log_named_uint("real AAPL bought", boughtAapl);
        emit log_named_uint("AAPL claimed to TBA", claimedAapl);
        emit log_named_uint("COAT total supply after real burns", coat.totalSupply());
    }

    function _setAaplStrategy(StrategyRegistry strategy_) internal {
        address[] memory tokens = new address[](1);
        uint16[] memory weights = new uint16[](1);
        tokens[0] = AAPL;
        weights[0] = 10_000;
        strategy_.setStrategy(0, tokens, weights);
    }

    function _mineAndDeployHook(COAT coat_, FeeSplitter splitter_)
        internal
        returns (CoatFeeHook deployedHook)
    {
        bytes memory args = abi.encode(
            address(this),
            IPoolManagerMinimal(address(PM)),
            IStateViewHook(address(STATE)),
            address(coat_),
            payable(address(splitter_)),
            address(this)
        );
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(CoatFeeHook).creationCode, args));
        uint160 target = HookFlags.BEFORE_INITIALIZE_FLAG | HookFlags.AFTER_SWAP_FLAG
            | HookFlags.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes32 salt;
        address predicted;
        for (uint256 i; i < 300_000; ++i) {
            address candidate = vm.computeCreate2Address(bytes32(i), initCodeHash, address(this));
            if (uint160(candidate) & HookFlags.ALL_FLAGS_MASK == target) {
                salt = bytes32(i);
                predicted = candidate;
                break;
            }
        }
        require(predicted != address(0), "hook salt not found");
        deployedHook = new CoatFeeHook{salt: salt}(
            address(this),
            IPoolManagerMinimal(address(PM)),
            IStateViewHook(address(STATE)),
            address(coat_),
            payable(address(splitter_)),
            address(this)
        );
        assertEq(address(deployedHook), predicted);
    }

    function _initializeAndSeed(COAT coat_, PoolKey memory key) internal {
        coat_.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(coat_), address(POSM), AMOUNT1_MAX, uint48(block.timestamp + 1 hours));
        PM.initialize(key, SQRT_PRICE_X96);
        bytes memory actions = abi.encodePacked(MINT_POSITION, SETTLE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, TICK_LOWER, TICK_UPPER, LIQUIDITY, uint128(0), AMOUNT1_MAX, address(0xBEEF), bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        POSM.modifyLiquidities(abi.encode(actions, params), block.timestamp + 1 hours);
    }

    function _ownedIds(address expectedOwner, uint256 expected) internal view returns (uint256[] memory ids) {
        ids = new uint256[](expected);
        uint256 found;
        for (uint256 id = 1; id <= broker.MAX_SUPPLY() && found < expected; ++id) {
            try broker.ownerOf(id) returns (address actualOwner) {
                if (actualOwner == expectedOwner) ids[found++] = id;
            } catch {}
        }
        assertEq(found, expected);
    }
}

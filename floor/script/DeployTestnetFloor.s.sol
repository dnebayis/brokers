// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BasketRouter, IWETHFloor, IStrategyRegistryFloor, IBoosterFeedFloor} from "../src/BasketRouter.sol";
import {FloorTestnetPool} from "../src/testnet/FloorTestnetPool.sol";

interface IWETHDeposit {
    function deposit() external payable;
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IMidPoolOneWay {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256, int256);
    function token0() external view returns (address);
}

/// @notice Tiny helper: an EOA cannot answer v3 callbacks, so this contract holds the WETH
///         and performs the one venue midPool swap needed to acquire tUSDG inventory.
contract FloorFunder {
    address private _pool;
    address private _payToken;

    function swapMid(address pool, address payToken, uint256 amountIn, address recipient) external {
        _pool = pool;
        _payToken = payToken;
        IMidPoolOneWay(pool).swap(recipient, true, int256(amountIn), 0, "");
        _pool = address(0);
        _payToken = address(0);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == _pool, "cb");
        int256 positive = amount0Delta > 0 ? amount0Delta : amount1Delta;
        IERC20(_payToken).transfer(msg.sender, uint256(positive));
    }
}

/// @notice Chain-46630 full pass for the Exchange Floor: deploys two-way test pools, funds
///         them permissionlessly (WETH -> tUSDG through the existing venue midPool, tAAPL
///         through the public StockRouter), deploys BasketRouter against the REAL testnet
///         core (StrategyRegistry basket + Booster feeds), then exercises the whole flow:
///         buyStockEth, buyBasketEth(live), sellStock->USDG, sellStock->ETH, flushFees ->
///         native ETH into the real testnet Booster.
contract DeployTestnetFloor is Script {
    // testnet core (ADDRESSES.md staging table)
    address constant REGISTRY = 0xd859B6Ea10dd61604b55e8E86Dc4A12C1e1f7Ab3;
    address constant BOOSTER = 0x39e4B20401dc4cA45c0b14800c86Fc3Df953A245;
    address constant STOCK_ROUTER = 0xCF6EDA70fa9C1293c7C844c3f26AF307703c6d67;
    address constant WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    address constant TUSDG = 0xca71484e6FA828dc261C7b4e902d3DF47542aDa4;
    address constant MID_POOL = 0x7eAC64125eB7836b1B4F86480d33145083aaaA33; // WETH->tUSDG @2000, one-way
    address constant TAAPL = 0x44B8DA4948e3Eacb0f2E20a42c694Af49942e5C9; // 100% of testnet basket
    address constant TCOAT = 0xD3f44c7DD32D12C7a6776C23c839DEcA8196cf07;
    address constant COAT_ROUTER = 0x5fBCa6b6Dd403659B273Ea7d6d13e6a2e2462123;

    function run() external {
        require(block.chainid == 46630, "testnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);

        // 1) inventory, all acquired permissionlessly
        IWETHDeposit(WETH).deposit{value: 0.06 ether}();
        // WETH -> tUSDG through the venue midPool (one-way v3; callbacks need a contract)
        FloorFunder funder = new FloorFunder();
        IWETHDeposit(WETH).transfer(address(funder), 0.1 ether);
        funder.swapMid(MID_POOL, WETH, 0.1 ether, me); // -> ~200 tUSDG
        // tAAPL via the public StockRouter (ETH -> ... -> tAAPL)
        (bool ok,) = STOCK_ROUTER.call{value: 0.015 ether}(
            abi.encodeWithSignature(
                "swapExactETHForStock(address,uint256,address,uint256)", TAAPL, 0, me, block.timestamp + 600
            )
        );
        require(ok, "tAAPL buy");
        console2.log("inventory tUSDG", IERC20(TUSDG).balanceOf(me));
        console2.log("inventory tAAPL", IERC20(TAAPL).balanceOf(me));

        // 2) two-way pools (tUSDG has 18 decimals on testnet; tAAPL $200 -> 1/200)
        FloorTestnetPool aaplPool = new FloorTestnetPool(TUSDG, TAAPL, 1, 200);
        FloorTestnetPool ethPool = new FloorTestnetPool(WETH, TUSDG, 2000, 1);
        IERC20(TUSDG).transfer(address(aaplPool), 40 ether);
        IERC20(TAAPL).transfer(address(aaplPool), IERC20(TAAPL).balanceOf(me));
        IWETHDeposit(WETH).transfer(address(ethPool), 0.012 ether);
        IERC20(TUSDG).transfer(address(ethPool), 35 ether);

        // 3) the Floor itself, wired to the REAL testnet core
        BasketRouter router = new BasketRouter(
            IERC20(TUSDG),
            IWETHFloor(WETH),
            IStrategyRegistryFloor(REGISTRY),
            IBoosterFeedFloor(BOOSTER),
            0,
            BOOSTER, // fee ETH really lands in the testnet Booster's receive()
            me,
            me
        );
        router.setPool(TAAPL, address(aaplPool));
        router.setEthPool(address(ethPool));
        // testnet feeds were set weeks ago; widen the staleness window for the pass
        router.setFeedStaleAfter(365 days);
        router.setCoatRoute(TCOAT, COAT_ROUTER);
        console2.log("BasketRouter", address(router));

        // 4) FULL PASS
        uint256 boosterBefore = BOOSTER.balance;
        uint256 out1 = router.buyStockEth{value: 0.001 ether}(TAAPL, 0, me, block.timestamp + 600);
        console2.log("buyStockEth out", out1);

        router.buyBasketEth{value: 0.0015 ether}(0, me, block.timestamp + 600); // live basket = tAAPL 100%
        console2.log("basket tAAPL bal", IERC20(TAAPL).balanceOf(me));

        IERC20(TAAPL).approve(address(router), type(uint256).max);
        uint256 usdgOut =
            router.sellStock(TAAPL, out1 / 2, BasketRouter.OutCurrency.USDG, 0, me, block.timestamp + 600);
        console2.log("sell->USDG out", usdgOut);
        uint256 ethOut =
            router.sellStock(TAAPL, out1 / 4, BasketRouter.OutCurrency.ETH, 0, me, block.timestamp + 600);
        console2.log("sell->ETH out", ethOut);

        _coatPass(router, me);

        uint256 fees = router.feesAccrued();
        console2.log("feesAccrued", fees);
        router.flushFees(0);
        console2.log("booster ETH delta", BOOSTER.balance - boosterBefore);
        require(BOOSTER.balance > boosterBefore, "booster must receive fee ETH");
        require(router.feesAccrued() == 0, "fees flushed");

        vm.stopBroadcast();
    }

    function _coatPass(BasketRouter router, address me) internal {
        // COAT entry: buy COAT from the hooked pool, then buy the basket WITH it, one tx
        (bool okC,) =
            COAT_ROUTER.call{value: 0.004 ether}(abi.encodeWithSignature("buy(uint256,address)", 0, me));
        require(okC, "coat buy");
        uint256 coatBal = IERC20(TCOAT).balanceOf(me);
        IERC20(TCOAT).approve(address(router), coatBal);
        uint256 aaplBefore = IERC20(TAAPL).balanceOf(me);
        router.buyBasketCoat(0, coatBal, 0, me, block.timestamp + 600);
        console2.log("buyBasketCoat coatIn", coatBal);
        console2.log("buyBasketCoat tAAPL delta", IERC20(TAAPL).balanceOf(me) - aaplBefore);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeskNFT} from "../src/DeskNFT.sol";
import {DeskAccount} from "../src/DeskAccount.sol";
import {IDeskNFTView, IAggregatorV3Desk} from "../src/DeskEngine.sol";
import {DeskDepositRouter, ICoatRouterSell, IDeskDepositBook} from "../src/DeskDepositRouter.sol";
import {TestERC6551Registry} from "./Helpers6551.sol";
import {Token, MockWETH, MockV3Pool, MockFeed} from "./DeskEngine.t.sol";

/// WETH9-shaped: the router wraps native ETH with deposit().
contract MockWETH9 is MockWETH {
    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// COAT -> ETH at a fixed rate, like the live router's `sell` (pulls COAT, pays ETH to `to`).
contract MockCoatRouter {
    IERC20 public immutable coat;
    uint256 public weiPerCoat;

    constructor(IERC20 coat_, uint256 weiPerCoat_) {
        coat = coat_;
        weiPerCoat = weiPerCoat_;
    }

    function sell(uint256 coatIn, uint256 minEthOut, address to) external returns (uint256 out) {
        coat.transferFrom(msg.sender, address(this), coatIn);
        out = (coatIn * weiPerCoat) / 1e18;
        require(out >= minEthOut, "slippage");
        (bool ok,) = to.call{value: out}("");
        require(ok, "eth");
    }

    receive() external payable {}
}

/// Stands in for the engine's deposit book: records what the router books, refuses over a cap.
contract MockBook is IDeskDepositBook {
    mapping(uint256 => uint256) public booked;
    uint256 public cap = type(uint256).max;

    function setCap(uint256 c) external {
        cap = c;
    }

    function recordDeposit(uint256 deskId, uint256 amount) external {
        require(booked[deskId] + amount <= cap, "over cap");
        booked[deskId] += amount;
    }
}

contract DeskDepositRouterTest is Test {
    Token coat;
    Token usdg;
    MockWETH9 weth;
    MockV3Pool ethPool;
    MockFeed ethFeed;
    MockCoatRouter coatRouter;
    DeskNFT desks;
    DeskDepositRouter router;
    MockBook book;

    address ownerA = address(0xA11CE);
    address alice = address(0xAA);
    uint256 constant U = 1e6;

    function setUp() public {
        coat = new Token("COAT", 18);
        usdg = new Token("USDG", 6);
        weth = new MockWETH9();
        TestERC6551Registry reg = new TestERC6551Registry();
        DeskAccount impl = new DeskAccount(address(0xE9));
        desks = new DeskNFT(IERC20(address(coat)), address(0xB0), reg, address(impl), ownerA);
        vm.startPrank(ownerA);
        desks.setMintOpen(true);
        desks.setMintPrice(0);
        vm.stopPrank();

        // $2,500 ETH: 1 USDG (1e6) -> 4e14 wei, so 1 ETH -> 2,500 USDG the other way
        ethPool = new MockV3Pool(address(usdg), address(weth), 4e8, 1);
        usdg.transfer(address(ethPool), 1e8 * U);
        ethFeed = new MockFeed(2500e8);
        coatRouter = new MockCoatRouter(IERC20(address(coat)), 1e12); // 1 COAT = 1e-6 ETH
        vm.deal(address(coatRouter), 100 ether);
        vm.deal(address(weth), 0); // deposits mint WETH against real ETH

        book = new MockBook();
        router = new DeskDepositRouter(
            IERC20(address(usdg)),
            address(weth),
            IERC20(address(coat)),
            IDeskNFTView(address(desks)),
            IDeskDepositBook(address(book)),
            ICoatRouterSell(address(coatRouter)),
            address(ethPool),
            IAggregatorV3Desk(address(ethFeed)),
            ownerA
        );

        coat.transfer(alice, 10_000_000 ether);
        usdg.transfer(alice, 10_000 * U);
        vm.deal(alice, 10 ether);
    }

    function _desk() internal returns (uint256 id, address acct) {
        vm.prank(alice);
        (id, acct) = desks.mint();
    }

    function test_depositEth_landsUsdgInTheDesk() public {
        (uint256 id, address acct) = _desk();
        vm.prank(alice);
        uint256 out = router.depositEth{value: 0.4 ether}(id, 0);
        assertEq(out, 1_000 * U);
        assertEq(usdg.balanceOf(acct), 1_000 * U);
        assertEq(book.booked(id), 1_000 * U); // booked with the engine in the same tx
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(weth.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    function test_depositEth_chainlinkFloorBlocksABadPool() public {
        (uint256 id,) = _desk();
        ethPool.setPrice(8e8, 1); // pool now pays half the USDG per ETH
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeskDepositRouter.BelowFloor.selector, 500 * U, 970 * U));
        router.depositEth{value: 0.4 ether}(id, 0);
    }

    function test_depositEth_callerFloorApplies() public {
        (uint256 id,) = _desk();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeskDepositRouter.BelowFloor.selector, 1_000 * U, 1_001 * U));
        router.depositEth{value: 0.4 ether}(id, 1_001 * U);
    }

    function test_depositEth_staleFeedReverts() public {
        (uint256 id,) = _desk();
        vm.warp(block.timestamp + 10 days);
        MockFeedStale stale = new MockFeedStale(2500e8, block.timestamp - 2 days);
        vm.prank(ownerA);
        router.setEthUsdFeed(IAggregatorV3Desk(address(stale)));
        vm.prank(alice);
        vm.expectRevert(DeskDepositRouter.BadFeed.selector);
        router.depositEth{value: 0.4 ether}(id, 0);
    }

    function test_depositCoat_sellsThroughTheCoatRouterThenEth() public {
        (uint256 id, address acct) = _desk();
        vm.startPrank(alice);
        coat.approve(address(router), 400_000 ether); // 400k COAT = 0.4 ETH = $1,000
        uint256 out = router.depositCoat(id, 400_000 ether, 0.39 ether, 0);
        vm.stopPrank();
        assertEq(out, 1_000 * U);
        assertEq(usdg.balanceOf(acct), 1_000 * U);
        assertEq(coat.balanceOf(address(coatRouter)), 400_000 ether);
        assertEq(coat.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    function test_depositUsdg_isAPlainTransferToTheDesk() public {
        (uint256 id, address acct) = _desk();
        vm.startPrank(alice);
        usdg.approve(address(router), 250 * U);
        router.depositUsdg(id, 250 * U);
        vm.stopPrank();
        assertEq(usdg.balanceOf(acct), 250 * U);
        assertEq(book.booked(id), 250 * U);
    }

    /// When the engine refuses a deposit (pilot cap), nothing moves: the whole tx reverts.
    function test_depositOverTheCapRevertsWhole() public {
        (uint256 id, address acct) = _desk();
        book.setCap(100 * U);
        vm.startPrank(alice);
        usdg.approve(address(router), 250 * U);
        vm.expectRevert(bytes("over cap"));
        router.depositUsdg(id, 250 * U);
        vm.expectRevert(bytes("over cap"));
        router.depositEth{value: 0.4 ether}(id, 0);
        vm.stopPrank();
        assertEq(usdg.balanceOf(acct), 0);
        assertEq(alice.balance, 10 ether);
    }

    function test_strayEthIsRefused() public {
        vm.prank(alice);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_onlyOwnerSetsLevers_andSlippageIsBounded() public {
        vm.prank(alice);
        vm.expectRevert();
        router.setGuards(100, 1 days);
        vm.prank(ownerA);
        vm.expectRevert(DeskDepositRouter.SlippageTooHigh.selector);
        router.setGuards(1_001, 1 days);
    }

    // --- audit: the ETH leg against hostile pools ---

    function _useEthPool(address pool) internal {
        usdg.transfer(pool, 1e6 * U);
        vm.prank(ownerA);
        router.setEthPool(pool);
    }

    function test_audit_partialFillReverts_noWethLeftBehind() public {
        (uint256 id, address acct) = _desk();
        _useEthPool(address(new HalfEthPool(address(usdg), address(weth))));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeskDepositRouter.PartialFill.selector, 0.2 ether, 0.4 ether));
        router.depositEth{value: 0.4 ether}(id, 0);
        assertEq(usdg.balanceOf(acct), 0);
        assertEq(weth.balanceOf(address(router)), 0);
        assertEq(alice.balance, 10 ether);
    }

    function test_audit_poolThatLiesAboutTheFill_reverts() public {
        (uint256 id,) = _desk();
        _useEthPool(address(new LyingEthPool(address(usdg), address(weth))));
        vm.prank(alice);
        vm.expectRevert(DeskDepositRouter.InvalidPool.selector);
        router.depositEth{value: 0.4 ether}(id, 0);
        assertEq(book.booked(id), 0); // nothing booked for USDG that never arrived
    }

    function test_audit_strangerCannotCallTheSwapCallback() public {
        vm.prank(address(ethPool));
        vm.expectRevert(DeskDepositRouter.BadCallback.selector);
        router.uniswapV3SwapCallback(0, 1, "");
    }

    /// The router books exactly the USDG that reached the Desk, for the Desk it reached.
    function testFuzz_audit_bookedEqualsDelivered(uint256 wei_) public {
        wei_ = bound(wei_, 1e12, 3 ether);
        (uint256 id, address acct) = _desk();
        vm.prank(alice);
        uint256 out = router.depositEth{value: wei_}(id, 0);
        assertEq(usdg.balanceOf(acct), out);
        assertEq(book.booked(id), out);
        assertEq(
            weth.balanceOf(address(router)) + usdg.balanceOf(address(router)) + address(router).balance, 0
        );
    }
}

/// Takes only half of the WETH it is given, at the fair $2,500.
contract HalfEthPool {
    address public token0;
    address public token1;

    constructor(address usdg_, address weth_) {
        (token0, token1) = (usdg_, weth_);
    }

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 half = uint256(amountSpecified) / 2;
        uint256 out = half / 4e8;
        IERC20(token0).transfer(recipient, out);
        (amount0, amount1) = (-int256(out), int256(half));
        ICallbackRouter(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

/// Reports a fill, delivers nothing.
contract LyingEthPool {
    address public token0;
    address public token1;

    constructor(address usdg_, address weth_) {
        (token0, token1) = (usdg_, weth_);
    }

    function swap(address, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        (amount0, amount1) = (int256(-1e12), amountSpecified);
        ICallbackRouter(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

interface ICallbackRouter {
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external;
}

contract MockFeedStale {
    int256 public answer;
    uint256 public at;

    constructor(int256 a, uint256 at_) {
        answer = a;
        at = at_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, at, at, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

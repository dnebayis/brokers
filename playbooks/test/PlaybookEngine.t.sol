// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PlaybookEngine, IBrokersPB, IBoosterPB, IFloorPB} from "../src/PlaybookEngine.sol";

contract MockStock is ERC20 {
    constructor() ERC20("Stock", "STK") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract MockBrokers is IBrokersPB {
    mapping(uint256 => address) public owners;
    mapping(uint256 => address) public tbas;

    function set(uint256 id, address owner_, address tba) external {
        owners[id] = owner_;
        tbas[id] = tba;
    }

    function ownerOf(uint256 id) external view returns (address) {
        require(owners[id] != address(0), "no token");
        return owners[id];
    }

    function accountOf(uint256 id) external view returns (address) {
        return tbas[id];
    }
}

contract MockBooster is IBoosterPB {
    address[] public toks;
    mapping(uint256 => bool) public active;
    mapping(uint256 => uint256) public claims;
    MockStock public payoutToken;
    mapping(uint256 => address) public tbaOf;
    uint256 public payoutAmount = 1e18;

    function addToken(address t) external {
        toks.push(t);
    }

    function setActive(uint256 id, bool a, address tba) external {
        active[id] = a;
        tbaOf[id] = tba;
    }

    function setPayout(MockStock t) external {
        payoutToken = t;
    }

    function claimFor(uint256 id) external {
        claims[id]++;
        if (address(payoutToken) != address(0)) payoutToken.mint(tbaOf[id], payoutAmount);
    }

    function knownTokenCount() external view returns (uint256) {
        return toks.length;
    }

    function knownTokens(uint256 i) external view returns (address) {
        return toks[i];
    }

    function isActive(uint256 id) external view returns (bool) {
        return active[id];
    }
}

contract MockFloor is IFloorPB {
    MockStock public usdg;
    uint256 public rate = 2; // out = amountIn * rate
    uint256 public lastMinOut;

    constructor(MockStock usdg_) {
        usdg = usdg_;
    }

    function sellBasket(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint8,
        uint256 minOut,
        address recipient,
        uint256
    ) external returns (uint256 out) {
        lastMinOut = minOut;
        for (uint256 i; i < tokens.length; ++i) {
            IERC20(tokens[i]).transferFrom(msg.sender, address(this), amounts[i]);
            out += amounts[i] * rate;
        }
        require(out >= minOut, "slippage");
        usdg.mint(recipient, out);
    }
}

// minimal TBA stand-in: a wallet that can hand out approvals like execute(approve) would
contract MockTBA {
    function approveToken(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }
}

contract PlaybookEngineTest is Test {
    MockBrokers brokers;
    MockBooster booster;
    MockFloor floor;
    MockStock stock;
    MockStock usdg;
    PlaybookEngine engine;
    MockTBA tba;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address keeper = address(0xCAFE);

    function setUp() public {
        brokers = new MockBrokers();
        booster = new MockBooster();
        stock = new MockStock();
        usdg = new MockStock();
        floor = new MockFloor(usdg);
        booster.addToken(address(stock));
        booster.setPayout(stock);
        engine = new PlaybookEngine(
            IBrokersPB(address(brokers)), IBoosterPB(address(booster)), IFloorPB(address(floor)), keeper, address(this)
        );
        tba = new MockTBA();
        brokers.set(1, alice, address(tba));
        booster.setActive(1, true, address(tba));
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    function _mins(uint256 m) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = m;
    }

    function test_onlyOwnerEnrolls() public {
        vm.prank(bob);
        vm.expectRevert(PlaybookEngine.NotBrokerOwner.selector);
        engine.setPlaybook(1, true, PlaybookEngine.Mode.NONE, address(0));
    }

    function test_autoClaimOnly_zeroApprovals() public {
        vm.prank(alice);
        engine.setPlaybook(1, true, PlaybookEngine.Mode.NONE, address(0));
        vm.prank(keeper);
        engine.run(_ids(1), _mins(0));
        assertEq(booster.claims(1), 1, "claimFor fired");
        assertEq(stock.balanceOf(address(tba)), 1e18, "salary landed in the TBA");
    }

    function test_sweep_movesStocksToDest() public {
        vm.prank(alice);
        engine.setPlaybook(1, true, PlaybookEngine.Mode.SWEEP, bob);
        tba.approveToken(address(stock), address(engine)); // the one-time TBA approval
        vm.prank(keeper);
        engine.run(_ids(1), _mins(0));
        assertEq(stock.balanceOf(bob), 1e18, "claimed then swept to dest");
        assertEq(stock.balanceOf(address(tba)), 0);
    }

    function test_convert_sellsThroughFloor() public {
        vm.prank(alice);
        engine.setPlaybook(1, true, PlaybookEngine.Mode.TO_USDG, bob);
        tba.approveToken(address(stock), address(engine));
        vm.prank(keeper);
        engine.run(_ids(1), _mins(0));
        assertEq(usdg.balanceOf(bob), 2e18, "proceeds delivered to dest");
        assertEq(stock.balanceOf(address(engine)), 0, "no custody left behind");
    }

    function test_minOut_isForwardedAndBinds() public {
        vm.prank(alice);
        engine.setPlaybook(1, false, PlaybookEngine.Mode.TO_USDG, bob);
        stock.mint(address(tba), 1e18);
        tba.approveToken(address(stock), address(engine));
        vm.prank(keeper);
        vm.expectRevert("slippage");
        engine.run(_ids(1), _mins(3e18)); // demands more than the mock pays
    }

    function test_missingApproval_skipsInsteadOfReverting() public {
        vm.prank(alice);
        engine.setPlaybook(1, true, PlaybookEngine.Mode.TO_USDG, bob);
        vm.prank(keeper);
        engine.run(_ids(1), _mins(0)); // no TBA approval yet
        assertEq(usdg.balanceOf(bob), 0);
        assertEq(stock.balanceOf(address(tba)), 1e18, "claimed but untouched");
    }

    function test_transferInvalidatesPlaybook() public {
        vm.prank(alice);
        engine.setPlaybook(1, true, PlaybookEngine.Mode.SWEEP, alice);
        tba.approveToken(address(stock), address(engine));
        brokers.set(1, bob, address(tba)); // the NFT changes hands
        vm.prank(keeper);
        engine.run(_ids(1), _mins(0));
        assertEq(booster.claims(1), 0, "nothing runs for the new owner");
        // the new owner opts in explicitly and it works again
        vm.prank(bob);
        engine.setPlaybook(1, true, PlaybookEngine.Mode.SWEEP, bob);
        vm.prank(keeper);
        engine.run(_ids(1), _mins(0));
        assertEq(stock.balanceOf(bob), 1e18);
    }

    function test_pause_clear_and_keeperGate() public {
        vm.prank(alice);
        engine.setPlaybook(1, true, PlaybookEngine.Mode.NONE, address(0));
        vm.prank(alice);
        engine.setPaused(1, true);
        vm.prank(keeper);
        engine.run(_ids(1), _mins(0));
        assertEq(booster.claims(1), 0, "paused runs nothing");
        vm.prank(alice);
        engine.clearPlaybook(1);
        assertEq(engine.enrolledCount(), 0);
        vm.prank(bob);
        vm.expectRevert(PlaybookEngine.NotKeeper.selector);
        engine.run(_ids(1), _mins(0));
    }
}

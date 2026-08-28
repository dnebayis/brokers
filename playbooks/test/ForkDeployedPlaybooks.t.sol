// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PlaybookEngine} from "../src/PlaybookEngine.sol";

interface IBrokersFork {
    function ownerOf(uint256) external view returns (address);
    function accountOf(uint256) external view returns (address);
}

interface ITBAFork {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory);
}

interface IFloorQuote {
    function minUsdgOut(address stock, uint256 amount) external view returns (uint256);
    function feeBps() external view returns (uint256);
}

/// Production dress rehearsal: the DEPLOYED mainnet engine, driving a REAL active Broker
/// owned by a real wallet, against real pools and real Chainlink feeds — on a fork of the
/// current chain state, so nothing is broadcast. This is the proof that the next hourly
/// keeper run will do what the UI promises.
///   forge test --match-path test/ForkDeployedPlaybooks.t.sol --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract ForkDeployedPlaybooksTest is Test {
    PlaybookEngine constant ENGINE = PlaybookEngine(0x3b39C832a906E7fE5292F6872c3D3f9eE8340438);
    address constant BROKERS = 0x1122dB21998707F8c2eD8182734356C947fA5e98;
    address constant FLOOR = 0x478F22A32663cF37702d65352A7579A73e61FDc7;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant COAT = 0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833;
    address constant KEEPER = 0xa492c8fFa033016144B169501D2e428BeDD518CA;
    address constant INTC = 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681;
    address constant SPCX = 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa;
    address constant MU = 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD;

    uint256 constant TOKEN_ID = 527; // a real, currently active Broker
    address owner;
    address tba;

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        owner = IBrokersFork(BROKERS).ownerOf(TOKEN_ID);
        tba = IBrokersFork(BROKERS).accountOf(TOKEN_ID);
        assertTrue(tba != address(0), "broker must have a wallet");
    }

    function _stocks() internal pure returns (address[3] memory) {
        return [INTC, SPCX, MU];
    }

    /// The exact sequence the frontend performs, then the exact call the keeper makes.
    function test_prod_installAndRun_convertToUsdg() public {
        address[3] memory stocks = _stocks();
        uint256 held;
        for (uint256 i; i < 3; ++i) held += IERC20(stocks[i]).balanceOf(tba);
        assertGt(held, 0, "this Broker's wallet should hold stock to convert");

        // 1) the owner installs the playbook (one signature in the UI)
        vm.prank(owner);
        ENGINE.setPlaybook(TOKEN_ID, true, PlaybookEngine.Mode.TO_USDG, owner);

        // 2) the one-time per-stock approval, signed by the owner through the Broker wallet
        for (uint256 i; i < 3; ++i) {
            vm.prank(owner);
            ITBAFork(tba).execute(
                stocks[i], 0, abi.encodeCall(IERC20.approve, (address(ENGINE), type(uint256).max)), 0
            );
        }

        // 3) the keeper's minOut, computed the way the keeper computes it: Chainlink floors
        uint256 floorUsdg;
        for (uint256 i; i < 3; ++i) {
            uint256 bal = IERC20(stocks[i]).balanceOf(tba);
            if (bal > 0) floorUsdg += IFloorQuote(FLOOR).minUsdgOut(stocks[i], bal);
        }
        uint256 minOut = (floorUsdg * (10000 - IFloorQuote(FLOOR).feeBps())) / 10000;
        assertGt(minOut, 0, "guard must bind");

        // 4) the hourly keeper run, signed by the real relay wallet
        uint256 before = IERC20(USDG).balanceOf(owner);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory mins = new uint256[](1);
        ids[0] = TOKEN_ID;
        mins[0] = minOut;
        vm.prank(KEEPER);
        ENGINE.run(ids, mins);

        uint256 delivered = IERC20(USDG).balanceOf(owner) - before;
        emit log_named_uint("USDG delivered to the owner (6dp)", delivered);
        assertGe(delivered, minOut, "delivery must clear the guard");
        for (uint256 i; i < 3; ++i) {
            assertEq(IERC20(stocks[i]).balanceOf(tba), 0, "the Broker wallet is swept");
        }
        assertEq(IERC20(USDG).balanceOf(address(ENGINE)), 0, "engine keeps no custody");
    }

    /// The $COAT exit with the keeper's own computed guard. The number below is what
    /// `keeper._coat_min_out` returned for this Broker against live mainnet state; the test
    /// proves an order priced that way actually fills instead of reverting.
    function test_prod_convertToCoat_keeperGuardHolds() public {
        address[3] memory stocks = _stocks();
        vm.prank(owner);
        ENGINE.setPlaybook(TOKEN_ID, true, PlaybookEngine.Mode.TO_COAT, owner);
        for (uint256 i; i < 3; ++i) {
            vm.prank(owner);
            ITBAFork(tba).execute(
                stocks[i], 0, abi.encodeCall(IERC20.approve, (address(ENGINE), type(uint256).max)), 0
            );
        }
        uint256 keeperGuard = 5_757_220_994_798_154_517_628; // keeper._coat_min_out, live read
        uint256 before = IERC20(COAT).balanceOf(owner);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory mins = new uint256[](1);
        ids[0] = TOKEN_ID;
        mins[0] = keeperGuard;
        vm.prank(KEEPER);
        ENGINE.run(ids, mins);
        uint256 delivered = IERC20(COAT).balanceOf(owner) - before;
        emit log_named_uint("COAT delivered", delivered / 1e18);
        emit log_named_uint("keeper guard   ", keeperGuard / 1e18);
        assertGe(delivered, keeperGuard, "the keeper's guard must be fillable, not just safe");
        for (uint256 i; i < 3; ++i) {
            assertEq(IERC20(stocks[i]).balanceOf(tba), 0, "wallet swept");
        }
    }

    /// Auto-claim alone: no approvals, no conversion, nothing leaves the Broker wallet.
    function test_prod_autoClaimOnly_needsNoApprovals() public {
        vm.prank(owner);
        ENGINE.setPlaybook(TOKEN_ID, true, PlaybookEngine.Mode.NONE, address(0));
        uint256[] memory ids = new uint256[](1);
        uint256[] memory mins = new uint256[](1);
        ids[0] = TOKEN_ID;
        uint256 intcBefore = IERC20(INTC).balanceOf(tba);
        vm.prank(KEEPER);
        ENGINE.run(ids, mins);
        assertGe(IERC20(INTC).balanceOf(tba), intcBefore, "claims can only add to the wallet");
    }

    /// A stranger cannot install or run anything, and a sale voids the instruction.
    function test_prod_authority_holds() public {
        address stranger = address(0xBAD);
        vm.prank(stranger);
        vm.expectRevert(PlaybookEngine.NotBrokerOwner.selector);
        ENGINE.setPlaybook(TOKEN_ID, true, PlaybookEngine.Mode.TO_USDG, stranger);

        vm.prank(owner);
        ENGINE.setPlaybook(TOKEN_ID, true, PlaybookEngine.Mode.SWEEP, owner);

        uint256[] memory ids = new uint256[](1);
        uint256[] memory mins = new uint256[](1);
        ids[0] = TOKEN_ID;
        vm.prank(stranger);
        vm.expectRevert(PlaybookEngine.NotKeeper.selector);
        ENGINE.run(ids, mins);

        // simulate the sale: the Broker now answers to someone else
        vm.mockCall(BROKERS, abi.encodeWithSignature("ownerOf(uint256)", TOKEN_ID), abi.encode(stranger));
        uint256 intcBefore = IERC20(INTC).balanceOf(tba);
        vm.prank(KEEPER);
        ENGINE.run(ids, mins);
        assertEq(IERC20(INTC).balanceOf(tba), intcBefore, "a sold Broker's playbook must not run");
    }
}

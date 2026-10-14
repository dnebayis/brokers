// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BasketRouter} from "../src/BasketRouter.sol";

interface IPlaybooksFork {
    function setFloor(address floor_) external;
    function run(uint256[] calldata ids, uint256[] calldata minOuts) external;
    function keeper() external view returns (address);
    function owner() external view returns (address);
    function floor() external view returns (address);
    function playbookOf(uint256 id) external view returns (bool, uint8, address, bool);
}

interface IBrokersFork {
    function accountOf(uint256 id) external view returns (address);
}

/// The Floor v2 as DEPLOYED by script/DeployMainnetFloorV2.s.sol, driven on a mainnet fork:
/// config, the live Congress basket in all three currencies, a basket name without a pool
/// skipped on the buy and handed back on the sell, the Playbooks engine moved onto v2 and run
/// for a real enrolled Broker, the fee flush to the Booster. FLOOR_V2 is the router address
/// (an anvil fork the script was broadcast onto, or the real deployment); RH_RPC the fork RPC.
///   FLOOR_V2=0x... RH_RPC=http://127.0.0.1:8562 forge test --match-contract ForkFloorV2
contract ForkFloorV2Test is Test {
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant COAT = 0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833;
    address constant RELAY = 0xa492c8fFa033016144B169501D2e428BeDD518CA;
    address constant DEPLOYER = 0x9e643731dc9D8795573Aa34C410664407FfDC440;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    IPlaybooksFork constant PLAYBOOKS = IPlaybooksFork(0x3b39C832a906E7fE5292F6872c3D3f9eE8340438);
    IBrokersFork constant BROKERS = IBrokersFork(0x1122dB21998707F8c2eD8182734356C947fA5e98);
    address constant META = 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35;
    address constant INTC = 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681;
    address constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
    uint256 constant PB_BROKER = 1422; // an enrolled TO_USDG playbook, executed on chain 2026-10-04

    BasketRouter router;
    address alice = address(0xA11CE57);
    address bob = address(0xB0B57);

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        router = BasketRouter(payable(vm.envAddress("FLOOR_V2")));
        vm.deal(alice, 10 ether);
    }

    function _live() internal view returns (address[] memory t) {
        (t,,) = router.preset(0);
    }

    function _assertCustodyIsFees() internal view {
        assertEq(IERC20(USDG).balanceOf(address(router)), router.feesAccrued(), "custody = fees only");
        address[] memory t = _live();
        for (uint256 i; i < t.length; ++i) {
            assertEq(IERC20(t[i]).balanceOf(address(router)), 0, "no stock stays in the router");
        }
    }

    function test_config_asDeployed() public view {
        assertEq(router.VERSION(), "2");
        assertEq(router.owner(), DEPLOYER);
        assertEq(router.keeper(), RELAY);
        assertEq(router.feeBps(), 30);
        assertEq(router.boosterShareBps(), 10_000);
        assertEq(router.boosterSink(), BOOSTER);
        assertEq(router.maxSlippageBps(), 500);
        assertEq(router.feedStaleAfter(), 345_600);
        assertEq(address(router.ethUsdFeed()), ETH_USD);
        assertEq(router.ethFeedStaleAfter(), 108_000);
        assertEq(router.coat(), COAT);
        (,, string memory name) = router.preset(1);
        assertEq(name, "Chips");
        // every v3 name of the route manifest is routed
        string memory manifest = vm.readFile("../indexer/route-ready.mainnet.json");
        string[] memory names = vm.parseJsonKeys(manifest, ".entries");
        uint256 routed;
        for (uint256 i; i < names.length; ++i) {
            string memory base = string.concat(".entries.", names[i]);
            if (
                keccak256(bytes(vm.parseJsonString(manifest, string.concat(base, ".poolKind"))))
                    != keccak256("V3")
            ) {
                continue;
            }
            (address pool,) = router.routes(vm.parseJsonAddress(manifest, string.concat(base, ".token")));
            assertEq(pool, vm.parseJsonAddress(manifest, string.concat(base, ".stockPool")), names[i]);
            ++routed;
        }
        assertEq(routed, 26);
        (address[] memory legs,, address[] memory skipped) = router.basketLegs(0);
        assertEq(skipped.length, 0, "the live basket is fully routed");
        assertEq(legs.length, _live().length);
    }

    function test_congressLive_eth_everyNameLands() public {
        vm.prank(alice);
        router.buyBasketEth{value: 0.01 ether}(0, alice, block.timestamp + 600);
        address[] memory t = _live();
        for (uint256 i; i < t.length; ++i) {
            assertGt(IERC20(t[i]).balanceOf(alice), 0, "every basket name lands");
        }
        _assertCustodyIsFees();
    }

    function test_congressLive_usdg() public {
        deal(USDG, alice, 50e6);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(router), 50e6);
        router.buyBasket(0, 50e6, alice, block.timestamp + 600);
        vm.stopPrank();
        assertGt(IERC20(META).balanceOf(alice), 0);
        _assertCustodyIsFees();
    }

    function test_congressLive_coat() public {
        deal(COAT, alice, 200_000e18);
        vm.startPrank(alice);
        IERC20(COAT).approve(address(router), 200_000e18);
        router.buyBasketCoat(0, 200_000e18, 0, alice, block.timestamp + 600);
        vm.stopPrank();
        assertGt(IERC20(META).balanceOf(alice), 0, "a COAT-funded basket lands");
        assertEq(IERC20(COAT).balanceOf(address(router)), 0);
        _assertCustodyIsFees();
    }

    function test_nameWithoutPool_skippedOnBuy_handedBackOnSell() public {
        vm.prank(alice);
        router.buyBasketEth{value: 0.01 ether}(0, alice, block.timestamp + 600);
        uint256 metaHeld = IERC20(META).balanceOf(alice);
        assertGt(metaHeld, 0);

        vm.prank(DEPLOYER);
        router.setPool(META, address(0)); // as if META had no v3 pool (a Rialto-only name)
        (,, address[] memory skipped) = router.basketLegs(0);
        assertEq(skipped.length, 1);
        assertEq(skipped[0], META);

        vm.prank(alice);
        router.buyBasketEth{value: 0.01 ether}(0, alice, block.timestamp + 600);
        assertEq(IERC20(META).balanceOf(alice), metaHeld, "the unrouted name is skipped, not bought");

        address[] memory t = _live();
        uint256[] memory a = new uint256[](t.length);
        vm.startPrank(alice);
        for (uint256 i; i < t.length; ++i) {
            IERC20(t[i]).approve(address(router), type(uint256).max);
        }
        uint256 out = router.sellBasket(t, a, BasketRouter.OutCurrency.ETH, 0, bob, block.timestamp + 600);
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(bob.balance, out);
        assertEq(IERC20(META).balanceOf(bob), metaHeld, "the unrouted leg is handed back raw");
        for (uint256 i; i < t.length; ++i) {
            assertEq(IERC20(t[i]).balanceOf(alice), 0, "a full exit empties the wallet");
        }
        _assertCustodyIsFees();
    }

    function test_sellBasket_toUsdgAndCoat() public {
        vm.prank(alice);
        router.buyBasketEth{value: 0.02 ether}(0, alice, block.timestamp + 600);
        address[] memory t = _live();
        uint256[] memory half = new uint256[](t.length);
        vm.startPrank(alice);
        for (uint256 i; i < t.length; ++i) {
            IERC20(t[i]).approve(address(router), type(uint256).max);
            half[i] = IERC20(t[i]).balanceOf(alice) / 2;
        }
        uint256 usdgOut =
            router.sellBasket(t, half, BasketRouter.OutCurrency.USDG, 1, alice, block.timestamp + 600);
        uint256[] memory rest = new uint256[](t.length);
        uint256 coatOut =
            router.sellBasket(t, rest, BasketRouter.OutCurrency.COAT, 1, alice, block.timestamp + 600);
        vm.stopPrank();
        assertGt(usdgOut, 0);
        assertGt(coatOut, 0);
        _assertCustodyIsFees();
    }

    function test_playbooks_runOnV2_forARealBroker() public {
        address tba = BROKERS.accountOf(PB_BROKER);
        (, uint8 mode, address dest,) = PLAYBOOKS.playbookOf(PB_BROKER);
        assertEq(mode, 2, "TO_USDG");
        address to = dest == address(0) ? tba : dest;

        vm.prank(PLAYBOOKS.owner());
        PLAYBOOKS.setFloor(address(router));
        assertEq(PLAYBOOKS.floor(), address(router));

        // give the Broker wallet stock it has approved the engine for (INTC, MSFT), bought on v2
        deal(USDG, alice, 40e6);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(router), 40e6);
        router.buyStock(INTC, 20e6, 0, tba, block.timestamp + 600);
        router.buyStock(MSFT, 20e6, 0, tba, block.timestamp + 600);
        vm.stopPrank();
        // and take MSFT's pool away: the engine pulls it anyway, v2 must hand it to dest
        vm.prank(DEPLOYER);
        router.setPool(MSFT, address(0));
        uint256 msftInTba = IERC20(MSFT).balanceOf(tba);

        uint256 usdgBefore = IERC20(USDG).balanceOf(to);
        uint256 msftBefore = IERC20(MSFT).balanceOf(to);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory mins = new uint256[](1);
        ids[0] = PB_BROKER;
        vm.prank(PLAYBOOKS.keeper());
        PLAYBOOKS.run(ids, mins);

        assertGt(IERC20(USDG).balanceOf(to) - usdgBefore, 19e6, "INTC sold into USDG at dest");
        assertEq(IERC20(MSFT).balanceOf(to) - msftBefore, msftInTba, "MSFT handed to dest raw");
        assertEq(IERC20(INTC).balanceOf(tba), 0);
        assertEq(IERC20(INTC).balanceOf(address(PLAYBOOKS)) + IERC20(MSFT).balanceOf(address(PLAYBOOKS)), 0);
        _assertCustodyIsFees();
    }

    function test_flush_allToTheBooster() public {
        vm.prank(alice);
        router.buyBasketEth{value: 1 ether}(0, alice, block.timestamp + 600);
        uint256 fees = router.feesAccrued();
        assertGt(fees, 0);
        uint256 b0 = BOOSTER.balance;
        uint256 floorEth = router.minEthOut(fees); // read first: a prank is spent on the next call
        vm.prank(RELAY);
        router.flushFees(floorEth);
        assertGt(BOOSTER.balance - b0, 0);
        assertEq(router.feesAccrued(), 0);
        assertEq(IERC20(USDG).balanceOf(address(router)), 0);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeskNFT, IERC6551RegistryDesk} from "../src/DeskNFT.sol";
import {DeskAccount} from "../src/DeskAccount.sol";
import {IDeskNFTView, IAggregatorV3Desk} from "../src/DeskEngine.sol";
import {DeskDepositRouter, ICoatRouterSell} from "../src/DeskDepositRouter.sol";

/// The deposit router against the REAL mainnet venues: ETH through the WETH/USDG v3 pool with
/// the Chainlink ETH/USD feed the Booster uses, COAT through the live COAT router (hooked v4).
///
///   forge test --match-path test/ForkDeskDepositRouter.t.sol -vv
contract ForkDeskDepositRouterTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant COAT = 0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833;
    address constant COAT_ROUTER = 0x740baEEF895444a659fD0fc5Dc213BEDe7d1EaaF;
    address constant MID_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // WETH/USDG, 1 bp
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9; // Booster.ethUsdFeed
    address constant REGISTRY_6551 = 0x000000006551c19487814612e58FE06813775758;

    DeskNFT desks;
    DeskDepositRouter router;
    address alice = address(0xA11CE);

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        require(block.chainid == 4663, "mainnet fork");
        DeskAccount impl = new DeskAccount(address(0xE9));
        desks = new DeskNFT(
            IERC20(COAT), address(0xB0), IERC6551RegistryDesk(REGISTRY_6551), address(impl), address(this)
        );
        desks.setMintOpen(true);
        desks.setMintPrice(0);
        router = new DeskDepositRouter(
            IERC20(USDG),
            WETH,
            IERC20(COAT),
            IDeskNFTView(address(desks)),
            ICoatRouterSell(COAT_ROUTER),
            MID_POOL,
            IAggregatorV3Desk(ETH_USD),
            address(this)
        );
        vm.deal(alice, 10 ether);
    }

    function test_depositEth_at_the_real_pool() public {
        vm.prank(alice);
        (uint256 id, address acct) = desks.mint();
        uint256 floor = router.minUsdgForEth(0.1 ether);
        vm.prank(alice);
        uint256 out = router.depositEth{value: 0.1 ether}(id, 0);
        assertEq(IERC20(USDG).balanceOf(acct), out);
        assertGe(out, floor);
        assertEq(address(router).balance, 0);
        assertEq(IERC20(WETH).balanceOf(address(router)), 0);
        console2.log("0.1 ETH -> USDG (6dp)", out);
        console2.log("  vs chainlink, bps", (out * 10_000) / ((floor * 10_000) / 9_700));
    }

    function test_depositCoat_through_the_live_coat_router() public {
        vm.prank(alice);
        (uint256 id, address acct) = desks.mint();
        deal(COAT, alice, 500_000 ether);
        vm.startPrank(alice);
        IERC20(COAT).approve(address(router), 500_000 ether);
        uint256 out = router.depositCoat(id, 500_000 ether, 1, 0);
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(IERC20(USDG).balanceOf(acct), out);
        assertEq(IERC20(COAT).balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
        console2.log("500,000 COAT -> USDG (6dp)", out);
    }
}

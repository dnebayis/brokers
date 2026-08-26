// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeskNFT} from "../src/DeskNFT.sol";
import {DeskAccount} from "../src/DeskAccount.sol";
import {TestERC6551Registry} from "./Helpers6551.sol";

contract MintCoat is ERC20 {
    constructor() ERC20("COAT", "COAT") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

contract DeskNFTTest is Test {
    MintCoat coat;
    TestERC6551Registry registry;
    DeskAccount impl;
    DeskNFT desks;

    address ownerAddr = address(0xA11CE);
    address pool = address(0xF00D); // stand-in for CoatBonusPool (plain receiver)
    address engine = address(0xE61E);
    address alice = address(0xAA);
    address bob = address(0xBB);

    function setUp() public {
        coat = new MintCoat();
        registry = new TestERC6551Registry();
        impl = new DeskAccount(engine);
        desks = new DeskNFT(IERC20(address(coat)), pool, registry, address(impl), ownerAddr);
        vm.prank(ownerAddr);
        desks.setMintOpen(true);
        coat.transfer(alice, 1_000_000e18);
        coat.transfer(bob, 1_000_000e18);
    }

    function _mintAs(address who) internal returns (uint256 id, address acct) {
        vm.startPrank(who);
        coat.approve(address(desks), type(uint256).max);
        (id, acct) = desks.mint();
        vm.stopPrank();
    }

    function test_mint_paysPoolAndDeploysWallet() public {
        (uint256 id, address acct) = _mintAs(alice);
        assertEq(id, 1);
        assertEq(desks.ownerOf(1), alice);
        assertEq(coat.balanceOf(pool), 120_000e18); // full price to the pool, nothing burned
        assertGt(acct.code.length, 0); // wallet really deployed
        assertEq(desks.accountOf(1), acct);
        // the wallet knows its identity and owner
        DeskAccount w = DeskAccount(payable(acct));
        (, address tokenContract, uint256 tokenId) = w.token();
        assertEq(tokenContract, address(desks));
        assertEq(tokenId, 1);
        assertEq(w.owner(), alice);
    }

    function test_mint_closedAndPriceLevers() public {
        vm.prank(ownerAddr);
        desks.setMintOpen(false);
        vm.expectRevert(DeskNFT.MintClosed.selector);
        vm.prank(alice);
        desks.mint();

        vm.prank(ownerAddr);
        desks.setMintPrice(1e18);
        vm.prank(ownerAddr);
        desks.setMintOpen(true);
        (uint256 id,) = _mintAs(bob);
        assertEq(id, 1);
        assertEq(coat.balanceOf(pool), 1e18);
    }

    function test_cap500() public {
        vm.prank(ownerAddr);
        desks.setMintPrice(0); // cap test without COAT bookkeeping noise
        vm.startPrank(alice);
        for (uint256 i; i < 500; ++i) {
            desks.mint();
        }
        vm.expectRevert(DeskNFT.SoldOut.selector);
        desks.mint();
        vm.stopPrank();
        assertEq(desks.totalMinted(), 500);
    }

    function test_walletControlFollowsTheNft() public {
        (uint256 id, address acct) = _mintAs(alice);
        coat.transfer(acct, 10e18); // desk holds funds
        DeskAccount w = DeskAccount(payable(acct));

        // bob cannot execute
        vm.prank(bob);
        vm.expectRevert(DeskAccount.InvalidSigner.selector);
        w.execute(address(coat), 0, abi.encodeCall(IERC20.transfer, (bob, 1e18)), 0);

        // alice can withdraw from her desk
        vm.prank(alice);
        w.execute(address(coat), 0, abi.encodeCall(IERC20.transfer, (alice, 1e18)), 0);
        assertEq(coat.balanceOf(acct), 9e18);

        // selling the desk hands over the wallet, contents included
        vm.prank(alice);
        desks.transferFrom(alice, bob, id);
        assertEq(w.owner(), bob);
        vm.prank(bob);
        w.execute(address(coat), 0, abi.encodeCall(IERC20.transfer, (bob, 9e18)), 0);
        vm.prank(alice);
        vm.expectRevert(DeskAccount.InvalidSigner.selector);
        w.execute(address(coat), 0, abi.encodeCall(IERC20.transfer, (alice, 1e18)), 0);
    }

    function test_enginePull_gateAndKillSwitch() public {
        (, address acct) = _mintAs(alice);
        coat.transfer(acct, 100e18);
        DeskAccount w = DeskAccount(payable(acct));

        // only the engine may pull
        vm.prank(bob);
        vm.expectRevert(DeskAccount.OnlyEngine.selector);
        w.enginePull(address(coat), 1e18);

        // engine pulls into itself
        vm.prank(engine);
        w.enginePull(address(coat), 40e18);
        assertEq(coat.balanceOf(engine), 40e18);

        // owner kill switch blocks the engine, and only the owner can flip it
        vm.prank(bob);
        vm.expectRevert(DeskAccount.InvalidSigner.selector);
        w.setEnginePaused(true);
        vm.prank(alice);
        w.setEnginePaused(true);
        vm.prank(engine);
        vm.expectRevert(DeskAccount.EnginePausedError.selector);
        w.enginePull(address(coat), 1e18);

        // unpause restores it
        vm.prank(alice);
        w.setEnginePaused(false);
        vm.prank(engine);
        w.enginePull(address(coat), 1e18);
        assertEq(coat.balanceOf(engine), 41e18);
    }

    function test_tokenURI_fallbackAndRenderer() public {
        _mintAs(alice);
        string memory uri = desks.tokenURI(1);
        assertTrue(bytes(uri).length > 0);
        vm.prank(ownerAddr);
        desks.setRenderer(address(0xCAFE));
        vm.mockCall(
            address(0xCAFE),
            abi.encodeWithSignature("tokenURI(uint256)", 1),
            abi.encode("ipfs://never-actually-ipfs")
        );
        assertEq(desks.tokenURI(1), "ipfs://never-actually-ipfs");
    }
}

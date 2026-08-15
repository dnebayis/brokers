// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrokerAccount, IERC6551Account, IERC6551Executable} from "../src/BrokerAccount.sol";
import {IERC6551Registry} from "../src/interfaces/IExternal.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {MockERC20, TestERC6551Registry} from "./Mocks.sol";

contract MockNFT is ERC721 {
    constructor() ERC721("Mock", "MOCK") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract BrokerAccountTest is Test {
    BrokerAccount impl;
    TestERC6551Registry registry;
    MockNFT nft;
    BrokerAccount acct;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 constant ID = 7;

    function setUp() public {
        impl = new BrokerAccount();
        registry = new TestERC6551Registry();
        nft = new MockNFT();
        nft.mint(alice, ID);
        acct =
            BrokerAccount(payable(registry.createAccount(address(impl), 0, block.chainid, address(nft), ID)));
    }

    function test_token_decodesFooter() public view {
        (uint256 chainId, address tokenContract, uint256 tokenId) = acct.token();
        assertEq(chainId, block.chainid);
        assertEq(tokenContract, address(nft));
        assertEq(tokenId, ID);
    }

    function test_owner_tracksNftOwner() public {
        assertEq(acct.owner(), alice);
        vm.prank(alice);
        nft.transferFrom(alice, bob, ID);
        assertEq(acct.owner(), bob); // wallet control moves with the NFT
    }

    function test_execute_onlyOwner_sendsEth() public {
        vm.deal(address(acct), 1 ether);
        address sink = makeAddr("sink");

        // non-owner cannot execute
        vm.expectRevert(bytes("Invalid signer"));
        vm.prank(bob);
        acct.execute(sink, 0.3 ether, "", 0);

        // owner can; state bumps
        assertEq(acct.state(), 0);
        vm.prank(alice);
        acct.execute(sink, 0.3 ether, "", 0);
        assertEq(sink.balance, 0.3 ether);
        assertEq(acct.state(), 1);
    }

    function test_execute_controlFollowsTransfer() public {
        vm.deal(address(acct), 1 ether);
        vm.prank(alice);
        nft.transferFrom(alice, bob, ID);

        // old owner now rejected, new owner allowed
        vm.expectRevert(bytes("Invalid signer"));
        vm.prank(alice);
        acct.execute(bob, 0.1 ether, "", 0);

        vm.prank(bob);
        acct.execute(bob, 0.1 ether, "", 0);
        assertEq(bob.balance, 0.1 ether);
    }

    function test_execute_ownerTransfersErc20WithoutMovingNft() public {
        MockERC20 stock = new MockERC20("Stock", "STOCK");
        stock.mint(address(acct), 5 ether);

        vm.prank(alice);
        acct.execute(address(stock), 0, abi.encodeCall(stock.transfer, (bob, 2 ether)), 0);

        assertEq(stock.balanceOf(address(acct)), 3 ether);
        assertEq(stock.balanceOf(bob), 2 ether);
        assertEq(nft.ownerOf(ID), alice);
        assertEq(acct.owner(), alice);
    }

    function test_execute_rejectsNonCallOperation() public {
        vm.deal(address(acct), 1 ether);
        vm.expectRevert(bytes("Only call operations are supported"));
        vm.prank(alice);
        acct.execute(bob, 0, "", 1); // delegatecall not supported
    }

    function test_supportsInterface() public view {
        assertTrue(acct.supportsInterface(type(IERC165).interfaceId));
        assertTrue(acct.supportsInterface(type(IERC6551Account).interfaceId));
        assertTrue(acct.supportsInterface(type(IERC6551Executable).interfaceId));
        assertFalse(acct.supportsInterface(0xffffffff));
    }

    function test_deterministicAddress() public view {
        assertEq(registry.account(address(impl), 0, block.chainid, address(nft), ID), address(acct));
    }
}

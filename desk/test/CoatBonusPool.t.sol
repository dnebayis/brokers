// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CoatBonusPool} from "../src/CoatBonusPool.sol";
import {ICoattailBrokerView} from "../src/interfaces/ICoattailCore.sol";

contract MockCoat is ERC20 {
    constructor() ERC20("COAT", "COAT") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

contract MockBrokers is ICoattailBrokerView {
    mapping(uint256 => address) public tba;
    mapping(uint256 => address) private _owner;

    function set(uint256 id, address owner_, address tba_) external {
        _owner[id] = owner_;
        tba[id] = tba_;
    }

    function ownerOf(uint256 id) external view returns (address) {
        require(_owner[id] != address(0), "nonexistent");
        return _owner[id];
    }

    function accountOf(uint256 id) external view returns (address) {
        require(_owner[id] != address(0), "nonexistent");
        return tba[id];
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

contract CoatBonusPoolTest is Test {
    MockCoat coat;
    MockBrokers brokers;
    CoatBonusPool pool;
    address poster = address(0xBEEF);
    address ownerAddr = address(0xA11CE);

    // three brokers with distinct TBAs
    address tba1 = address(0x1111);
    address tba2 = address(0x2222);
    address tba3 = address(0x3333);

    bytes32 leaf1;
    bytes32 leaf2;
    bytes32 root;

    function setUp() public {
        coat = new MockCoat();
        brokers = new MockBrokers();
        brokers.set(1, address(0xD1), tba1);
        brokers.set(2, address(0xD2), tba2);
        brokers.set(300, address(0xD3), tba3);
        pool = new CoatBonusPool(IERC20(address(coat)), brokers, poster, ownerAddr);

        // two-leaf tree: (tokenId 1, 100e18) and (tokenId 2, 50e18)
        leaf1 = _leaf(1, 100e18);
        leaf2 = _leaf(2, 50e18);
        root = _hashPair(leaf1, leaf2);
    }

    function _leaf(uint256 id, uint256 amt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(id, amt))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _proofFor(bytes32 sibling) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = sibling;
    }

    function _fundAndPost(uint256 total) internal returns (uint256 id) {
        coat.transfer(address(pool), total);
        vm.prank(poster);
        id = pool.postRound(root, total);
    }

    function test_postRound_requiresFunds() public {
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(CoatBonusPool.InsufficientUnallocated.selector, 150e18, 0));
        pool.postRound(root, 150e18);
    }

    function test_postRound_onlyPoster() public {
        coat.transfer(address(pool), 150e18);
        vm.expectRevert(CoatBonusPool.NotPoster.selector);
        pool.postRound(root, 150e18);
    }

    function test_claim_paysTheTba_andBlocksReplay() public {
        uint256 id = _fundAndPost(150e18);
        pool.claim(id, 1, 100e18, _proofFor(leaf2));
        assertEq(coat.balanceOf(tba1), 100e18);
        assertEq(pool.outstanding(), 50e18);
        assertTrue(pool.isClaimed(id, 1));

        vm.expectRevert(CoatBonusPool.AlreadyClaimed.selector);
        pool.claim(id, 1, 100e18, _proofFor(leaf2));

        pool.claim(id, 2, 50e18, _proofFor(leaf1));
        assertEq(coat.balanceOf(tba2), 50e18);
        assertEq(pool.outstanding(), 0);
    }

    function test_claim_badProofOrWrongAmount() public {
        uint256 id = _fundAndPost(150e18);
        vm.expectRevert(CoatBonusPool.BadProof.selector);
        pool.claim(id, 1, 999e18, _proofFor(leaf2));
        vm.expectRevert(CoatBonusPool.BadProof.selector);
        pool.claim(id, 300, 100e18, _proofFor(leaf2));
    }

    function test_sweep_neverTouchesOutstanding() public {
        uint256 id = _fundAndPost(150e18);
        coat.transfer(address(pool), 40e18); // stray COAT on top of the escrow

        vm.prank(ownerAddr);
        pool.sweep(address(coat), ownerAddr);
        assertEq(coat.balanceOf(ownerAddr), 40e18); // only the excess left the pool
        assertEq(coat.balanceOf(address(pool)), 150e18); // escrow intact

        // rounds still fully claimable after the sweep
        pool.claim(id, 1, 100e18, _proofFor(leaf2));
        pool.claim(id, 2, 50e18, _proofFor(leaf1));
        assertEq(coat.balanceOf(address(pool)), 0);
    }

    function test_secondRound_isolatedBitmaps() public {
        uint256 a = _fundAndPost(150e18);
        coat.transfer(address(pool), 150e18);
        vm.prank(poster);
        uint256 b = pool.postRound(root, 150e18);

        pool.claim(a, 1, 100e18, _proofFor(leaf2));
        assertFalse(pool.isClaimed(b, 1)); // same token, different round: still claimable
        pool.claim(b, 1, 100e18, _proofFor(leaf2));
        assertEq(coat.balanceOf(tba1), 200e18);
    }

    function test_claimMany() public {
        uint256 id = _fundAndPost(150e18);
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amts = new uint256[](2);
        bytes32[][] memory proofs = new bytes32[][](2);
        ids[0] = 1;
        ids[1] = 2;
        amts[0] = 100e18;
        amts[1] = 50e18;
        proofs[0] = _proofFor(leaf2);
        proofs[1] = _proofFor(leaf1);
        pool.claimMany(id, ids, amts, proofs);
        assertEq(coat.balanceOf(tba1), 100e18);
        assertEq(coat.balanceOf(tba2), 50e18);
    }
}

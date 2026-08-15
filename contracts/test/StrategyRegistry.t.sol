// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";

contract StrategyRegistryTest is Test {
    StrategyRegistry reg;
    address admin = makeAddr("admin");
    address updater = makeAddr("updater");
    address relayer = makeAddr("relayer"); // anyone can relay a signed vector
    address signer;
    uint256 signerPk;

    address t1 = makeAddr("NVDA");
    address t2 = makeAddr("MSFT");

    function setUp() public {
        (signer, signerPk) = makeAddrAndKey("oracle");
        reg = new StrategyRegistry(admin, updater);
        vm.startPrank(admin);
        reg.createStrategy("The Politician");
        reg.setOracleSigner(signer);
        vm.stopPrank();
    }

    function _basket() internal view returns (address[] memory tokens, uint16[] memory w) {
        tokens = new address[](2);
        w = new uint16[](2);
        tokens[0] = t1;
        tokens[1] = t2;
        w[0] = 6000;
        w[1] = 4000;
    }

    function _sign(uint256 id, address[] memory tokens, uint16[] memory w, uint64 epoch, uint256 deadline)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                reg.UPDATE_TYPEHASH(),
                id,
                keccak256(abi.encodePacked(tokens)),
                keccak256(abi.encodePacked(w)),
                epoch,
                deadline
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("CoattailStrategyRegistry")),
                keccak256(bytes("1")),
                block.chainid,
                address(reg)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function test_setStrategyWithSig_appliesAndBumpsEpoch() public {
        (address[] memory tokens, uint16[] memory w) = _basket();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(0, tokens, w, 1, deadline);

        vm.prank(relayer); // NOT the signer — authorization is the signature
        reg.setStrategyWithSig(0, tokens, w, 1, deadline, sig);

        (address[] memory gotT, uint16[] memory gotW, uint64 epoch) = reg.getBasket(0);
        assertEq(epoch, 1);
        assertEq(gotT[0], t1);
        assertEq(gotW[1], 4000);
    }

    function test_replaySameSig_reverts() public {
        (address[] memory tokens, uint16[] memory w) = _basket();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(0, tokens, w, 1, deadline);
        reg.setStrategyWithSig(0, tokens, w, 1, deadline, sig);

        // second submit: epoch is now 1, expected 2 → the old sig can't replay
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.BadEpoch.selector, uint64(2), uint64(1)));
        reg.setStrategyWithSig(0, tokens, w, 1, deadline, sig);
    }

    function test_wrongSigner_reverts() public {
        (address[] memory tokens, uint16[] memory w) = _basket();
        uint256 deadline = block.timestamp + 1 hours;
        // sign with a different key
        (, uint256 evilPk) = makeAddrAndKey("evil");
        bytes32 structHash = keccak256(
            abi.encode(
                reg.UPDATE_TYPEHASH(),
                uint256(0),
                keccak256(abi.encodePacked(tokens)),
                keccak256(abi.encodePacked(w)),
                uint64(1),
                deadline
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("CoattailStrategyRegistry")),
                keccak256(bytes("1")),
                block.chainid,
                address(reg)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(evilPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        vm.expectRevert(StrategyRegistry.BadSignature.selector);
        reg.setStrategyWithSig(0, tokens, w, 1, deadline, abi.encodePacked(r, s, v));
    }

    function test_expiredDeadline_reverts() public {
        (address[] memory tokens, uint16[] memory w) = _basket();
        uint256 deadline = block.timestamp + 100;
        bytes memory sig = _sign(0, tokens, w, 1, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(StrategyRegistry.SigExpired.selector);
        reg.setStrategyWithSig(0, tokens, w, 1, deadline, sig);
    }

    function test_tamperedWeights_reverts() public {
        (address[] memory tokens, uint16[] memory w) = _basket();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(0, tokens, w, 1, deadline);
        w[0] = 7000; // change payload after signing
        w[1] = 3000;
        vm.expectRevert(StrategyRegistry.BadSignature.selector);
        reg.setStrategyWithSig(0, tokens, w, 1, deadline, sig);
    }

    function test_roleFallback_stillWorks() public {
        (address[] memory tokens, uint16[] memory w) = _basket();
        vm.prank(updater);
        reg.setStrategy(0, tokens, w);
        (,, uint64 epoch) = reg.getBasket(0);
        assertEq(epoch, 1);
    }

    address t3 = makeAddr("COIN");

    function test_drift_blocksFullRotation() public {
        (address[] memory a, uint16[] memory aw) = _basket();
        vm.prank(updater);
        reg.setStrategy(0, a, aw); // epoch 1 (no drift check on first)

        vm.prank(admin);
        reg.setMaxDriftBps(3000); // 30% max turnover

        // rotate entirely into t3 -> turnover 100% -> revert
        address[] memory c = new address[](1);
        uint16[] memory cw = new uint16[](1);
        c[0] = t3;
        cw[0] = 10000;
        vm.prank(updater);
        vm.expectRevert(
            abi.encodeWithSelector(StrategyRegistry.DriftTooHigh.selector, uint256(10000), uint256(3000))
        );
        reg.setStrategy(0, c, cw);
    }

    function test_drift_allowsSmallShift() public {
        (address[] memory a, uint16[] memory aw) = _basket(); // 6000/4000
        vm.prank(updater);
        reg.setStrategy(0, a, aw);
        vm.prank(admin);
        reg.setMaxDriftBps(3000);

        // shift to 5000/5000 -> turnover 10% -> allowed
        address[] memory b = new address[](2);
        uint16[] memory bw = new uint16[](2);
        b[0] = t1;
        b[1] = t2;
        bw[0] = 5000;
        bw[1] = 5000;
        vm.prank(updater);
        reg.setStrategy(0, b, bw);
        (, uint16[] memory gotW, uint64 epoch) = reg.getBasket(0);
        assertEq(epoch, 2);
        assertEq(gotW[0], 5000);
    }

    function test_drift_disabledByDefault() public {
        (address[] memory a, uint16[] memory aw) = _basket();
        vm.prank(updater);
        reg.setStrategy(0, a, aw);
        // default maxDriftBps == BPS -> even a full rotation is allowed
        address[] memory c = new address[](1);
        uint16[] memory cw = new uint16[](1);
        c[0] = t3;
        cw[0] = 10000;
        vm.prank(updater);
        reg.setStrategy(0, c, cw); // no revert
        (address[] memory gotT,,) = reg.getBasket(0);
        assertEq(gotT[0], t3);
    }

    function test_weightsMustSumToFull() public {
        address[] memory tokens = new address[](1);
        uint16[] memory w = new uint16[](1);
        tokens[0] = t1;
        w[0] = 9999;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(0, tokens, w, 1, deadline);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.WeightsNotFull.selector, uint256(9999)));
        reg.setStrategyWithSig(0, tokens, w, 1, deadline, sig);
    }

    // --- M-3: canonical-basket validation ---

    function test_M3_rejectsZeroToken() public {
        address[] memory tokens = new address[](2);
        uint16[] memory w = new uint16[](2);
        tokens[0] = t1;
        tokens[1] = address(0);
        w[0] = 6000;
        w[1] = 4000;
        vm.prank(updater);
        vm.expectRevert(StrategyRegistry.ZeroToken.selector);
        reg.setStrategy(0, tokens, w);
    }

    function test_M3_rejectsZeroWeight() public {
        address[] memory tokens = new address[](2);
        uint16[] memory w = new uint16[](2);
        tokens[0] = t1;
        tokens[1] = t2;
        w[0] = 10000;
        w[1] = 0; // sums to full but one leg is dead weight
        vm.prank(updater);
        vm.expectRevert(StrategyRegistry.ZeroWeight.selector);
        reg.setStrategy(0, tokens, w);
    }

    function test_M3_rejectsDuplicateToken() public {
        address[] memory tokens = new address[](2);
        uint16[] memory w = new uint16[](2);
        tokens[0] = t1;
        tokens[1] = t1; // duplicate would double-count in Booster.poke
        w[0] = 5000;
        w[1] = 5000;
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.DuplicateToken.selector, t1));
        reg.setStrategy(0, tokens, w);
    }

    function test_M3_acceptsCleanBasket() public {
        (address[] memory tokens, uint16[] memory w) = _basket();
        vm.prank(updater);
        reg.setStrategy(0, tokens, w); // no revert
        (address[] memory gotT,,) = reg.getBasket(0);
        assertEq(gotT.length, 2);
    }
}

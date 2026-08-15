// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrokerAccount} from "../src/BrokerAccount.sol";
import {CoattailBroker} from "../src/CoattailBroker.sol";
import {IERC6551Registry} from "../src/interfaces/IExternal.sol";

/// Fork preflight for RH testnet: confirms the on-chain ERC-6551 registry actually deploys
/// OUR BrokerAccount and that token()/owner() resolve — before we spend real gas.
/// Run explicitly (needs network):
///   forge test --match-contract ForkTestnet --fork-url https://rpc.testnet.chain.robinhood.com -vv
contract ForkTestnetTest is Test {
    address constant REGISTRY_6551 = 0x000000006551c19487814612e58FE06813775758;

    function test_registryDeploysOurAccount() public {
        // skip unless run against the testnet fork
        if (block.chainid != 46630) {
            emit log("skipped: run with --fork-url https://rpc.testnet.chain.robinhood.com");
            return;
        }
        assertGt(REGISTRY_6551.code.length, 0, "registry missing on this chain");

        BrokerAccount impl = new BrokerAccount();
        address treasury = makeAddr("treasury");
        address minter = makeAddr("minter");

        CoattailBroker broker = new CoattailBroker(
            address(this), treasury, IERC6551Registry(REGISTRY_6551), address(impl), "ipfs://x/"
        );
        broker.setMintOpen(true);

        vm.deal(minter, 1 ether);
        uint256 price = broker.mintPriceWei();
        vm.prank(minter);
        broker.mint{value: price}(1);

        uint256 tokenId;
        for (uint256 id = 1; id <= broker.MAX_SUPPLY(); ++id) {
            try broker.ownerOf(id) returns (address actualOwner) {
                if (actualOwner == minter) {
                    tokenId = id;
                    break;
                }
            } catch {}
        }
        assertGt(tokenId, 0, "random token ID missing");
        address wallet = broker.accountOf(tokenId);
        assertGt(wallet.code.length, 0, "registry did not deploy the account");
        assertEq(BrokerAccount(payable(wallet)).owner(), minter, "owner() mismatch vs real registry");

        (uint256 chainId, address tokenContract, uint256 decodedTokenId) =
            BrokerAccount(payable(wallet)).token();
        assertEq(chainId, 46630);
        assertEq(tokenContract, address(broker));
        assertEq(decodedTokenId, tokenId);
    }
}

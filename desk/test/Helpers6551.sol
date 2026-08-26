// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC6551RegistryDesk} from "../src/DeskNFT.sol";

/// Byte-identical clone of the canonical ERC-6551 registry proxy deployment (copied from
/// contracts/test/Mocks.sol so the desk project stays decoupled from the core tree). Accounts
/// it deploys carry the (salt, chainId, tokenContract, tokenId) footer at offset 0x4d, exactly
/// like mainnet, so DeskAccount.token()/owner() resolve for real.
contract TestERC6551Registry is IERC6551RegistryDesk {
    function createAccount(
        address impl,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address addr) {
        addr = account(impl, salt, chainId, tokenContract, tokenId);
        if (addr.code.length != 0) return addr;
        bytes memory code = _creationCode(impl, salt, chainId, tokenContract, tokenId);
        address deployed;
        assembly {
            deployed := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(deployed == addr, "create2 mismatch");
    }

    function account(address impl, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        public
        view
        returns (address)
    {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                salt,
                keccak256(_creationCode(impl, salt, chainId, tokenContract, tokenId))
            )
        );
        return address(uint160(uint256(h)));
    }

    function _creationCode(
        address impl,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"3d60ad80600a3d3981f3363d3d373d3d3d363d73",
            impl,
            hex"5af43d82803e903d91602b57fd5bf3",
            abi.encode(salt, chainId, tokenContract, tokenId)
        );
    }
}

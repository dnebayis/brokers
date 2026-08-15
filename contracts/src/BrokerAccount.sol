// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

interface IERC6551Account {
    receive() external payable;
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);
    function state() external view returns (uint256);
    function isValidSigner(address signer, bytes calldata context) external view returns (bytes4 magicValue);
}

interface IERC6551Executable {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory);
}

/// @title BrokerAccount
/// @notice The ERC-6551 token-bound account implementation for Coattail Brokers.
///         Every Broker NFT owns one of these (deployed by the canonical registry
///         `0x000000006551c19487814612e58FE06813775758`); it is the wallet that holds
///         the Broker's accrued tokenized stocks and ETH. Controlled solely by whoever
///         currently owns the bound NFT — so the wallet's contents transfer with the NFT.
/// @dev Faithful to the EIP-6551 reference account (call-only execute, ERC-1271 signing,
///      footer-encoded token identity). We ship our own because the standard account
///      implementation is NOT deployed on Robinhood Chain (see ADDRESSES.md). This is the
///      `accountImpl` passed to `CoattailBroker`'s constructor.
contract BrokerAccount is IERC165, IERC1271, IERC6551Account, IERC6551Executable {
    /// @notice Monotonic nonce, bumped on every successful `execute` (replay/UX aid).
    uint256 public state;

    receive() external payable {}

    /// @notice Execute a call from this account. Only the current NFT owner may call.
    /// @dev Call-only (operation must be 0); delegatecall/create are intentionally unsupported.
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory result)
    {
        require(_isValidSigner(msg.sender), "Invalid signer");
        require(operation == 0, "Only call operations are supported");

        ++state;

        bool success;
        (success, result) = to.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    function isValidSigner(address signer, bytes calldata) external view returns (bytes4) {
        if (_isValidSigner(signer)) return IERC6551Account.isValidSigner.selector;
        return bytes4(0);
    }

    function isValidSignature(bytes32 hash, bytes memory signature)
        external
        view
        returns (bytes4 magicValue)
    {
        if (SignatureChecker.isValidSignatureNow(owner(), hash, signature)) {
            return IERC1271.isValidSignature.selector;
        }
        return bytes4(0);
    }

    /// @notice The NFT this account is bound to, decoded from the proxy footer.
    function token() public view returns (uint256 chainId, address tokenContract, uint256 tokenId) {
        bytes memory footer = new bytes(0x60);
        assembly {
            // The canonical registry appends abi.encode(salt, chainId, tokenContract, tokenId)
            // after the 45-byte ERC-1167 proxy + 32-byte salt; the last 0x60 bytes are
            // (chainId, tokenContract, tokenId) starting at code offset 0x4d.
            extcodecopy(address(), add(footer, 0x20), 0x4d, 0x60)
        }
        return abi.decode(footer, (uint256, address, uint256));
    }

    /// @notice Current controller = owner of the bound NFT (address(0) if cross-chain).
    function owner() public view returns (address) {
        (uint256 chainId, address tokenContract, uint256 tokenId) = token();
        if (chainId != block.chainid) return address(0);
        return IERC721(tokenContract).ownerOf(tokenId);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC6551Account).interfaceId
            || interfaceId == type(IERC6551Executable).interfaceId;
    }

    // --- receive NFTs so the wallet is fully composable (stocks are ERC-20, no hook needed) ---
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    function _isValidSigner(address signer) internal view returns (bool) {
        return signer == owner();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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

/// @title DeskAccount
/// @notice The ERC-6551 wallet behind every Desk NFT. Identical control model to the
///         battle-tested BrokerAccount (owner-only `execute`, ERC-1271 signing, footer-encoded
///         identity) plus ONE addition: a standing, owner-revocable authorization that lets the
///         DeskEngine pull funds for basket execution. The engine address is burned into the
///         implementation at deploy time, so no owner, admin, or upgrade can ever widen it.
/// @dev The engine's entire power over a Desk is `enginePull`: move ERC-20 from the Desk to the
///      engine contract, whose own immutable logic swaps and returns the proceeds to the SAME
///      Desk. It cannot call arbitrary contracts from the account, cannot touch ETH, and the
///      owner can shut it off at any time with `setEnginePaused(true)`.
contract DeskAccount is IERC165, IERC1271, IERC6551Account, IERC6551Executable {
    using SafeERC20 for IERC20;

    /// @notice Monotonic nonce, bumped on every state-changing entry (replay/UX aid).
    uint256 public state;

    /// @notice The only address allowed to pull funds, fixed for the implementation's lifetime.
    address public immutable engine;

    /// @notice Per-Desk kill switch for the engine authorization. Owner-set; survives transfers
    ///         (the new owner inherits the previous setting and can flip it at will).
    bool public enginePaused;

    event EnginePausedSet(bool paused);
    event EnginePulled(address indexed token, uint256 amount);

    error InvalidSigner();
    error OnlyCallsSupported();
    error OnlyEngine();
    error EnginePausedError();

    constructor(address engine_) {
        engine = engine_;
    }

    receive() external payable {}

    /// @notice Execute a call from this account. Only the current NFT owner may call.
    /// @dev Call-only (operation must be 0); delegatecall/create are intentionally unsupported.
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory result)
    {
        if (!_isValidSigner(msg.sender)) revert InvalidSigner();
        if (operation != 0) revert OnlyCallsSupported();

        ++state;

        bool success;
        (success, result) = to.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    /// @notice Owner's kill switch over the engine authorization.
    function setEnginePaused(bool paused) external {
        if (!_isValidSigner(msg.sender)) revert InvalidSigner();
        ++state;
        enginePaused = paused;
        emit EnginePausedSet(paused);
    }

    /// @notice The engine's ONLY entry: pull `amount` of `token` into the engine for execution.
    ///         The engine's immutable logic is responsible for returning proceeds to this Desk.
    function enginePull(address token, uint256 amount) external {
        if (msg.sender != engine) revert OnlyEngine();
        if (enginePaused) revert EnginePausedError();
        ++state;
        IERC20(token).safeTransfer(engine, amount);
        emit EnginePulled(token, amount);
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

    // --- receive NFTs so the wallet stays fully composable ---
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

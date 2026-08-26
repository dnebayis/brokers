// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IERC6551RegistryDesk {
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address account);

    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address account);
}

interface IDeskRenderer {
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

/// @title DeskNFT
/// @notice The 500 Desks. Minting costs COAT (settable; none of it is burned — 100% flows to
///         the CoatBonusPool for distribution to active Brokers), and every Desk deploys its
///         own ERC-6551 wallet at mint. Open to everyone; no allowlist, no holder gate
///         (community-communicated decision, 2026-08-26).
/// @dev The 500 cap is a constant by design: it is the product's scarcity promise, the one
///      number that must not be a lever. Everything else (price, renderer, open/closed) ships
///      settable — the 36,750 lesson.
contract DeskNFT is ERC721, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    uint256 public constant MAX_DESKS = 500;
    bytes32 public constant SALT = bytes32(0);

    IERC20 public immutable coat;
    address public immutable bonusPool;
    IERC6551RegistryDesk public immutable registry;
    address public immutable accountImpl;

    uint256 public mintPrice = 120_000e18;
    bool public mintOpen;
    address public renderer;
    uint256 public totalMinted;

    event MintPriceSet(uint256 price);
    event MintOpenSet(bool open);
    event RendererSet(address renderer);
    event DeskMinted(uint256 indexed tokenId, address indexed to, address account, uint256 coatPaid);

    error ZeroAddress();
    error MintClosed();
    error SoldOut();

    constructor(
        IERC20 coat_,
        address bonusPool_,
        IERC6551RegistryDesk registry_,
        address accountImpl_,
        address owner_
    ) ERC721("The Desk", "DESK") Ownable(owner_) {
        if (
            address(coat_) == address(0) || bonusPool_ == address(0) || address(registry_) == address(0)
                || accountImpl_ == address(0)
        ) revert ZeroAddress();
        coat = coat_;
        bonusPool = bonusPool_;
        registry = registry_;
        accountImpl = accountImpl_;
    }

    // --- admin (all settable levers) ---

    function setMintPrice(uint256 price) external onlyOwner {
        mintPrice = price;
        emit MintPriceSet(price);
    }

    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
        emit MintOpenSet(open);
    }

    function setRenderer(address renderer_) external onlyOwner {
        renderer = renderer_;
        emit RendererSet(renderer_);
    }

    // --- mint ---

    /// @notice Open a Desk: pay the COAT price (straight to the bonus pool, nothing burned),
    ///         receive Desk #id and its freshly deployed 6551 wallet.
    function mint() external nonReentrant returns (uint256 tokenId, address account) {
        if (!mintOpen) revert MintClosed();
        if (totalMinted >= MAX_DESKS) revert SoldOut();
        tokenId = ++totalMinted;

        uint256 price = mintPrice;
        if (price > 0) coat.safeTransferFrom(msg.sender, bonusPool, price);

        _safeMint(msg.sender, tokenId);
        account = registry.createAccount(accountImpl, SALT, block.chainid, address(this), tokenId);
        emit DeskMinted(tokenId, msg.sender, account, price);
    }

    /// @notice The Desk's 6551 wallet address (deterministic; deployed at mint).
    function accountOf(uint256 tokenId) external view returns (address) {
        _requireOwned(tokenId);
        return registry.account(accountImpl, SALT, block.chainid, address(this), tokenId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (renderer != address(0)) return IDeskRenderer(renderer).tokenURI(tokenId);
        // Pre-renderer fallback: honest minimal metadata, replaced before public mint.
        return string(
            abi.encodePacked(
                'data:application/json;utf8,{"name":"Desk #',
                tokenId.toString(),
                '","description":"A seat at the Coattail operation. Renderer pending."}'
            )
        );
    }
}

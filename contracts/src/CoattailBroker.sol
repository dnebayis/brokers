// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC6551Registry} from "./interfaces/IExternal.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IBoosterHook {
    function activate(uint256 tokenId) external;
    function deactivate(uint256 tokenId) external;
}

interface ICoatBurnable {
    function burnFrom(address account, uint256 amount) external;
}

interface IBrokerRenderer {
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

/// @title CoattailBroker
/// @notice The Broker collection. 1,776 pixel-art brokers, each bound to a strategy
///         and each owning its own ERC-6551 token-bound wallet. Booster rewards first
///         accrue as token-ID claimable balances; the owner moves whole raw-token
///         amounts into that wallet by claiming. Mint is a flat 0.0015 ETH.
///
///         Two-step model:
///           1. mint()     — 0.0015 ETH, one-time. You get an *inactive* Broker + wallet.
///           2. activate()  — burn $COAT to switch the Broker ON so it starts accruing
///                            claimable balances for the strategy basket.
///         Transferring an *active* Broker deactivates it. Unclaimed entitlement follows
///         the token; assets already claimed into its wallet follow only while left there.
///         Burn is a pure sink — nothing is handed out — so there is no mint-and-dump
///         arb, and re-activation keeps recurring $COAT demand (no vesting needed).
/// @dev Mint is a distribution tool, not a revenue source (see WHITEPAPER §8).
///      Flat ETH price avoids a Chainlink dependency (RH Chain has no ETH/USD feed).
contract CoattailBroker is ERC721, ERC2981, Ownable2Step, ReentrancyGuard {
    // --- supply / config ---
    uint256 public constant MAX_SUPPLY = 1776;
    uint256 public constant WALLET_CAP = 2; // primary mint cap; secondary ownership is unrestricted

    // v1: every Broker is THE_POLITICIAN. Trait kept for future strategies.
    uint256 public constant STRATEGY_POLITICIAN = 0;

    // --- ERC-6551 ---
    IERC6551Registry public immutable registry;
    address public immutable accountImpl; // tokenbound reference account
    bytes32 public constant SALT = bytes32(0);

    // --- pricing ---
    uint256 public constant MINT_PRICE = 0.0015 ether;
    uint256 public constant ACTIVATION_BURN = 36_750 ether;

    // --- state ---
    uint256 public totalMinted;
    bool public mintOpen;
    address public creator; // receives mint proceeds directly
    IBoosterHook public booster; // reward engine (set post-deploy)
    IBrokerRenderer public renderer; // on-chain art (set post-deploy)
    ICoatBurnable public coat; // $COAT, burned to activate (set post-deploy)
    string private _baseTokenUri;

    mapping(uint256 tokenId => uint256 strategyId) public strategyOf;
    mapping(address minter => uint256 count) public mintedBy;
    mapping(uint256 tokenId => bool) public activated; // earning the strategy basket?

    // Sparse Fisher-Yates table. An empty slot means its untouched value is index + 1.
    // Drawing swaps the chosen slot with the last remaining slot, so every ID in
    // 1..MAX_SUPPLY can be selected exactly once without storing a 1,776-item array.
    mapping(uint256 poolIndex => uint256 tokenId) private _remainingId;

    event Minted(address indexed to, uint256 indexed tokenId, address account, uint256 paidWei);
    event Activated(uint256 indexed tokenId, address indexed owner, uint256 coatBurned);
    event Deactivated(uint256 indexed tokenId);
    event CreatorUpdated(address creator);
    event CoatUpdated(address coat);
    event MintStateChanged(bool open);

    error SoldOut();
    error WalletCapReached();
    error InsufficientPayment(uint256 required, uint256 sent);
    error RefundFailed();
    error NotOwner();
    error AlreadyActivated();
    error CoatNotSet();
    error BoosterNotSet();
    error ZeroAddress();
    error AlreadyWired();
    error MintClosed();

    constructor(
        address owner_,
        address creator_,
        IERC6551Registry registry_,
        address accountImpl_,
        string memory baseUri_
    ) ERC721("Coattail Brokers", "COATB") Ownable(owner_) {
        if (creator_ == address(0)) revert ZeroAddress();
        creator = creator_;
        _setDefaultRoyalty(creator_, 250);
        registry = registry_;
        accountImpl = accountImpl_;
        _baseTokenUri = baseUri_;
    }

    /// @notice Mint `qty` Brokers at 0.0015 ETH each. Deploys an ERC-6551 wallet per token.
    function mint(uint256 qty) external payable nonReentrant returns (uint256[] memory tokenIds) {
        if (!mintOpen) revert MintClosed();
        tokenIds = new uint256[](qty);
        if (qty == 0) return tokenIds;
        if (totalMinted + qty > MAX_SUPPLY) revert SoldOut();
        if (mintedBy[msg.sender] + qty > WALLET_CAP) revert WalletCapReached();

        uint256 unit = MINT_PRICE;
        uint256 required = unit * qty;
        if (msg.value < required) revert InsufficientPayment(required, msg.value);

        mintedBy[msg.sender] += qty;

        for (uint256 i; i < qty; ++i) {
            uint256 tokenId = _drawRandomId(msg.sender, i);
            tokenIds[i] = tokenId;
            strategyOf[tokenId] = STRATEGY_POLITICIAN;
            _safeMint(msg.sender, tokenId);
            address acct = registry.createAccount(accountImpl, SALT, block.chainid, address(this), tokenId);
            // Brokers mint *inactive*; owner burns $COAT via activate() to start earning.
            emit Minted(msg.sender, tokenId, acct, unit);
        }

        // mint proceeds go to the creator; refund overpay
        (bool ok,) = creator.call{value: required}("");
        require(ok, "creator xfer");
        uint256 refund = msg.value - required;
        if (refund > 0) {
            (bool r,) = msg.sender.call{value: refund}("");
            if (!r) revert RefundFailed();
        }
    }

    /// @notice Opens or pauses primary minting. Deployments always start closed.
    ///         Transfers, activation and claims are intentionally unaffected.
    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
        emit MintStateChanged(open);
    }

    /// @notice Current mint price in wei (flat). Kept as a function for script/UI stability.
    function mintPriceWei() public pure returns (uint256) {
        return MINT_PRICE;
    }

    /// @notice Turn a Broker ON by burning `ACTIVATION_BURN` $COAT. It then starts earning
    ///         claimable balances for the strategy basket in the Booster.
    /// @dev Pure sink: no tokens are handed out, so activation can't be arb'd. Caller must
    ///      approve this contract for `ACTIVATION_BURN` $COAT first (burnFrom).
    function activate(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (activated[tokenId]) revert AlreadyActivated();
        if (address(coat) == address(0)) revert CoatNotSet();
        if (address(booster) == address(0)) revert BoosterNotSet();

        activated[tokenId] = true;
        coat.burnFrom(msg.sender, ACTIVATION_BURN);
        booster.activate(tokenId);
        emit Activated(tokenId, msg.sender, ACTIVATION_BURN);
    }

    /// @dev On any real transfer of an *active* Broker, deactivate it: earning stops and
    ///      the new owner must re-activate (re-burn $COAT). Unclaimed Booster entitlement
    ///      stays keyed to tokenId. Claimed wallet assets follow only while left there.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0) && from != to && activated[tokenId]) {
            activated[tokenId] = false;
            if (address(booster) != address(0)) booster.deactivate(tokenId);
            emit Deactivated(tokenId);
        }
        return from;
    }

    /// @notice Deterministic ERC-6551 wallet address for a Broker (no storage needed).
    function accountOf(uint256 tokenId) public view returns (address) {
        return registry.account(accountImpl, SALT, block.chainid, address(this), tokenId);
    }

    // --- admin ---
    /// @notice Point mint proceeds at the creator wallet.
    function setCreator(address c) external onlyOwner {
        if (c == address(0)) revert ZeroAddress();
        creator = c;
        _setDefaultRoyalty(c, 250);
        emit CreatorUpdated(c);
    }

    /// @notice Wire the Booster after deploy (resolves the Broker<->Booster cycle).
    function setBooster(IBoosterHook b) external onlyOwner {
        if (address(b) == address(0)) revert ZeroAddress();
        if (address(booster) != address(0)) revert AlreadyWired();
        booster = b;
    }

    /// @notice Wire $COAT after deploy (burned on activate). Set once at launch.
    function setCoat(ICoatBurnable c) external onlyOwner {
        if (address(c) == address(0)) revert ZeroAddress();
        if (address(coat) != address(0)) revert AlreadyWired();
        coat = c;
        emit CoatUpdated(address(c));
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        _baseTokenUri = uri;
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenUri;
    }

    /// @notice Wire the on-chain art renderer (BrokerRenderer). Once set, tokenURI
    ///         is served fully on-chain; before that it falls back to baseURI.
    function setRenderer(IBrokerRenderer r) external onlyOwner {
        renderer = r;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (address(renderer) != address(0)) {
            return renderer.tokenURI(tokenId);
        }
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    /// @dev Immediate pseudo-random selection is a UX choice, not a VRF guarantee. Robinhood
    ///      Chain currently has no documented canonical VRF. The sequencer may influence block
    ///      entropy, so callers and documentation must not describe this as manipulation-proof.
    function _drawRandomId(address minter, uint256 batchIndex) internal returns (uint256 tokenId) {
        uint256 remaining = MAX_SUPPLY - totalMinted;
        uint256 randomIndex = uint256(
            keccak256(
                abi.encode(
                    block.prevrandao,
                    blockhash(block.number - 1),
                    minter,
                    block.chainid,
                    address(this),
                    totalMinted,
                    batchIndex
                )
            )
        ) % remaining;

        tokenId = _remainingId[randomIndex];
        if (tokenId == 0) tokenId = randomIndex + 1;

        uint256 lastIndex = remaining - 1;
        if (randomIndex != lastIndex) {
            uint256 lastTokenId = _remainingId[lastIndex];
            _remainingId[randomIndex] = lastTokenId == 0 ? lastIndex + 1 : lastTokenId;
        }
        if (_remainingId[lastIndex] != 0) delete _remainingId[lastIndex];
        ++totalMinted;
    }
}

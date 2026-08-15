// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title COAT
/// @notice Fixed 1,000,000,000 supply, minted once to the single-sided liquidity distributor.
///      No reserve, presale, team allocation or VC allocation. Only entry into the ecosystem is
///      buying $COAT from the v4
///      pool and burning it to activate a Broker (CoattailBroker.activate). Every
///      activation and re-activation permanently burns supply — the deflationary sink.
contract COAT is ERC20, ERC20Burnable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;
    uint256 public constant LIQUIDITY_SUPPLY = MAX_SUPPLY;
    uint256 public constant MAX_WALLET = 50_000_000 ether; // 5% during protected blocks
    uint256 public constant MAX_BUY = 55_000_000 ether; // 5.5% per pool output
    uint64 public constant PROTECTION_BLOCKS = 2;

    address public immutable poolManager;
    address public immutable launchController;
    uint64 public launchBlock;
    bool public tradingEnabled;

    event TradingEnabled(uint64 indexed launchBlock, uint64 indexed restrictionsEndBlock);

    error NotLaunchController();
    error TradingAlreadyEnabled();
    error LiquidityNotSeeded();
    error LaunchBlockBuyBlocked();
    error ProtectedBuyTooLarge();
    error ProtectedWalletTooLarge();

    constructor(address liquidityDistributor, address poolManager_) ERC20("Coattail", "COAT") {
        require(liquidityDistributor != address(0) && poolManager_ != address(0), "zero recipient");
        poolManager = poolManager_;
        launchController = liquidityDistributor;
        _mint(liquidityDistributor, MAX_SUPPLY);
    }

    /// @notice Permanently opens pool buys after the single-sided position has been seeded.
    /// The enable block itself blocks buys; the following two blocks enforce the Pons-style caps.
    function enableTrading() external {
        if (msg.sender != launchController) revert NotLaunchController();
        if (tradingEnabled) revert TradingAlreadyEnabled();
        if (balanceOf(poolManager) == 0) revert LiquidityNotSeeded();
        tradingEnabled = true;
        launchBlock = uint64(block.number);
        emit TradingEnabled(launchBlock, launchBlock + PROTECTION_BLOCKS);
    }

    function restrictionsEndBlock() public view returns (uint256) {
        return uint256(launchBlock) + PROTECTION_BLOCKS;
    }

    function _update(address from, address to, uint256 value) internal override {
        bool protectedBlock = tradingEnabled && block.number <= restrictionsEndBlock();

        // Every v4 buy first leaves PoolManager, independent of which router/unlock callback
        // initiated it. This enforces the per-fill ceiling without trusting router addresses.
        if (from == poolManager && to != address(0)) {
            if (!tradingEnabled || block.number == launchBlock) revert LaunchBlockBuyBlocked();
            if (protectedBlock && value > MAX_BUY) revert ProtectedBuyTooLarge();
        }

        // A universal/custom router may TAKE to itself and forward in a second ERC-20 transfer.
        // Applying the temporary wallet ceiling to every non-pool recipient closes that relay
        // path without a router whitelist. Transfers and sales remain usable up to the launch cap.
        if (protectedBlock && to != address(0) && to != poolManager) {
            if (balanceOf(to) + value > MAX_WALLET) revert ProtectedWalletTooLarge();
        }
        super._update(from, to, value);
    }
}

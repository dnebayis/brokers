// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3, IERC6551Registry, IStockRouter, IWETH} from "../src/interfaces/IExternal.sol";

/// Minimal Chainlink feed returning a fixed answer with a fresh timestamp.
contract MockAggregator is IAggregatorV3 {
    int256 public answer;

    constructor(int256 answer_) {
        answer = answer_;
    }

    function setAnswer(int256 a) external {
        answer = a;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}

/// Deterministic ERC-6551 registry stub (no real account code deployed).
contract MockRegistry6551 is IERC6551Registry {
    function createAccount(
        address impl,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external pure returns (address) {
        return _addr(impl, salt, chainId, tokenContract, tokenId);
    }

    function account(address impl, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        pure
        returns (address)
    {
        return _addr(impl, salt, chainId, tokenContract, tokenId);
    }

    function _addr(address impl, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(keccak256(abi.encode(impl, salt, chainId, tokenContract, tokenId)))));
    }
}

/// A byte-identical clone of the canonical ERC-6551 registry's proxy deployment, so a bound
/// account's footer (chainId, tokenContract, tokenId) sits at offset 0x4d — exactly as on the
/// real chain. Lets tests deploy *real* token-bound wallets that hold tokens.
contract TestERC6551Registry is IERC6551Registry {
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

/// Minimal ERC20 for stock tokens.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public uiMultiplier = 1e18; // ERC-8056: display = raw · uiMultiplier / 1e18
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public tradingEnabled;
    uint256 public restrictionsEndBlock;
    uint256 public constant MAX_BUY = 55_000_000 ether;

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }

    function setUiMultiplier(uint256 m) external {
        uiMultiplier = m;
    }

    function setLaunchGuard(bool enabled, uint256 endBlock) external {
        tradingEnabled = enabled;
        restrictionsEndBlock = endBlock;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function burn(uint256 amt) external {
        balanceOf[msg.sender] -= amt;
    }

    function approve(address sp, uint256 a) external returns (bool) {
        allowance[msg.sender][sp] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// Minimal WETH: deposit wraps ETH 1:1.
contract MockWETH is IWETH {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 a) external {
        balanceOf[msg.sender] -= a;
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok, "withdraw");
    }

    function approve(address sp, uint256 a) external returns (bool) {
        allowance[msg.sender][sp] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// StockRouter stub: mints `msg.value * rate` of stock to the recipient.
contract MockRouter is IStockRouter {
    uint256 public rate; // tokenOut per WETH-in (both 18 decimals)

    constructor(uint256 rate_) {
        rate = rate_;
    }

    function swapExactETHForStock(address stock, uint256 minOut, address to, uint256)
        external
        payable
        returns (uint256)
    {
        uint256 out = msg.value * rate;
        require(out >= minOut, "slippage");
        MockERC20(stock).mint(to, out);
        return out;
    }
}

# COAT v4 launch parameters

`compute_params.py` produces deterministic integer/Q96 parameters using Uniswap TickMath and SqrtPriceMath-compatible rounding. It writes `launch-math.json`, which is the reviewable economic report and source for `LaunchWithHook.s.sol` constants. `parameter_sha256` hashes the canonical sorted report fields before the hash itself is appended; release reports must record it unchanged.

```bash
cd contracts
python3 launch/compute_params.py
forge test --match-contract ForkLaunchTest \
  --fork-url https://rpc.mainnet.chain.robinhood.com -vv
```

Locked model:

- 1B COAT initial supply; no reserve/team allocation.
- ticks 138000→184200; initialized at 184400; zero launch ETH.
- 1% v4 LP fee and immutable 1% hook fee.
- 36,750 COAT activation burn.
- full first activation burn 65.268M COAT.
- permanent ownerless LP locker; fees collect to immutable treasury; graduation indicator at 4.2 ETH paired principal.

Launch broadcast prerequisites:

```bash
COAT_ADDRESS=0x... FEE_SPLITTER=0x... HOOK_OWNER=0x<hardware-wallet> \
PRIVATE_KEY=0x<separate-deployer> \
forge script script/LaunchWithHook.s.sol --rpc-url "$RH_RPC"
```

Dry-run first, then add `--broadcast`. The liquidity distributor must hold exactly 1B COAT. The script mines/deploys the flag-valid hook, deploys the locker, initializes and seeds the pool, verifies LP custody, burns the rounding remainder, enables the one-shot launch window, deploys CoatRouter/BuybackBurner and wires the splitter while the deployer is still its interim owner. The hardware wallet accepts pending ownership only after launch wiring is complete.

Do not proceed to mainnet while any `REQUIRE_MAINNET_FORK=true` test fails. In particular, all stock route manifest probes must pass; testnet liquidity is not a substitute for mainnet route proof.

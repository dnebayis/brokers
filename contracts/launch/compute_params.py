#!/usr/bin/env python3
"""Deterministic COAT v4 launch math (integer/Q96 only).

The formulas mirror Uniswap TickMath/SqrtPriceMath.  No binary floating point is
used in any value that is copied into a deployment script.
"""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal, getcontext
from pathlib import Path

getcontext().prec = 100

SUPPLY = 1_000_000_000 * 10**18
PRICE_START = Decimal("1e-8")
PRICE_END = Decimal("1e-6")
FEE = 10_000
TICK_SPACING = 200
Q96 = 1 << 96
Q128 = 1 << 128
ACTIVATION_BURN = 36_750 * 10**18
ACTIVATIONS = 1_776

# Constants from Uniswap v3-core TickMath.getSqrtRatioAtTick.
_MUL = (
    0xFFF97272373D413259A46990580E213A,
    0xFFF2E50F5F656932EF12357CF3C7FDCC,
    0xFFE5CACA7E10E4E61C3624EAA0941CD0,
    0xFFCB9843D60F6159C9DB58835C926644,
    0xFF973B41FA98C081472E6896DFB254C0,
    0xFF2EA16466C96A3843EC78B326B52861,
    0xFE5DEE046A99A2A811C461F1969C3053,
    0xFCBE86C7900A88AEDCFFC83B479AA3A4,
    0xF987A7253AC413176F2B074CF7815E54,
    0xF3392B0822B70005940C7A398E4B70F3,
    0xE7159475A2C29B7443B29C7FA6E889D9,
    0xD097F3BDFD2022B8845AD8F792AA5825,
    0xA9F746462D870FDF8A65DC1F90E061E5,
    0x70D869A156D2A1B890BB3DF62BAF32F7,
    0x31BE135F97D08FD981231505542FCFA6,
    0x9AA508B5B7A84E1C677DE54F3E99BC9,
    0x5D6AF8DEDB81196699C329225EE604,
    0x2216E584F5FA1EA926041BEDFE98,
    0x48A170391F7DC42444E8FA2,
)


def sqrt_ratio_at_tick(tick: int) -> int:
    """Exact port of TickMath.getSqrtRatioAtTick, including Q96 round-up."""
    absolute = abs(tick)
    if absolute > 887_272:
        raise ValueError("tick out of range")
    ratio = 0xFFFcb933BD6fAD37AA2D162D1A594001 if absolute & 1 else Q128
    for bit, multiplier in enumerate(_MUL, start=1):
        if absolute & (1 << bit):
            ratio = (ratio * multiplier) >> 128
    if tick > 0:
        ratio = ((1 << 256) - 1) // ratio
    return (ratio >> 32) + (1 if ratio & ((1 << 32) - 1) else 0)


def tick_at_price_coat_per_eth(price: Decimal) -> int:
    """Binary-search the greatest tick whose exact Q96 ratio is <= price."""
    target = int(price.sqrt() * Q96)
    low, high = -887_272, 887_272
    while low < high:
        mid = (low + high + 1) // 2
        if sqrt_ratio_at_tick(mid) <= target:
            low = mid
        else:
            high = mid - 1
    return low


def floor_spacing(tick: int) -> int:
    return tick // TICK_SPACING * TICK_SPACING


def ceil_spacing(tick: int) -> int:
    return -((-tick) // TICK_SPACING) * TICK_SPACING


def ceil_div(a: int, b: int) -> int:
    return (a + b - 1) // b


def amount1_delta(sqrt_a: int, sqrt_b: int, liquidity: int) -> int:
    """SqrtPriceMath.getAmount1Delta(..., roundUp=true)."""
    return ceil_div(liquidity * (sqrt_b - sqrt_a), Q96)


def amount0_delta(sqrt_a: int, sqrt_b: int, liquidity: int) -> int:
    """SqrtPriceMath.getAmount0Delta(..., roundUp=true)."""
    numerator = liquidity << 96
    return ceil_div(ceil_div(numerator * (sqrt_b - sqrt_a), sqrt_b), sqrt_a)


def build_report() -> dict[str, int | str]:
    pool_high = Decimal(1) / PRICE_START
    pool_low = Decimal(1) / PRICE_END
    tick_lower = floor_spacing(tick_at_price_coat_per_eth(pool_low))
    # Use the lower aligned tick at the cheap boundary so buyers never receive COAT
    # below the declared ~1e-8 ETH floor merely because of tick-spacing rounding.
    tick_upper = floor_spacing(tick_at_price_coat_per_eth(pool_high))
    start_tick = tick_upper + TICK_SPACING
    sqrt_lower = sqrt_ratio_at_tick(tick_lower)
    sqrt_upper = sqrt_ratio_at_tick(tick_upper)
    sqrt_start = sqrt_ratio_at_tick(start_tick)

    # Maximum liquidity whose rounded-up token1 debit is at most the full supply.
    liquidity = SUPPLY * Q96 // (sqrt_upper - sqrt_lower)
    while amount1_delta(sqrt_lower, sqrt_upper, liquidity) > SUPPLY:
        liquidity -= 1
    deposited = amount1_delta(sqrt_lower, sqrt_upper, liquidity)
    matched_eth = amount0_delta(sqrt_lower, sqrt_upper, liquidity)

    # Sequential activation purchase model. Hook takes 1% of token output and the pool
    # takes 1% of ETH input. This is the continuous form of SwapMath inside one range;
    # deployment constants remain integer/Q96 and the fork test checks actual rounding.
    d = Decimal
    current = d(sqrt_upper)
    l_dec = d(liquidity)
    gross_coat = d(ACTIVATION_BURN) / d("0.99")
    total_activation_eth = d(0)
    first_activation_eth = d(0)
    for index in range(ACTIVATIONS):
        next_sqrt = current - gross_coat * d(Q96) / l_dec
        net_eth = l_dec * d(Q96) * (current - next_sqrt) / (current * next_sqrt)
        user_eth = net_eth / d("0.99")
        if index == 0:
            first_activation_eth = user_eth
        total_activation_eth += user_eth
        current = next_sqrt

    return {
        "fee": FEE,
        "tick_spacing": TICK_SPACING,
        "tick_lower": tick_lower,
        "tick_upper": tick_upper,
        "start_tick": start_tick,
        "sqrt_price_x96": sqrt_start,
        "sqrt_lower_x96": sqrt_lower,
        "sqrt_upper_x96": sqrt_upper,
        "liquidity": liquidity,
        "amount0_max": 0,
        "amount1_max": SUPPLY,
        "coat_deposited_wei": deposited,
        "coat_rounding_remainder_wei": SUPPLY - deposited,
        "matched_eth_at_lower_wei": matched_eth,
        "activation_burn_wei": ACTIVATION_BURN,
        "all_activation_burn_wei": ACTIVATION_BURN * ACTIVATIONS,
        "first_activation_estimated_eth": str(first_activation_eth / d(10**18)),
        "all_activations_estimated_eth": str(total_activation_eth / d(10**18)),
        "average_activation_estimated_eth": str(total_activation_eth / d(ACTIVATIONS) / d(10**18)),
        "mint_price_wei": 1_500_000_000_000_000,
        "collection_mint_revenue_wei": 1_500_000_000_000_000 * ACTIVATIONS,
        "price_start_eth_per_coat": str(PRICE_START),
        "price_end_eth_per_coat": str(PRICE_END),
        "fdv_start_eth": "10",
        "fdv_end_eth": "1000",
    }


def main() -> None:
    report = build_report()
    canonical = json.dumps(report, sort_keys=True, separators=(",", ":")).encode()
    report["parameter_sha256"] = hashlib.sha256(canonical).hexdigest()
    out = Path(__file__).with_name("launch-math.json")
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print("\n// Solidity constants")
    for key in ("fee", "tick_spacing", "tick_lower", "tick_upper", "sqrt_price_x96", "liquidity"):
        print(f"// {key.upper()} = {report[key]}")
    print(f"// AMOUNT1_MAX = {SUPPLY}")


if __name__ == "__main__":
    main()

import unittest
import base64
import json
from datetime import datetime
from unittest.mock import Mock, patch

from aggregate import parse_amount, to_basket
from health import snapshot_health
from keeper import is_poke_eligible, planned_actions
from claim_distributor import circular_ids, select_claim_batch
from renderer_uploader import decode_uri


class AggregationTests(unittest.TestCase):
    def test_amount_midpoint(self):
        self.assertEqual(parse_amount("$1,001 - $15,000"), 8000.5)

    @patch("aggregate.is_tokenized", side_effect=lambda ticker: ticker in {"TSLA", "AMZN"})
    def test_basket_is_route_ready_and_sums_to_bps(self, _):
        basket = to_basket({"TSLA": 20_000, "AMZN": 30_000, "UNKNOWN": 1_000_000})
        self.assertEqual([ticker for ticker, _ in basket], ["AMZN", "TSLA"])
        self.assertEqual(sum(weight for _, weight in basket), 10_000)

    def test_unprobed_routes_fail_closed(self):
        # NFLX is canonical but intentionally NOT route-ready (never fork-probed), so it must
        # never enter a basket. Uses a ticker outside route-ready.mainnet.json on purpose — if
        # NFLX is ever promoted, swap this for another canonical-but-unprobed ticker.
        from tokens import ADDRESS, ROUTE_READY_ADDRESS

        self.assertIn("NFLX", ADDRESS)
        self.assertNotIn("NFLX", ROUTE_READY_ADDRESS)
        self.assertEqual(to_basket({"NFLX": 30_000}), [])


class HealthTests(unittest.TestCase):
    def test_thin_single_person_feed_is_rejected(self):
        rows = [{
            "symbol": "TSLA", "who": "One Person", "transactionDate": "2026-08-10",
            "disclosureDate": "2026-08-11", "type": "Buy", "amount": "$1,001 - $15,000",
        }]
        health = snapshot_health(rows)
        self.assertFalse(health["ok"])
        self.assertEqual(health["distinctTraders"], 1)


class KeeperTests(unittest.TestCase):
    def test_eligible_at_threshold_with_active_share(self):
        self.assertTrue(is_poke_eligible(1_000, 1_000, 1))

    def test_not_eligible_below_threshold(self):
        self.assertFalse(is_poke_eligible(999, 1_000, 1))

    def test_not_eligible_without_active_brokers(self):
        self.assertFalse(is_poke_eligible(1_000, 1_000, 0))

    def test_full_fee_path_is_planned_in_order(self):
        self.assertEqual(
            planned_actions(1_250, 0, 0, 0, 1_000, 1, 0, 100),
            ["hook.flush", "splitter.flush", "booster.poke", "buyback.execute"],
        )

    def test_coat_only_hook_balance_still_flushes(self):
        self.assertEqual(
            planned_actions(0, 5, 0, 0, 1_000, 1, 0, 100),
            ["hook.flush"],
        )

    def test_random_id_claim_scan_wraps_and_batches_five(self):
        minted = {1775, 1776, 1, 2, 3, 4}
        claimable = {1775, 1776, 1, 3, 4, 99}
        batch, cursor = select_claim_batch(1775, minted.__contains__, claimable.__contains__)
        self.assertEqual(batch, [1775, 1776, 1, 3, 4])
        self.assertEqual(cursor, 5)
        self.assertEqual(list(circular_ids(1775))[:4], [1775, 1776, 1, 2])

    def test_renderer_uri_decoder_checks_random_token_identity_and_svg(self):
        svg = '<svg viewBox="0 0 40 40"></svg>'
        image = "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
        document = {
            "name": "Coattail Broker #731",
            "image": image,
            # The dynamic renderer always emits Type at index 0, then a variable set of
            # visual traits (None omitted) plus live Status/holdings.
            "attributes": [{"trait_type": "Type", "value": "Broker"}]
            + [{"trait_type": str(i), "value": "x"} for i in range(1, 7)],
        }
        uri = "data:application/json;base64," + base64.b64encode(json.dumps(document).encode()).decode()
        self.assertEqual(decode_uri(uri, 731)["name"], "Coattail Broker #731")


class UnusualWhalesTests(unittest.TestCase):
    @patch("unusual_whales.UNUSUAL_WHALES_API_KEY", "test-key")
    @patch("unusual_whales.requests.get")
    def test_normalizes_official_congress_schema(self, get):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"data": [{
            "ticker": "msft", "transaction_date": "2026-08-01",
            "filed_at_date": "2026-08-05", "txn_type": "Buy",
            "amounts": "$15,001 - $50,000", "name": "Jane Doe", "member_type": "house",
        }]}
        get.return_value = response
        from unusual_whales import fetch_congress_trades
        rows = fetch_congress_trades()
        self.assertEqual(rows[0]["symbol"], "MSFT")
        self.assertEqual(rows[0]["who"], "Jane Doe")
        self.assertEqual(rows[0]["chamber"], "house")


class ConvictionTests(unittest.TestCase):
    def _trades(self):
        recent = datetime.utcnow().date().isoformat()
        return [
            {"symbol": "AAA", "type": "Purchase", "amount": "$100,000 - $100,000", "who": "Rep A", "transactionDate": recent},
            {"symbol": "AAA", "type": "Purchase", "amount": "$100,000 - $100,000", "who": "Rep B", "transactionDate": recent},
            {"symbol": "AAA", "type": "Purchase", "amount": "$100,000 - $100,000", "who": "Rep A", "transactionDate": recent},  # dup member
            {"symbol": "BBB", "type": "Purchase", "amount": "$100,000 - $100,000", "who": "Rep C", "transactionDate": recent},
            {"symbol": "BBB", "type": "Sale",     "amount": "$100,000 - $100,000", "who": "Rep D", "transactionDate": recent},  # sells don't add conviction
        ]

    def test_buyer_counts_are_distinct_members_on_the_buy_side(self):
        from aggregate import buyer_counts
        counts = buyer_counts(self._trades())
        self.assertEqual(counts["AAA"], 2)  # A and B, dup A collapsed
        self.assertEqual(counts["BBB"], 1)  # only C bought; D's sale is ignored

    def test_conviction_multiplier_scales_and_caps(self):
        from aggregate import conviction_multiplier
        self.assertEqual(conviction_multiplier(1), 1.0)
        self.assertEqual(conviction_multiplier(2), 1.5)
        self.assertEqual(conviction_multiplier(3), 2.0)
        self.assertEqual(conviction_multiplier(100), 3.0)  # CONVICTION_MAX

    def test_breadth_outweighs_a_larger_single_buyer(self):
        # CCC has the most raw dollars, but AAA is bought by 3 members -> conviction (x2)
        # lifts it above CCC. Three names keep every weight under the 50% cap so the tilt,
        # not the ceiling, decides the ordering.
        from aggregate import to_basket
        net = {"AAA": 100_000.0, "BBB": 110_000.0, "CCC": 120_000.0}
        with patch("aggregate.is_tokenized", lambda t: True):
            plain = dict(to_basket(net))                                    # dollars only
            tilted = dict(to_basket(net, {"AAA": 3, "BBB": 1, "CCC": 1}))   # with conviction
        self.assertGreater(plain["CCC"], plain["AAA"])   # dollars: CCC leads
        self.assertGreater(tilted["AAA"], tilted["CCC"]) # conviction: AAA leads

    def test_no_buyers_map_reproduces_dollar_weighting(self):
        from aggregate import to_basket
        net = {"AAA": 100_000.0, "BBB": 50_000.0}
        with patch("aggregate.is_tokenized", lambda t: True):
            self.assertEqual(to_basket(net), to_basket(net, None))


class WeightCapTests(unittest.TestCase):
    def test_sum_is_always_bps_and_cap_is_respected(self):
        from aggregate import cap_weights
        cases = [
            ([9455, 495, 50], 4000),
            ([9455, 495, 50], 5000),
            ([1000, 900, 800, 700], 3000),
            ([100, 1, 1, 1, 1], 2500),
        ]
        for values, cap in cases:
            w = cap_weights(values, cap)
            self.assertEqual(sum(w), 10_000, (values, cap, w))
            self.assertTrue(all(x <= cap for x in w), (values, cap, w))

    def test_excess_flows_to_next_by_signal_not_evenly(self):
        # INTC dwarfs the rest; at a 50% cap it pins at 5000 and the remainder splits by
        # signal, so the second-largest gets far more than the third.
        from aggregate import cap_weights
        w = cap_weights([9455, 495, 50], 5000)
        self.assertEqual(w[0], 5000)
        self.assertGreater(w[1], w[2])
        self.assertLess(w[2], 1000)  # tiny signal stays tiny

    def test_uncapped_matches_plain_proportional(self):
        from aggregate import cap_weights
        # cap disabled (BPS) reproduces the old proportional behaviour, drift on the largest
        self.assertEqual(cap_weights([6000, 3000, 1000], 10_000), [6000, 3000, 1000])

    def test_monotonic_weights(self):
        from aggregate import cap_weights
        w = cap_weights([500, 300, 200, 100], 4000)
        self.assertEqual(w, sorted(w, reverse=True))

    def test_degenerate_inputs(self):
        from aggregate import cap_weights
        self.assertEqual(cap_weights([], 4000), [])
        self.assertEqual(cap_weights([123.0], 4000), [10_000])  # one name can't be capped below 100%
        self.assertEqual(cap_weights([100, 100], 4000), [5000, 5000])


class RoutePreflightTests(unittest.TestCase):
    def test_renormalise_restores_exact_bps_sum(self):
        from route_preflight import renormalise
        for basket in ([("A", 5000), ("B", 3000)],
                       [("A", 3333), ("B", 3333), ("C", 3334)],
                       [("A", 1)]):
            self.assertEqual(sum(w for _, w in renormalise(basket)), 10_000)
        self.assertEqual(renormalise([]), [])

    def test_renormalise_keeps_relative_weights(self):
        from route_preflight import renormalise
        self.assertEqual(renormalise([("A", 5000), ("B", 3000)]), [("A", 6250), ("B", 3750)])

    def test_preflight_drops_only_the_failing_leg(self):
        import route_preflight
        basket = [("AAPL", 6000), ("DEAD", 3000), ("MSFT", 1000)]

        def fake_simulate(w3, router, booster, stock, wei):
            return (False, 0, "execution reverted") if stock == "0xdead" else (True, 1, "")

        with patch.object(route_preflight, "simulate_leg", fake_simulate), \
             patch("tokens.address_of", lambda t: "0xdead" if t == "DEAD" else "0x" + t.lower()):
            live, dropped = route_preflight.preflight_basket(
                None, basket, "0xb00", 10**16, router_address="0xr")
        self.assertEqual([t for t, _ in live], ["AAPL", "MSFT"])
        self.assertEqual(sum(w for _, w in live), 10_000)
        self.assertEqual([(t, r) for t, _b, r in dropped], [("DEAD", "execution reverted")])

    def test_preflight_keeps_a_leg_whose_slice_rounds_to_zero(self):
        """`_poke` skips a zero slice, so it can never revert the batch — never drop it."""
        import route_preflight

        def explode(*_a, **_k):
            raise AssertionError("a zero slice must not be simulated")

        with patch.object(route_preflight, "simulate_leg", explode), \
             patch("tokens.address_of", lambda t: "0x" + t.lower()):
            live, dropped = route_preflight.preflight_basket(
                None, [("TINY", 1)], "0xb00", 100, router_address="0xr")
        self.assertEqual(live, [("TINY", 10_000)])
        self.assertEqual(dropped, [])

    def test_preflight_drops_a_ticker_with_no_onchain_address(self):
        import route_preflight
        with patch("tokens.address_of", lambda t: None if t == "NOADDR" else "0x" + t.lower()), \
             patch.object(route_preflight, "simulate_leg", lambda *a, **k: (True, 1, "")):
            live, dropped = route_preflight.preflight_basket(
                None, [("AAPL", 9000), ("NOADDR", 1000)], "0xb00", 10**16, router_address="0xr")
        self.assertEqual(live, [("AAPL", 10_000)])
        self.assertEqual([t for t, _b, _r in dropped], ["NOADDR"])


class CoverageExclusionTests(unittest.TestCase):
    def test_excluded_ticker_leaves_the_denominator_intact(self):
        from aggregate import coverage
        with patch("aggregate.is_tokenized", lambda t: t in {"AAPL", "DEAD"}):
            net = {"AAPL": 60.0, "DEAD": 20.0, "XYZ": 20.0}
            self.assertAlmostEqual(coverage(net), 0.8)
            self.assertAlmostEqual(coverage(net, exclude=["DEAD"]), 0.6)


if __name__ == "__main__":
    unittest.main()

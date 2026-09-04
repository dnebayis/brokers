import unittest
import base64
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from unittest.mock import Mock, patch

from aggregate import parse_amount, to_basket
from health import snapshot_health
from keeper import gift_plan, is_poke_eligible, planned_actions
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


class UnusualWhalesRetryTests(unittest.TestCase):
    def _resp(self, status):
        r = Mock()
        r.status_code = status
        r.reason = "x"
        r.url = "u"
        r.raise_for_status.return_value = None
        return r

    @patch("unusual_whales.time.sleep", lambda *_: None)
    @patch("unusual_whales.requests.get")
    def test_transient_503_is_retried_then_succeeds(self, get):
        from unusual_whales import _get_with_retry
        ok = self._resp(200)
        get.side_effect = [self._resp(503), self._resp(503), ok]
        self.assertIs(_get_with_retry("u", {}, {}), ok)
        self.assertEqual(get.call_count, 3)

    @patch("unusual_whales.requests.get")
    def test_a_real_4xx_is_never_retried(self, get):
        import requests as req
        from unusual_whales import _get_with_retry
        bad = self._resp(401)
        bad.raise_for_status.side_effect = req.exceptions.HTTPError("401", response=bad)
        get.return_value = bad
        with self.assertRaises(req.exceptions.HTTPError):
            _get_with_retry("u", {}, {})
        self.assertEqual(get.call_count, 1)

    @patch("unusual_whales.time.sleep", lambda *_: None)
    @patch("unusual_whales.requests.get")
    def test_exhausted_retries_raise_a_clear_error(self, get):
        from unusual_whales import _get_with_retry
        get.side_effect = [self._resp(503)] * 4
        with self.assertRaises(RuntimeError):
            _get_with_retry("u", {}, {})


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
             patch.object(route_preflight, "feed_guard", lambda *a, **k: (0, "")), \
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
             patch.object(route_preflight, "feed_guard", lambda *a, **k: (0, "")), \
             patch("tokens.address_of", lambda t: "0x" + t.lower()):
            live, dropped = route_preflight.preflight_basket(
                None, [("TINY", 1)], "0xb00", 100, router_address="0xr")
        self.assertEqual(live, [("TINY", 10_000)])
        self.assertEqual(dropped, [])

    def test_preflight_drops_a_leg_whose_feed_guard_reverts_or_is_not_cleared(self):
        """A stale Chainlink feed reverts minOut on chain and would revert the whole poke;
        a route that fills below the guard reverts the same way. Both are caught here."""
        import route_preflight
        basket = [("AAPL", 5000), ("STALE", 3000), ("THIN", 2000)]

        def fake_simulate(w3, router, booster, stock, wei):
            return (True, 100, "")

        def fake_guard(w3, booster, stock, wei):
            if stock == "0xstale":
                return None, "feed guard reverts: BadFeed()"
            if stock == "0xthin":
                return 150, ""       # route gives 100, guard demands 150
            return 90, ""
        with patch.object(route_preflight, "simulate_leg", fake_simulate), \
             patch.object(route_preflight, "feed_guard", fake_guard), \
             patch("tokens.address_of", lambda t: "0x" + t.lower()):
            live, dropped = route_preflight.preflight_basket(None, basket, "0xb00", 10**16, router_address="0xr")
        self.assertEqual(live, [("AAPL", 10_000)])
        reasons = {t: r for t, _b, r in dropped}
        self.assertIn("BadFeed", reasons["STALE"])
        self.assertIn("below the Chainlink guard", reasons["THIN"])

    def test_feed_guard_classifies_revert_vs_transport(self):
        import route_preflight
        from web3.exceptions import ContractLogicError
        w3 = Mock()
        fn = w3.eth.contract.return_value.functions.minOut
        fn.return_value.call.side_effect = ContractLogicError("execution reverted: BadFeed()")
        with patch.object(route_preflight, "PROBE_ATTEMPTS", 1):
            min_out, reason = route_preflight.feed_guard(w3, "0x" + "b0" * 20, "0x" + "aa" * 20, 10**15)
        self.assertIsNone(min_out); self.assertIn("BadFeed", reason)
        fn.return_value.call.side_effect = None; fn.return_value.call.return_value = 4242
        self.assertEqual(route_preflight.feed_guard(w3, "0x" + "b0" * 20, "0x" + "aa" * 20, 10**15), (4242, ""))
        fn.return_value.call.side_effect = TimeoutError("read timed out")
        with patch.object(route_preflight, "PROBE_ATTEMPTS", 1), patch("time.sleep", lambda s: None):
            with self.assertRaises(route_preflight.RouteProbeUnavailable):
                route_preflight.feed_guard(w3, "0x" + "b0" * 20, "0x" + "aa" * 20, 10**15)

    def test_preflight_drops_a_ticker_with_no_onchain_address(self):
        import route_preflight
        with patch("tokens.address_of", lambda t: None if t == "NOADDR" else "0x" + t.lower()), \
             patch.object(route_preflight, "simulate_leg", lambda *a, **k: (True, 1, "")), \
             patch.object(route_preflight, "feed_guard", lambda *a, **k: (0, "")):
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


class SmartLayerTests(unittest.TestCase):
    """Decay + fast-filer + sell-veto (shadow-first smart layer)."""

    NOW = datetime(2026, 8, 22)

    def _row(self, sym="TSLA", ttype="Buy", amount="$10,000 - $10,000",
             transacted="2026-08-20", disclosed="2026-08-21", who="A Member"):
        return {"symbol": sym, "type": ttype, "amount": amount,
                "transactionDate": transacted, "disclosureDate": disclosed, "who": who}

    def test_decay_halves_at_half_life(self):
        from aggregate import smart_row_multiplier
        with patch("aggregate.DECAY_HALF_LIFE_DAYS", 14.0), patch("aggregate.FAST_FILER_BONUS", 0.0):
            fresh = smart_row_multiplier(self._row(disclosed="2026-08-22", transacted="2026-08-22"), self.NOW)
            aged = smart_row_multiplier(self._row(disclosed="2026-08-08", transacted="2026-08-08"), self.NOW)
        self.assertAlmostEqual(fresh, 1.0)
        self.assertAlmostEqual(aged, 0.5)

    def test_fast_filer_bonus_fades_to_zero(self):
        from aggregate import smart_row_multiplier
        with patch("aggregate.DECAY_HALF_LIFE_DAYS", 0.0), \
             patch("aggregate.FAST_FILER_BONUS", 0.25), patch("aggregate.FAST_FILER_DAYS", 14.0):
            same_day = smart_row_multiplier(
                self._row(transacted="2026-08-22", disclosed="2026-08-22"), self.NOW)
            slow = smart_row_multiplier(
                self._row(transacted="2026-07-01", disclosed="2026-08-14"), self.NOW)
        self.assertAlmostEqual(same_day, 1.25)
        self.assertAlmostEqual(slow, 1.0)

    def test_undated_rows_keep_unit_weight(self):
        from aggregate import smart_row_multiplier
        with patch("aggregate.DECAY_HALF_LIFE_DAYS", 14.0), patch("aggregate.FAST_FILER_BONUS", 0.25):
            w = smart_row_multiplier(
                self._row(transacted="not-a-date", disclosed=""), self.NOW)
        self.assertAlmostEqual(w, 1.0)

    def test_sell_veto_triggers_at_ratio(self):
        from aggregate import smart_aggregate
        trades = [
            self._row(sym="INTC", ttype="Buy", amount="$10,000 - $10,000"),
            self._row(sym="INTC", ttype="Sale", amount="$10,000 - $10,000", who="B Member"),
            self._row(sym="NVDA", ttype="Buy", amount="$10,000 - $10,000"),
            self._row(sym="NVDA", ttype="Sale", amount="$4,000 - $4,000", who="B Member"),
        ]
        with patch("aggregate.DECAY_HALF_LIFE_DAYS", 0.0), \
             patch("aggregate.FAST_FILER_BONUS", 0.0), patch("aggregate.SELL_VETO_RATIO", 1.0):
            _net, vetoed = smart_aggregate(trades, now=self.NOW)
        self.assertIn("INTC", vetoed)
        self.assertNotIn("NVDA", vetoed)

    def test_knobs_off_matches_legacy_aggregate(self):
        from aggregate import aggregate, smart_aggregate
        trades = [
            self._row(sym="TSLA", ttype="Buy", amount="$1,001 - $15,000"),
            self._row(sym="TSLA", ttype="Sale", amount="$1,001 - $15,000", who="B Member"),
            self._row(sym="AMZN", ttype="Buy", amount="$50,000 - $100,000"),
        ]
        with patch("aggregate.DECAY_HALF_LIFE_DAYS", 0.0), \
             patch("aggregate.FAST_FILER_BONUS", 0.0), patch("aggregate.SELL_VETO_RATIO", 0.0), \
             patch("aggregate._TRACK_CACHE", {}):
            smart_net, vetoed = smart_aggregate(trades, now=self.NOW)
        legacy = aggregate(trades)
        self.assertEqual(vetoed, set())
        for sym, value in legacy.items():
            self.assertAlmostEqual(smart_net[sym], value)


class TrackRecordTests(unittest.TestCase):
    """Member track-record multipliers (smart-basket layer 2)."""

    NOW = datetime(2026, 8, 22)

    def _row(self, sym="TSLA", ttype="Buy", who="A Member"):
        return {"symbol": sym, "type": ttype, "amount": "$10,000 - $10,000",
                "transactionDate": "2026-08-22", "disclosureDate": "2026-08-22", "who": who}

    def _smart(self, trades, cache):
        from aggregate import smart_aggregate
        with patch("aggregate.DECAY_HALF_LIFE_DAYS", 0.0), \
             patch("aggregate.FAST_FILER_BONUS", 0.0), patch("aggregate.SELL_VETO_RATIO", 0.0), \
             patch("aggregate._TRACK_CACHE", cache):
            return smart_aggregate(trades, now=self.NOW)

    def test_scored_member_buys_are_scaled(self):
        net, _ = self._smart([self._row(who="Good Trader")], {"good trader": 1.4})
        self.assertAlmostEqual(net["TSLA"], 10_000 * 1.4)

    def test_unknown_member_defaults_to_one(self):
        net, _ = self._smart([self._row(who="Nobody Scored")], {"good trader": 1.4})
        self.assertAlmostEqual(net["TSLA"], 10_000)

    def test_sells_are_never_scaled(self):
        net, _ = self._smart(
            [self._row(who="Good Trader"), self._row(ttype="Sale", who="Good Trader")],
            {"good trader": 1.4})
        # buy scaled x1.4, sell subtracted unscaled: 14,000 - 10,000
        self.assertAlmostEqual(net["TSLA"], 4_000)

    def test_score_math_shrinks_and_clamps(self):
        import track_record
        # 5 trades at +20% excess, shrink k=10 -> 20 * 5/15 = 6.67% -> mult 1 + 0.05*6.67
        shrunk = 0.20 * 5 / (5 + track_record.SHRINK_K) * 100
        mult = max(track_record.TRACK_MIN,
                   min(track_record.TRACK_MAX, 1.0 + track_record.TRACK_COEFF * shrunk))
        self.assertAlmostEqual(shrunk, 6.6667, places=3)
        self.assertAlmostEqual(mult, 1.3333, places=3)
        # a catastrophic member clamps at the floor, a stellar one at the ceiling
        self.assertEqual(max(track_record.TRACK_MIN,
                             min(track_record.TRACK_MAX, 1.0 + track_record.TRACK_COEFF * -50)),
                         track_record.TRACK_MIN)
        self.assertEqual(max(track_record.TRACK_MIN,
                             min(track_record.TRACK_MAX, 1.0 + track_record.TRACK_COEFF * 50)),
                         track_record.TRACK_MAX)

    def test_window_return_needs_complete_window(self):
        from track_record import _window_return
        closes = {"2026-07-01": 100.0, "2026-07-31": 110.0}
        self.assertAlmostEqual(_window_return(closes, "2026-07-01"), 0.10)
        # disclosure too recent: no close >= horizon end -> refuse to score
        self.assertIsNone(_window_return({"2026-08-20": 100.0, "2026-08-21": 101.0}, "2026-08-20"))
        # no close within 7 days after disclosure -> refuse
        self.assertIsNone(_window_return(closes, "2026-06-01"))


class OpsAlertTests(unittest.TestCase):
    """The alert channel is the only path that reaches a human, so its own behaviour
    (no-op without a URL, retry once, never raise) has to be pinned down."""

    def test_no_webhook_is_a_silent_noop(self):
        import ops_alerts
        with patch.dict("os.environ", {"OPS_WEBHOOK_URL": ""}), \
                patch("urllib.request.urlopen") as urlopen:
            self.assertFalse(ops_alerts.alert("hi"))
            urlopen.assert_not_called()

    def test_sends_with_browser_user_agent_and_truncates(self):
        import ops_alerts
        with patch.dict("os.environ", {"OPS_WEBHOOK_URL": "https://discord.test/hook"}), \
                patch("urllib.request.urlopen") as urlopen:
            self.assertTrue(ops_alerts.alert("x" * 3000))
            req = urlopen.call_args[0][0]
            self.assertEqual(req.get_header("User-agent"), "Mozilla/5.0")
            self.assertEqual(len(json.loads(req.data)["content"]), 1900)

    def test_transient_failure_is_retried_once_then_reported_not_raised(self):
        import ops_alerts
        with patch.dict("os.environ", {"OPS_WEBHOOK_URL": "https://discord.test/hook"}), \
                patch("urllib.request.urlopen", side_effect=[OSError("429"), Mock()]) as urlopen, \
                patch("ops_alerts.time.sleep") as sleep:
            self.assertTrue(ops_alerts.alert("hi"))
            self.assertEqual(urlopen.call_count, 2)
            sleep.assert_called_once()
        with patch.dict("os.environ", {"OPS_WEBHOOK_URL": "https://discord.test/hook"}), \
                patch("urllib.request.urlopen", side_effect=OSError("down")), \
                patch("ops_alerts.time.sleep"):
            self.assertFalse(ops_alerts.alert("hi"))


class ShadowHistoryTests(unittest.TestCase):
    def test_live_column_stays_the_conviction_basket_after_the_flip(self):
        from run import shadow_history_row
        smart = [("INTC", 10000)]
        conviction = [("INTC", 5000), ("SPCX", 5000)]
        row = json.loads(shadow_history_row(5000, smart, conviction, {"AAPL"}, "live",
                                            now=datetime(2026, 9, 1, 12, 0, 0)))
        self.assertEqual(row["live"], [{"ticker": "INTC", "bps": 5000}, {"ticker": "SPCX", "bps": 5000}])
        self.assertEqual(row["shadow"], [{"ticker": "INTC", "bps": 10000}])
        self.assertEqual(row["posted"], "smart")
        self.assertEqual(row["vetoed"], ["AAPL"])
        shadow_row = json.loads(shadow_history_row(5000, smart, conviction, set(), "shadow"))
        self.assertEqual(shadow_row["posted"], "conviction")


class RetryDelayTests(unittest.TestCase):
    def test_retry_after_header_wins_over_exponential_backoff(self):
        from unusual_whales import _retry_delay
        resp = Mock(headers={"Retry-After": "45"})
        exc = Exception(); exc.response = resp
        self.assertEqual(_retry_delay(exc, 0), 45.0)
        resp.headers = {"Retry-After": "garbage"}
        self.assertEqual(_retry_delay(exc, 2), 4.0)
        self.assertEqual(_retry_delay(Exception(), 3), 8.0)


class RouteProbeClassificationTests(unittest.TestCase):
    """A revert drops the leg; an RPC fault must never masquerade as one."""

    def _w3(self, side_effect):
        w3 = Mock()
        call = Mock(side_effect=side_effect)
        fn = Mock(return_value=Mock(call=call))
        w3.eth.contract.return_value = Mock(functions=Mock(swapExactETHForStock=fn))
        return w3, call

    ADDR = "0x" + "11" * 20

    @patch("route_preflight.time.sleep", lambda *_: None)
    def test_a_revert_drops_the_leg(self):
        from web3.exceptions import ContractLogicError
        from route_preflight import simulate_leg
        w3, call = self._w3(ContractLogicError("execution reverted: STF"))
        ok, out, reason = simulate_leg(w3, self.ADDR, self.ADDR, self.ADDR, 10**15)
        self.assertFalse(ok)
        self.assertIn("reverted", reason)
        self.assertEqual(call.call_count, 1)

    @patch("route_preflight.time.sleep", lambda *_: None)
    def test_a_transient_rpc_fault_is_retried_then_succeeds(self):
        import requests
        from route_preflight import simulate_leg
        w3, call = self._w3([requests.exceptions.ConnectionError("reset by peer"),
                             ValueError("429 Too Many Requests"), 5])
        ok, out, _ = simulate_leg(w3, self.ADDR, self.ADDR, self.ADDR, 10**15)
        self.assertTrue(ok)
        self.assertEqual(out, 5)
        self.assertEqual(call.call_count, 3)

    @patch("route_preflight.time.sleep", lambda *_: None)
    def test_a_persistent_rpc_fault_raises_instead_of_dropping(self):
        from route_preflight import RouteProbeUnavailable, preflight_basket, simulate_leg
        w3, _ = self._w3(TimeoutError("read timed out"))
        with self.assertRaises(RouteProbeUnavailable):
            simulate_leg(w3, self.ADDR, self.ADDR, self.ADDR, 10**15)
        with patch("tokens.address_of", return_value=self.ADDR), \
                self.assertRaises(RouteProbeUnavailable):
            preflight_basket(w3, [("INTC", 10000)], self.ADDR, 10**16, router_address=self.ADDR)

    def test_an_unknown_failure_is_not_a_drop(self):
        from route_preflight import RouteProbeUnavailable, simulate_leg
        w3, _ = self._w3(KeyError("weird"))
        with self.assertRaises(RouteProbeUnavailable):
            simulate_leg(w3, self.ADDR, self.ADDR, self.ADDR, 10**15)


class CoatBonusAllocationTests(unittest.TestCase):
    """Active Brokers get double shares into their own wallets; inactive ones get a single
    share into the owner's wallet; every wei is assigned."""

    def test_two_to_one_weighting_and_destinations(self):
        from coat_bonus_snapshot import allocate
        entries = [
            (1, True, "0xOwnerA", "0xWallet1"),
            (2, False, "0xOwnerA", "0xWallet2"),
            (3, False, "0xOwnerB", "0xWallet3"),
        ]
        rows, per_share = allocate(entries, 4_000, active_weight=2, inactive_weight=1)
        self.assertEqual(per_share, 1_000)
        self.assertEqual(rows["0xWallet1"], 2_000)   # active -> its 6551 wallet, 2 shares
        self.assertEqual(rows["0xOwnerA"], 1_000)    # inactive -> owner wallet, 1 share
        self.assertEqual(rows["0xOwnerB"], 1_000)
        self.assertNotIn("0xWallet2", rows)
        self.assertEqual(sum(rows.values()), 4_000)

    def test_remainder_goes_to_first_recipient_and_sum_is_exact(self):
        from coat_bonus_snapshot import allocate
        entries = [(1, True, "0xA", "0xW1"), (2, False, "0xB", "0xW2")]
        rows, per_share = allocate(entries, 1_000, 2, 1)
        self.assertEqual(per_share, 333)
        self.assertEqual(sum(rows.values()), 1_000)
        self.assertEqual(rows["0xW1"], 666 + 1)

    def test_zero_inactive_weight_excludes_inactive(self):
        from coat_bonus_snapshot import allocate
        rows, _ = allocate([(1, True, "0xA", "0xW1"), (2, False, "0xB", "0xW2")], 100, 1, 0)
        self.assertEqual(rows, {"0xW1": 100})

    def test_inactive_only_tranche_lands_in_the_brokers_own_wallets(self):
        """Tranche 2: every wei of the sender's balance to the inactive Brokers' 6551 wallets."""
        from coat_bonus_snapshot import allocate
        entries = [(1, True, "0xOwnerA", "0xW1"), (2, False, "0xOwnerA", "0xW2"), (3, False, "0xOwnerB", "0xW3")]
        total = 14_214_816_270_000_000_000_000_001  # an odd wei count, not divisible by 2
        rows, per_share = allocate(entries, total, active_weight=0, inactive_weight=1, inactive_to="wallet")
        self.assertEqual(set(rows), {"0xW2", "0xW3"})           # no active wallet, no owner EOA
        self.assertEqual(sum(rows.values()), total)               # exact, remainder included
        self.assertEqual(rows["0xW2"], per_share + 1)
        self.assertEqual(rows["0xW3"], per_share)
        with self.assertRaises(ValueError):
            allocate(entries, total, 0, 1, inactive_to="eoa")

    def test_csv_amounts_are_exact_wei(self):
        from decimal import Decimal
        from coat_bonus_snapshot import coat_str, WEI
        for wei in (0, 1, WEI, 25196353702188192983158, 14286332549140704644429547 // 567 + 1):
            self.assertEqual(int(Decimal(coat_str(wei)) * WEI), wei)
        self.assertEqual(coat_str(WEI), "1")
        self.assertEqual(coat_str(1), "0.000000000000000001")


class SendSignedTests(unittest.TestCase):
    """send_signed never broadcasts the same action twice: a send error whose transaction was in
    fact accepted is recognised by its pre-computed hash; only a truly absent tx bumps the nonce.
    A poke that reverted BelowThreshold lost a race, it is not a deferral."""

    def _rig(self, send_side_effects, found_after_error):
        from hexbytes import HexBytes
        w3 = Mock()
        w3.eth.get_transaction_count.side_effect = lambda addr, tag: {"pending": 10, "latest": 10}[tag]
        w3.eth.send_raw_transaction.side_effect = send_side_effects
        w3.eth.get_transaction.side_effect = found_after_error
        account = Mock(); account.address = "0x" + "aa" * 20
        signed_hashes = []
        def sign(tx):
            signed = Mock()
            signed.raw_transaction = b"raw%d" % tx["nonce"]
            signed.hash = HexBytes(bytes([tx["nonce"]]) * 32)
            signed_hashes.append(signed.hash)
            return signed
        account.sign_transaction.side_effect = sign
        call = Mock(); call.build_transaction.side_effect = lambda params: dict(params)
        return w3, account, call, signed_hashes

    def test_error_after_accepted_send_returns_the_original_hash_and_sends_once(self):
        from keeper import send_signed
        w3, account, call, hashes = self._rig([Exception("nonce too low")], lambda h: {"hash": h})
        h = send_signed(w3, account, call, 300_000, "booster.poke", 4663, sleep=lambda s: None)
        self.assertEqual(h, hashes[0])
        self.assertEqual(w3.eth.send_raw_transaction.call_count, 1)   # no duplicate poke

    def test_truly_absent_tx_bumps_the_nonce_once(self):
        from hexbytes import HexBytes
        from keeper import send_signed
        w3, account, call, hashes = self._rig([Exception("nonce too low"), HexBytes(b"\x01" * 32)], lambda h: None)
        h = send_signed(w3, account, call, 300_000, "hook.flush", 4663, sleep=lambda s: None)
        self.assertEqual(w3.eth.send_raw_transaction.call_count, 2)
        nonces = [c.args[0]["nonce"] for c in account.sign_transaction.call_args_list]
        self.assertEqual(nonces, [10, 11])
        self.assertEqual(h, HexBytes(b"\x01" * 32))

    def test_non_nonce_error_with_absent_tx_raises(self):
        from keeper import send_signed
        w3, account, call, _ = self._rig([Exception("insufficient funds")], lambda h: None)
        with self.assertRaises(Exception):
            send_signed(w3, account, call, 300_000, "hook.flush", 4663, sleep=lambda s: None)
        self.assertEqual(w3.eth.send_raw_transaction.call_count, 1)

    def test_below_threshold_is_recognised_by_selector_or_name(self):
        from keeper import is_below_threshold, simulate_reason
        self.assertTrue(is_below_threshold('execution reverted, data: "0x8b05c8140000...0001"'))
        self.assertTrue(is_below_threshold("BelowThreshold(1, 10000000000000000)"))
        self.assertFalse(is_below_threshold("BadFeed()"))
        ok = Mock(); ok.call.return_value = b""
        self.assertEqual(simulate_reason(ok, "0x1"), "")
        bad = Mock(); bad.call.side_effect = Exception("execution reverted: 0x8b05c814")
        self.assertIn("0x8b05c814", simulate_reason(bad, "0x1"))


class IndexerMainPreflightTests(unittest.TestCase):
    """main() must survive the on-chain pre-flight block, which `--sample` runs skip. The
    2026-09-03 typo str(poke_threshold, filed_window=...) crashed every mainnet pass while
    CI stayed green, because nothing exercised this branch."""

    def test_main_runs_the_preflight_branch_and_passes_the_threshold_as_buffer(self):
        import run, config
        out = os.path.join(tempfile.mkdtemp(), "basket.json")
        real_load = run._load_trades
        seen = {}
        def fake_preflight(w3, basket, booster, buffer_wei, router_address=None):
            seen["buffer"] = buffer_wei; seen["router"] = router_address
            return basket, []
        w3 = Mock(); w3.eth.block_number = 1; w3.eth.chain_id = 4663
        with patch.object(sys, "argv", ["run.py", "--out", out]), \
             patch.object(run, "_load_trades", lambda sample: real_load(True)), \
             patch.object(run, "preflight_enabled", lambda: True), \
             patch.object(run, "BOOSTER_ADDRESS", "0x" + "11" * 20), \
             patch.object(config, "make_web3", lambda: w3), \
             patch.object(run, "resolve_booster_context", lambda w3, b: ("0x" + "22" * 20, 10**16)), \
             patch.object(run, "preflight_basket", fake_preflight), \
             patch.dict(os.environ):
            os.environ.pop("ROUTE_PREFLIGHT_BUFFER_WEI", None)
            run.main()
        self.assertEqual(seen["buffer"], 10**16)             # the poke threshold, as a plain int
        self.assertEqual(seen["router"], "0x" + "22" * 20)
        payload = json.load(open(out))
        self.assertIn("filedWindowShadow", payload)
        self.assertTrue(payload["tickers"])


class RedactTests(unittest.TestCase):
    def test_rpc_path_and_full_url_are_masked(self):
        import importlib, config
        with patch.dict(os.environ, {"RH_RPC_URL": "https://x.g.alchemy.com/v2/AbCdEfGh1234567890xyzXYZ", "GEMINI_API_KEY": "gm-secret-12345"}):
            importlib.reload(config)
            out = config.redact("Max retries exceeded with url: /v2/AbCdEfGh1234567890xyzXYZ; key gm-secret-12345; "
                                "https://x.g.alchemy.com/v2/AbCdEfGh1234567890xyzXYZ")
        importlib.reload(config)
        self.assertNotIn("AbCdEfGh", out)
        self.assertNotIn("gm-secret", out)
        self.assertIn("<rpc", out)


class FeedDirectoryTests(unittest.TestCase):
    DIR = [{"name": "Robinhood SGOV-USD", "proxyAddress": "0x" + "a1" * 20},
           {"name": "Robinhood BE-USD", "proxyAddress": "0x" + "b2" * 20},
           {"name": "ETH / USD", "proxyAddress": "0x" + "c3" * 20},
           {"name": "Robinhood BRK.B-USD", "proxyAddress": None, "contractAddress": "0x" + "d4" * 20}]

    def test_matches_only_wanted_robinhood_feeds(self):
        from feed_directory import match_feeds
        found = match_feeds(self.DIR, ["BE", "FWONK", "brk.b"])
        self.assertEqual(found, {"BE": "0x" + "b2" * 20, "brk.b": "0x" + "d4" * 20})
        self.assertEqual(match_feeds({"feeds": self.DIR}, ["SGOV"]), {"SGOV": "0x" + "a1" * 20})

    def test_directory_failure_is_silent(self):
        from feed_directory import newly_listed
        def boom(): raise TimeoutError("slow")
        self.assertEqual(newly_listed(["BE"], fetch=boom), {})
        self.assertEqual(newly_listed([], fetch=boom), {})
        self.assertEqual(newly_listed(["BE"], fetch=lambda: self.DIR), {"BE": "0x" + "b2" * 20})


class ShadowMergeTests(unittest.TestCase):
    def test_union_keeps_every_hour_and_prefers_the_local_row_on_ties(self):
        from shadow_merge import merge, parse, dump
        published = parse('{"at":"2026-08-24T11:00:00+00:00","posted":"conviction"}\n{"at":"2026-09-01T00:00:00+00:00","posted":"conviction"}\n')
        local = parse('{"at":"2026-09-01T00:00:00+00:00","posted":"conviction","filedWindow":null}\nnot json\n{"at":"2026-09-03T21:00:00+00:00"}\n')
        merged = merge(published, local)
        self.assertEqual([r["at"] for r in merged], ["2026-08-24T11:00:00+00:00", "2026-09-01T00:00:00+00:00", "2026-09-03T21:00:00+00:00"])
        self.assertIn("filedWindow", merged[1])                       # local wins the tie
        self.assertEqual(len(parse(dump(merged))), 3)                # round-trips
        self.assertEqual(merge([], []), [])


class SkipDoesNotOverwriteBasketTests(unittest.TestCase):
    """A pre-flight RPC blip used to write {"skipped": ...} to --out, which the workflow
    publishes: the site then served a basket with no tickers, attribution or note for an
    hour. The stub goes to a sibling file and --out keeps the last good pass."""

    def test_out_keeps_the_previous_basket_and_the_skip_is_recorded_beside_it(self):
        import run, config
        from route_preflight import RouteProbeUnavailable
        out = os.path.join(tempfile.mkdtemp(), "basket.json")
        with open(out, "w") as fh:
            json.dump({"generatedAt": "previous-pass", "tickers": [{"ticker": "INTC"}]}, fh)
        real_load = run._load_trades
        w3 = Mock(); w3.eth.block_number = 1
        with patch.object(sys, "argv", ["run.py", "--out", out]), \
             patch.object(run, "_load_trades", lambda sample: real_load(True)), \
             patch.object(run, "preflight_enabled", lambda: True), \
             patch.object(run, "BOOSTER_ADDRESS", "0x" + "11" * 20), \
             patch.object(config, "make_web3", lambda: w3), \
             patch.object(run, "resolve_booster_context", lambda w3, b: ("0x" + "22" * 20, 10**16)), \
             patch.object(run, "preflight_basket", Mock(side_effect=RouteProbeUnavailable("rpc down"))), \
             patch("ops_alerts.alert", lambda m: True):
            run.main()
        self.assertEqual(json.load(open(out))["generatedAt"], "previous-pass")
        self.assertEqual(json.load(open(out + ".skipped.json"))["skipped"], "route pre-flight unavailable")


class SnapshotBlockPinTests(unittest.TestCase):
    """The report says "at block N", so every read must be at block N: an activation during
    the read otherwise produced a snapshot matching no block at all."""

    def test_every_multicall_and_direct_read_is_pinned_to_the_block(self):
        import coat_bonus_snapshot as cbs
        seen = []
        broker = Mock(); booster = Mock()
        broker.functions.totalMinted.return_value.call.side_effect = lambda **kw: (seen.append(("totalMinted", kw.get("block_identifier"))), 2)[1]
        broker.functions.MAX_SUPPLY.return_value.call.side_effect = lambda **kw: (seen.append(("MAX_SUPPLY", kw.get("block_identifier"))), 2)[1]
        def mc(w3, calls, chunk=150, block=None):
            fn = calls[0][1]
            seen.append((fn, block))
            if fn == "ownerOf": return ["0x" + "11" * 20, "0x" + "11" * 20]
            if fn == "accountOf": return ["0x" + "22" * 20, "0x" + "33" * 20]
            return [True, False]
        w3 = Mock()
        w3.eth.contract.side_effect = [broker, booster]
        with patch("keeper._mc_call", mc), patch("web3.Web3.to_checksum_address", lambda a: a):
            entries = cbs.read_collection(w3, "0x" + "bb" * 20, "0x" + "cc" * 20, block=53_682_930)
        self.assertEqual(len(entries), 2)
        self.assertTrue(all(b == 53_682_930 for _, b in seen), seen)


class UnusualWhalesDedupeTests(unittest.TestCase):
    """A member filing the same ticker, day and range for two accounts (their own and a
    spouse's) is two disclosures, not one; collapsing them halved those dollars. A page that
    repeats an earlier page is still an artifact and must collapse."""

    ROW = {"ticker": "MU", "transaction_date": "2026-08-01", "filed_at_date": "2026-08-05",
           "txn_type": "Buy", "amounts": "$15,001 - $50,000", "name": "Jane Doe", "member_type": "house"}

    def _pages(self, *pages):
        responses = []
        for page in pages:
            r = Mock(); r.raise_for_status.return_value = None
            r.json.return_value = {"data": page}
            responses.append(r)
        r = Mock(); r.raise_for_status.return_value = None
        r.json.return_value = {"data": []}
        responses.append(r)
        return responses

    @patch("unusual_whales.UNUSUAL_WHALES_API_KEY", "test-key")
    @patch("unusual_whales.requests.get")
    def test_two_identical_rows_in_one_page_are_both_kept(self, get):
        from unusual_whales import fetch_congress_trades
        get.side_effect = self._pages([dict(self.ROW), dict(self.ROW)])
        rows = fetch_congress_trades()
        self.assertEqual(len(rows), 2)

    @patch("unusual_whales.UNUSUAL_WHALES_API_KEY", "test-key")
    @patch("unusual_whales.requests.get")
    def test_a_row_resent_on_a_later_page_is_collapsed(self, get):
        from unusual_whales import fetch_congress_trades
        # A full page (the walk continues only past a full one), its last row being ours;
        # page 2 leads with a different row (so the page-signature guard does not fire) and
        # re-sends that same row: the copy is a pagination artifact, not a second filing.
        page1 = [dict(self.ROW, ticker=f"T{i}") for i in range(499)] + [dict(self.ROW)]
        page2 = [dict(self.ROW, ticker="INTC"), dict(self.ROW)]
        get.side_effect = self._pages(page1, page2)
        rows = fetch_congress_trades()
        self.assertEqual(sum(1 for r in rows if r["symbol"] == "MU"), 1)
        self.assertEqual(sum(1 for r in rows if r["symbol"] == "INTC"), 1)

    @patch("unusual_whales.UNUSUAL_WHALES_API_KEY", "test-key")
    @patch("unusual_whales.requests.get")
    def test_an_owner_field_separates_rows_on_its_own(self, get):
        from unusual_whales import fetch_congress_trades
        get.side_effect = self._pages([dict(self.ROW, owner="self"), dict(self.ROW, owner="spouse")])
        self.assertEqual(len(fetch_congress_trades()), 2)


class PlaybookWorthTests(unittest.TestCase):
    """The run threshold counts wallet stock AND what the Booster still owes (claimable);
    an unpriceable leg still poisons the whole valuation."""

    def _ctx(self):
        stock = Mock(); stock.address = "0x" + "aa" * 20
        return {"w3": Mock(), "brokers": Mock(), "floor": Mock(), "booster": Mock(), "stocks": [stock]}

    def test_claimable_counts_toward_worth(self):
        from keeper import _holdings_floor_usdg_many
        tba = "0x" + "bb" * 20
        calls = []
        def mc(w3, reqs, chunk=150):
            calls.append([r[1] for r in reqs])
            fn = reqs[0][1] if reqs else None
            if fn == "accountOf": return [tba]
            if fn == "balanceOf": return [10**18]                       # 1 share in the wallet
            if fn == "claimable": return [(["0x" + "aa" * 20], [2 * 10**18])]  # 2 shares owed
            if fn == "minUsdgOut": return [3_000_000] * len(reqs)          # $3 per leg
            return [None] * len(reqs)
        with patch("keeper._mc_call", side_effect=mc):
            worth = _holdings_floor_usdg_many(self._ctx(), [7])
        self.assertEqual(worth, {7: 6_000_000})  # wallet leg + claimable leg
        self.assertIn(["claimable"], calls)

    def test_an_unpriceable_leg_poisons_the_valuation(self):
        from keeper import _holdings_floor_usdg_many
        def mc(w3, reqs, chunk=150):
            fn = reqs[0][1] if reqs else None
            if fn == "accountOf": return ["0x" + "bb" * 20]
            if fn == "balanceOf": return [10**18]
            if fn == "claimable": return [([], [])]
            if fn == "minUsdgOut": return [None]
            return [None] * len(reqs)
        with patch("keeper._mc_call", side_effect=mc):
            self.assertEqual(_holdings_floor_usdg_many(self._ctx(), [7]), {7: None})


class PlaybookBatchSizingTests(unittest.TestCase):
    """An unaffordable batch shrinks to what the relay can carry instead of deferring whole."""

    def test_shrinks_by_have_want_ratio_with_margin(self):
        from keeper import _shrink_batch
        self.assertEqual(_shrink_batch(50, have=27_000, want=32_000), 35)   # 50*0.84*0.85
        self.assertEqual(_shrink_batch(50, have=100, want=32_000), 5)        # floor
        self.assertEqual(_shrink_batch(50, have=40_000, want=32_000), 50)    # affordable as-is
        self.assertEqual(_shrink_batch(5, have=1, want=1000), 5)             # never below floor

    def test_parses_the_node_message(self):
        from keeper import _have_want
        self.assertEqual(_have_want("insufficient funds for gas * price + value: address 0xabc have 26988874357459337 want 32647453000000000"),
                         (26988874357459337, 32647453000000000))
        self.assertEqual(_have_want("execution reverted"), (None, None))


class GiftPlanTests(unittest.TestCase):
    ZERO = "0x0000000000000000000000000000000000000000"
    NFT = "0x1122dB21998707F8c2eD8182734356C947fA5e98"

    def test_open_round_is_settled_before_anything_else(self):
        self.assertEqual(gift_plan(now=100, last_gift_at=90, interval=1000, queued=0, open_nft=self.NFT), "settle")

    def test_first_gift_opens_as_soon_as_something_is_queued(self):
        self.assertEqual(gift_plan(now=100, last_gift_at=0, interval=1000, queued=1, open_nft=self.ZERO), "open")
        self.assertEqual(gift_plan(now=100, last_gift_at=0, interval=1000, queued=0, open_nft=self.ZERO), "idle")

    def test_cadence_waits_the_full_interval(self):
        self.assertEqual(gift_plan(now=1000 + 259_199, last_gift_at=1000, interval=259_200, queued=3, open_nft=self.ZERO), "idle")
        self.assertEqual(gift_plan(now=1000 + 259_200, last_gift_at=1000, interval=259_200, queued=3, open_nft=self.ZERO), "open")


class AttributionTests(unittest.TestCase):
    ROWS = [
        {"symbol": "INTC", "who": "Nancy Pelosi", "chamber": "house", "type": "Buy",
         "amount": "$1,000,001 - $5,000,000", "transactionDate": "2026-07-24", "disclosureDate": "2026-08-24"},
        {"symbol": "INTC", "who": "Nancy Pelosi", "chamber": "house", "type": "Buy",
         "amount": "$250,001 - $500,000", "transactionDate": "2026-07-28", "disclosureDate": "2026-08-24"},
        {"symbol": "INTC", "who": "Kevin Hern", "chamber": "house", "type": "Purchase",
         "amount": "$1,001 - $15,000", "transactionDate": "2026-08-01", "disclosureDate": "2026-08-10"},
        {"symbol": "INTC", "who": "Someone Old", "chamber": "senate", "type": "Buy",
         "amount": "$1,000,001 - $5,000,000", "transactionDate": "2026-01-01", "disclosureDate": "2026-02-01"},
        {"symbol": "INTC", "who": "A Seller", "chamber": "house", "type": "Sale (Full)",
         "amount": "$15,001 - $50,000", "transactionDate": "2026-08-02", "disclosureDate": "2026-08-12"},
        {"symbol": "BE", "who": "Nancy Pelosi", "chamber": "house", "type": "Buy",
         "amount": "$1,000,001 - $5,000,000", "transactionDate": "2026-07-24", "disclosureDate": "2026-08-24"},
    ]

    def test_groups_buys_by_member_inside_the_window(self):
        from attribution import attribute
        out = attribute(self.ROWS, ["INTC"], now=datetime(2026, 9, 3))
        intc = out["INTC"]
        self.assertEqual(intc["buyerCount"], 2)  # the January buy is outside 90 days
        self.assertEqual(intc["sellCount"], 1)
        top = intc["buyers"][0]
        self.assertEqual(top["member"], "Nancy Pelosi")
        self.assertEqual(top["buys"], 2)
        self.assertEqual(top["notionalUsd"], 3_000_000.5 + 375_000.5)
        self.assertEqual(top["latestTraded"], "2026-07-28")
        self.assertEqual(top["latestFiled"], "2026-08-24")
        self.assertEqual(top["ranges"][0], "$1,000,001 - $5,000,000")
        self.assertEqual(intc["buyers"][1]["member"], "Kevin Hern")

    def test_missed_names_get_the_same_treatment(self):
        from attribution import attribute
        out = attribute(self.ROWS, ["BE"], now=datetime(2026, 9, 3))
        self.assertEqual(out["BE"]["buyers"][0]["member"], "Nancy Pelosi")


class CommentaryTests(unittest.TestCase):
    PAYLOAD = {
        "tickers": ["INTC", "SPCX"], "weightsBps": [5000, 5000], "coverage": 0.196,
        "attribution": {"INTC": {"buyers": [{"member": "Nancy Pelosi", "chamber": "house", "buys": 2,
                                             "notionalUsd": 3375001.0, "latestTraded": "2026-07-28",
                                             "latestFiled": "2026-08-24", "ranges": []}],
                                 "buyerCount": 2, "sellCount": 1},
                        "SPCX": {"buyers": [], "buyerCount": 0, "sellCount": 0}},
        "missedCoverage": [{"ticker": "BE", "netNotional": 3750001.0, "shareOfBuying": 0.573}],
        "missedAttribution": {"BE": {"buyers": [{"member": "Nancy Pelosi"}], "buyerCount": 1, "sellCount": 0}},
    }
    NOTE = ("The basket is split between Intel and SpaceX right now. Intel is there because Nancy Pelosi "
            "disclosed two buys worth about $3.4M, traded in late July and filed on August 24. The biggest "
            "name left out is Bloom Energy, about $3.8M of buying, because it is not tokenized on this chain. "
            "Only a fifth of the disclosed buying in the window could be bought.")

    def test_prompt_carries_only_computed_facts(self):
        from commentary import build_prompt, input_hash
        prompt = build_prompt(self.PAYLOAD)
        self.assertIn('"ticker": "INTC"', prompt)
        self.assertIn("Nancy Pelosi", prompt)
        self.assertIn('"$3.4M"', prompt)
        self.assertIn("Output the note only", prompt)
        self.assertEqual(len(input_hash(self.PAYLOAD)), 16)

    def test_validation_rejects_unknown_tickers_and_advice(self):
        from commentary import validate_note
        self.assertTrue(validate_note(self.NOTE, ["INTC", "SPCX", "BE"])[0])
        bad_ticker = self.NOTE + " NVDA looks similar."
        self.assertFalse(validate_note(bad_ticker, ["INTC", "SPCX", "BE"])[0])
        advice = self.NOTE + " You should buy Intel."
        self.assertFalse(validate_note(advice, ["INTC", "SPCX", "BE"])[0])
        self.assertFalse(validate_note("short", ["INTC"])[0])

    def test_generate_reuses_previous_note_when_facts_unchanged(self):
        from commentary import generate, input_hash
        from commentary import PROMPT_VERSION
        prev = {"text": self.NOTE, "model": "x", "generatedAt": "t", "inputHash": input_hash(self.PAYLOAD),
                "promptVersion": PROMPT_VERSION}
        calls = []
        out = generate(self.PAYLOAD, prev, key="k", call=lambda *a: calls.append(a) or self.NOTE)
        self.assertEqual(out["text"], self.NOTE)
        self.assertEqual(calls, [])

    def test_generate_calls_model_and_validates(self):
        from commentary import generate
        out = generate(self.PAYLOAD, None, key="k", model="m", call=lambda p, k, m: self.NOTE)
        self.assertEqual(out["model"], "m")
        self.assertEqual(out["text"], self.NOTE)
        # a note that fails validation twice is dropped, never published
        self.assertIsNone(generate(self.PAYLOAD, None, key="k", call=lambda *a: "You should buy INTC now, guaranteed. " * 5))
        # no key: no call, no note
        self.assertIsNone(generate(self.PAYLOAD, None, key=""))

    def test_generate_keeps_a_young_note_even_when_facts_change(self):
        from commentary import generate
        from datetime import timezone as _tz
        made = datetime(2026, 9, 3, 9, 0, tzinfo=_tz.utc)
        from commentary import PROMPT_VERSION
        prev = {"text": self.NOTE, "model": "x", "generatedAt": made.isoformat(), "inputHash": "stale",
                "promptVersion": PROMPT_VERSION}
        calls = []
        # 3 hours later, facts changed (hash differs): still the old note, no model call
        out = generate(self.PAYLOAD, prev, key="k", call=lambda *a: calls.append(a) or self.NOTE,
                       now=made.replace(hour=12), min_hours=5)
        self.assertEqual(out["inputHash"], "stale")
        self.assertEqual(calls, [])
        # 6 hours later: regenerated
        out = generate(self.PAYLOAD, prev, key="k", call=lambda *a: calls.append(a) or self.NOTE,
                       now=made.replace(hour=15), min_hours=5)
        self.assertNotEqual(out["inputHash"], "stale")
        self.assertEqual(len(calls), 1)

    def test_member_name_suffixes_and_fact_words_are_not_tickers(self):
        from commentary import generate, validate_note
        note = self.NOTE.replace("Nancy Pelosi", "William R. Timmons IV")
        self.assertTrue(validate_note(note, ["INTC", "SPCX", "BE"])[0])
        payload = json.loads(json.dumps(self.PAYLOAD))
        payload["attribution"]["INTC"]["buyers"][0]["member"] = "Ana DE LA Cruz"
        note2 = self.NOTE.replace("Nancy Pelosi", "Ana DE LA Cruz")
        out = generate(payload, None, key="k", call=lambda *a: note2)
        self.assertIsNotNone(out)

    def test_an_older_prompt_version_is_replaced_regardless_of_age(self):
        from commentary import generate, input_hash
        from datetime import timezone as _tz
        now = datetime(2026, 9, 3, 9, 0, tzinfo=_tz.utc)
        prev = {"text": self.NOTE, "model": "x", "generatedAt": now.isoformat(),
                "inputHash": input_hash(self.PAYLOAD), "promptVersion": 1}
        calls = []
        out = generate(self.PAYLOAD, prev, key="k", call=lambda *a: calls.append(a) or self.NOTE, now=now)
        self.assertEqual(len(calls), 1)
        self.assertGreater(out["promptVersion"], 1)


class ScorecardTests(unittest.TestCase):
    def test_aggregate_prices_cost_against_live_feed(self):
        from scorecard import aggregate, WEI
        events = [
            {"token": "0xAAA", "ts": 100, "sharesRaw": 2 * WEI, "usdIn": 200.0},   # 2 shares at $100
            {"token": "0xAAA", "ts": 200, "sharesRaw": 2 * WEI, "usdIn": 240.0},   # 2 shares at $120
            {"token": "0xBBB", "ts": 150, "sharesRaw": 1 * WEI, "usdIn": 50.0},
        ]
        out = aggregate(events, {"0xaaa": 121.0, "0xbbb": 40.0}, {"0xaaa": {"symbol": "AAA"}, "0xbbb": {"symbol": "BBB"}})
        aaa = next(n for n in out["names"] if n["symbol"] == "AAA")
        self.assertEqual(aaa["shares"], 4.0)
        self.assertEqual(aaa["avgCost"], 110.0)
        self.assertEqual(aaa["value"], 484.0)
        self.assertEqual(aaa["pnlUsd"], 44.0)
        self.assertEqual(aaa["pnlPct"], 10.0)
        bbb = next(n for n in out["names"] if n["symbol"] == "BBB")
        self.assertEqual(bbb["pnlUsd"], -10.0)
        self.assertEqual(out["totals"], {"usdSpent": 490.0, "value": 524.0, "pnlUsd": 34.0, "pnlPct": 6.94})
        self.assertEqual([n["symbol"] for n in out["names"]], ["AAA", "BBB"])  # winners first

    def test_unpriced_purchases_never_distort_the_average(self):
        from scorecard import aggregate, WEI
        events = [
            {"token": "0xAAA", "ts": 1, "sharesRaw": 1 * WEI, "usdIn": 100.0},
            {"token": "0xAAA", "ts": 2, "sharesRaw": 1 * WEI, "usdIn": None},
        ]
        out = aggregate(events, {"0xaaa": 100.0}, {"0xaaa": {"symbol": "AAA"}})
        aaa = out["names"][0]
        self.assertEqual(aaa["avgCost"], 100.0)
        self.assertEqual(aaa["unpricedBuys"], 1)
        self.assertEqual(aaa["pnlUsd"], 0.0)


class FeedExportTests(unittest.TestCase):
    ROWS = [
        {"symbol": "INTC", "who": "Nancy Pelosi", "chamber": "house", "type": "Buy", "amount": "$1,000,001 - $5,000,000",
         "transactionDate": "2026-07-24", "disclosureDate": "2026-08-24"},
        {"symbol": "BE", "who": "Nancy Pelosi", "chamber": "house", "type": "Buy", "amount": "$500,001 - $1,000,000",
         "transactionDate": "2026-07-28", "disclosureDate": "2026-08-24"},
        {"symbol": "AAPL", "who": "Nancy Pelosi", "chamber": "house", "type": "Sale (Partial)", "amount": "$250,001 - $500,000",
         "transactionDate": "2026-06-01", "disclosureDate": "2026-06-20"},
        {"symbol": "MU", "who": "Dan Newhouse", "chamber": "house", "type": "Purchase", "amount": "$1,001 - $15,000",
         "transactionDate": "2026-07-10", "disclosureDate": "2026-07-17"},
        {"symbol": "", "who": "Nobody", "chamber": "house", "type": "Buy", "amount": "$1,001 - $15,000",
         "transactionDate": "2026-07-10", "disclosureDate": "2026-08-30"},
    ]

    def test_feed_rows_cover_30_days_of_filings_newest_first(self):
        from feed_export import feed_rows
        rows = feed_rows(self.ROWS, ["INTC", "MU"], ["INTC"], now=datetime(2026, 9, 3))
        self.assertEqual([r["symbol"] for r in rows], ["BE", "INTC"])  # AAPL (June) and MU (Jul 17) are older than 30 days
        intc = rows[1]
        self.assertEqual(intc["slug"], "nancy-pelosi")
        self.assertEqual(intc["lagDays"], 31)
        self.assertTrue(intc["buyable"] and intc["inBasket"])
        self.assertFalse(rows[0]["buyable"])

    def test_member_records_aggregate_the_window(self):
        from feed_export import members
        mem = members(self.ROWS, ["INTC", "MU"], ["INTC"], {"nancy pelosi": {"multiplier": 1.038, "avgExcess30d": 0.0079, "trades": 215}}, now=datetime(2026, 9, 3))
        self.assertEqual([m["slug"] for m in mem], ["nancy-pelosi", "dan-newhouse"])
        p = mem[0]
        self.assertEqual((p["trades"], p["buys"], p["sells"]), (2, 2, 0))  # the June sale is outside the 90-day window
        self.assertEqual(p["buyNotional"], 3_750_001.0)
        self.assertEqual(p["buyableShare"], 0.8)
        self.assertEqual(p["topTickers"][0]["symbol"], "INTC")
        self.assertEqual(p["score"]["multiplier"], 1.038)
        self.assertEqual(p["lastFiled"], "2026-08-24")
        self.assertEqual(p["rows"][0]["symbol"], "BE")


class ScorecardBenchmarkTests(unittest.TestCase):
    def test_smart_weights_pick_the_latest_row_at_or_before(self):
        from scorecard import smart_weights_at
        hist = [{"at": "2026-08-24T11:00:00+00:00", "shadow": [{"ticker": "INTC", "bps": 5000}, {"ticker": "SPCX", "bps": 5000}]},
                {"at": "2026-08-30T02:00:00+00:00", "shadow": [{"ticker": "INTC", "bps": 10000}]}]
        aug25 = int(datetime(2026, 8, 25, tzinfo=timezone.utc).timestamp())
        sep1 = int(datetime(2026, 9, 1, tzinfo=timezone.utc).timestamp())
        self.assertEqual(smart_weights_at(hist, aug25)[1]["ticker"], "SPCX")
        self.assertEqual(smart_weights_at(hist, sep1), [{"ticker": "INTC", "bps": 10000}])
        self.assertIsNone(smart_weights_at(hist, aug25 - 10 * 86400))

    def test_benchmarks_price_the_same_dollars_at_the_same_hours(self):
        from scorecard import benchmarks
        events = [
            {"usdIn": 100.0, "bench": {"spyPx": 500.0, "smart": [{"symbol": "INTC", "usd": 50.0, "px": 80.0}, {"symbol": "SPCX", "usd": 50.0, "px": 100.0}]}},
            {"usdIn": 100.0, "bench": {"spyPx": None, "smart": None}},  # before the feed history / no shadow yet
        ]
        out = benchmarks(events, {"INTC": 88.0, "SPCX": 90.0}, spy_now=550.0)
        self.assertEqual(out["spy"]["pnlPct"], 10.0)
        self.assertEqual(out["spy"]["purchases"], 1)
        self.assertEqual(out["spy"]["coveragePct"], 50.0)
        # 50 * 88/80 + 50 * 90/100 = 55 + 45 = 100 -> 0%
        self.assertEqual(out["smart"]["pnlPct"], 0.0)
        self.assertEqual(out["smart"]["purchases"], 1)


class FiledWindowTests(unittest.TestCase):
    def test_aggregate_can_key_the_window_on_the_filing_date(self):
        from aggregate import aggregate
        now = datetime(2026, 9, 3)
        rows = [
            # traded 97 days ago, filed 70 days ago: out by trade date, in by filing date
            {"symbol": "INTC", "type": "Purchase", "amount": "$1,000,001 - $5,000,000", "transactionDate": "2026-05-29", "disclosureDate": "2026-06-24"},
            {"symbol": "MU", "type": "Purchase", "amount": "$1,001 - $15,000", "transactionDate": "2026-07-10", "disclosureDate": "2026-07-17"},
        ]
        by_trade = aggregate(rows, now=now)
        by_filed = aggregate(rows, date_key="disclosureDate", now=now)
        self.assertNotIn("INTC", by_trade)
        self.assertEqual(by_filed["INTC"], 3_000_000.5)
        self.assertEqual(by_trade["MU"], by_filed["MU"])

    def test_shadow_history_row_carries_the_filed_window(self):
        from run import shadow_history_row
        row = json.loads(shadow_history_row(5000, [("INTC", 10000)], [("INTC", 5000), ("SPCX", 5000)], set(), "shadow",
                                            filed_window={"basket": [("INTC", 7000), ("NVDA", 3000)], "divergenceBps": 2500}))
        self.assertEqual(row["filedWindow"]["divergenceBps"], 2500)
        self.assertEqual(row["filedWindow"]["basket"][1], {"ticker": "NVDA", "bps": 3000})
        self.assertIsNone(json.loads(shadow_history_row(0, [], [], set(), "shadow"))["filedWindow"])

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

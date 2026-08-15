import unittest
import base64
import json
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
        self.assertEqual(to_basket({"NVDA": 30_000}), [])


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
            "attributes": [{"trait_type": str(i), "value": "x"} for i in range(7)],
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


if __name__ == "__main__":
    unittest.main()

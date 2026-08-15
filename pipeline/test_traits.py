import unittest
from collections import Counter

from config import MAX_SUPPLY, TRAIT_CATEGORIES
from trait_names import EXACT_COUNTS_BY_CATEGORY, POOLS, build_prompt, label
from traits import build_collection_traits, traits_for_token_id, validate_traits


class ExactTraitDistributionTest(unittest.TestCase):
    def test_collection_is_complete_unique_and_valid(self):
        collection = build_collection_traits(0)
        self.assertEqual(len(collection), MAX_SUPPLY)
        self.assertEqual(len(set(collection)), MAX_SUPPLY)
        self.assertTrue(all(validate_traits(traits) for traits in collection))
        self.assertEqual(collection[0], traits_for_token_id(1))
        self.assertEqual(collection[-1], traits_for_token_id(MAX_SUPPLY))

    def test_all_public_counts_are_exact(self):
        collection = build_collection_traits(0)
        categories = ("Type", "Headwear", "Eyes", "Mouth", "Jewelry", "Face", "Accessory")
        for byte_index, category in enumerate(categories):
            actual = Counter(traits[byte_index] for traits in collection)
            expected = list(EXACT_COUNTS_BY_CATEGORY[category])
            if category != "Type":
                expected[0] = MAX_SUPPLY - sum(expected[1:])
            self.assertEqual([actual[i] for i in range(len(POOLS[category]))], expected)

    def test_schema_pool_lengths_match(self):
        for category, maximum in TRAIT_CATEGORIES[:7]:
            self.assertEqual(len(POOLS[category]), maximum + 1)

    def test_every_token_has_an_assigned_optional_trait(self):
        self.assertTrue(all(any(traits[1:7]) for traits in build_collection_traits(0)))

    def test_locked_traits_exist_with_exact_counts(self):
        expected = {
            "Beanie": 8, "Choker": 9, "Pilot Helmet": 10, "Tiara": 10,
            "Buck Teeth": 14, "Welding Goggles": 15, "Top Hat": 20,
            "Cowboy Hat": 25, "Silver Chain": 28, "Gold Chain": 30,
            "Medical Mask": 31, "Hoodie": 46, "3D Glasses": 51,
            "VR": 59, "Cigarette": 171, "Earring": 437,
            "Spots": 22, "Rosy Cheeks": 23, "Clown Nose": 38,
            "Smile": 42, "Cap Forward": 45, "Pipe": 56,
            "Bandana": 85, "Classic Shades": 89, "Mole": 114,
            "Hot Lipstick": 124,
        }
        collection = build_collection_traits(0)
        actual = Counter()
        categories = ("Headwear", "Eyes", "Mouth", "Jewelry", "Face", "Accessory")
        for traits in collection:
            for byte_index, category in enumerate(categories, 1):
                actual[label(category, traits[byte_index])] += 1
        for name, count in expected.items():
            self.assertEqual(actual[name], count, name)

    def test_visual_seed_is_diverse(self):
        seeds = {traits[7] for traits in build_collection_traits(0)}
        self.assertGreater(len(seeds), 240)

    def test_rare_type_prompts_are_morphologically_explicit(self):
        collection = build_collection_traits(0)
        prompts = {}
        for traits in collection:
            prompts.setdefault(label("Type", traits[0]), build_prompt(traits).lower())
        self.assertIn("clearly not a healthy living human", prompts["zombie"])
        self.assertIn("hollow mismatched eyes", prompts["zombie"])
        self.assertIn("broad protruding muzzle", prompts["ape"])
        self.assertIn("large smooth uninterrupted oval head", prompts["alien"])

    def test_prompts_have_no_old_collection_cues(self):
        blocked = ("broker", "stock", "market", "trading", "antenna", "horn", "suit", "tie")
        for traits in build_collection_traits(0):
            prompt = build_prompt(traits).lower()
            self.assertFalse([word for word in blocked if word in prompt])


if __name__ == "__main__":
    unittest.main()

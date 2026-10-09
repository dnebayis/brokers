"""Merkle math of bonus_round.py: the tree a round file carries must verify leaf by leaf with the
same commutative pair hash OpenZeppelin's MerkleProof folds on chain (the fork rehearsal,
script/check_bonus_round.py, is where the chain itself confirms it; this keeps the pure part
honest without a node)."""

import unittest

from bonus_round import build_tree, hash_pair, leaf_hash, verify_proof


class TreeTest(unittest.TestCase):
    def test_leaf_is_double_hashed_abi_encoding(self):
        # keccak256(bytes.concat(keccak256(abi.encode(uint256 1, uint256 100e18)))), as the contract
        # and test/CoatBonusPool.t.sol compute it
        from web3 import Web3
        inner = Web3.keccak((1).to_bytes(32, "big") + (100 * 10**18).to_bytes(32, "big"))
        self.assertEqual(leaf_hash(1, 100 * 10**18), Web3.keccak(inner))

    def test_pair_hash_is_commutative(self):
        a, b = leaf_hash(1, 5), leaf_hash(2, 5)
        self.assertEqual(hash_pair(a, b), hash_pair(b, a))

    def test_two_leaves_match_the_solidity_fixture(self):
        # test/CoatBonusPool.t.sol: root = _hashPair(_leaf(1, 100e18), _leaf(2, 50e18)), proof = the sibling
        l1, l2 = leaf_hash(1, 100 * 10**18), leaf_hash(2, 50 * 10**18)
        root, proofs = build_tree([l1, l2])
        self.assertEqual(root, hash_pair(l1, l2))
        self.assertEqual(proofs[l1], [l2])
        self.assertEqual(proofs[l2], [l1])

    def test_every_leaf_verifies_for_any_count(self):
        for n in (1, 2, 3, 4, 5, 7, 8, 9, 100, 1291, 1776):
            leaves = [leaf_hash(i, 93 * 10**18) for i in range(1, n + 1)]
            root, proofs = build_tree(leaves)
            self.assertEqual(len(proofs), n)
            for leaf in leaves:
                self.assertTrue(verify_proof(root, leaf, proofs[leaf]), f"n={n}")
            depth = max(len(p) for p in proofs.values())
            self.assertLessEqual(depth, (n - 1).bit_length() + 1)

    def test_wrong_amount_or_foreign_leaf_fails(self):
        leaves = [leaf_hash(i, 10) for i in range(1, 50)]
        root, proofs = build_tree(leaves)
        self.assertFalse(verify_proof(root, leaf_hash(1, 11), proofs[leaves[0]]))
        self.assertFalse(verify_proof(root, leaf_hash(999, 10), proofs[leaves[0]]))
        self.assertFalse(verify_proof(root, leaves[0], proofs[leaves[1]]))

    def test_duplicates_and_empty_refused(self):
        with self.assertRaises(ValueError):
            build_tree([])
        with self.assertRaises(ValueError):
            build_tree([leaf_hash(1, 1), leaf_hash(1, 1)])

    def test_root_is_independent_of_input_order(self):
        leaves = [leaf_hash(i, 7) for i in range(1, 30)]
        r1, _ = build_tree(leaves)
        r2, _ = build_tree(list(reversed(leaves)))
        self.assertEqual(r1, r2)


if __name__ == "__main__":
    unittest.main()

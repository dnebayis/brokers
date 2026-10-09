# Bonus rounds

One file per round the CoatBonusPool pays, written by `keeper/bonus_round.py snapshot` and
committed **before** the root is posted, so every round can be rebuilt from public state:

- `snapshotBlock`: the block every Broker was read at (owner, 6551 wallet, `Booster.isActive`)
- `activeBrokers`, `perBroker`, `total`: the pool's unallocated COAT split equally over the
  Brokers active at that block; what does not divide stays in the pool for the next round
- `root` and one `proof` per leaf (`keccak256(bytes.concat(keccak256(abi.encode(tokenId, amount))))`,
  OpenZeppelin `MerkleProof` sorted-pair tree)
- `posted` (round id, transaction) and `claims` (one entry per `claimMany` batch) are filled in
  by `post` and `claim` and committed afterwards as the receipts

Flow: `snapshot` -> review and commit -> `post` (the poster is the keeper relay; from the
`desk-bonus-round` workflow or a terminal that holds its key) -> `claim` (permissionless, in
batches, resumable) -> commit the updated file. `verify` checks a file at any point; once the
round is posted it also asks the chain, without sending, that every pending claim would be paid.

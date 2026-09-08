
## verified sources fetched from Sourcify (chain 4663)

Coattail Brokers:
  CoattailBroker                 0x1122dB21998707F8c2eD8182734356C947fA5e98  exact_match  solc 0.8.24+commit.e11b9ed9  block 39460983  files 2
  BrokerAccount                  0x32A055D504840E69B7a0B2136264EEF643f6312C  match        solc 0.8.24+commit.e11b9ed9  block 39460869  files 1
  Booster                        0x7bAf435847A4b45c2e22a7fd13549C3192C95953  exact_match  solc 0.8.24+commit.e11b9ed9  block 39461039  files 4
  StockRouter                    0x99F3f896B58bcb8A515ED3C7174c017B5a55075a  exact_match  solc 0.8.24+commit.e11b9ed9  block 39461011  files 1
  StrategyRegistry               0xA20f9D47E0c41e52a57d65feA9A9322732aF86Aa  exact_match  solc 0.8.24+commit.e11b9ed9  block 39460926  files 1
  FeeSplitter                    0x8cE36Fa4aa2d934cA6aD7bE9de31a8eeFeDf8aE8  exact_match  solc 0.8.24+commit.e11b9ed9  block 39461097  files 1
  COAT                           0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833  match        solc 0.8.24+commit.e11b9ed9  block 39460897  files 1
  CoatFeeHook                    0x51149a925E9193EA13Ae406Da6Cc154EccD0A044  exact_match  solc 0.8.24+commit.e11b9ed9  block 39470720  files 2
  BasketRouter                   0x478F22A32663cF37702d65352A7579A73e61FDc7  exact_match  solc 0.8.24+commit.e11b9ed9  block None  files 1
StonkBrokers:
  StonkBrokers (NFT)             0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0  exact_match  solc 0.8.26+commit.8a97fa7a  block 12493793  files 7
  StonkBroker6551Account         0xe946075125843aadb5e40e59f513d929af507c4b  exact_match  solc 0.8.26+commit.8a97fa7a  block 12493791  files 1
  ERC6551Registry (vendored)     0x28c154cbdeaecbf5f72b6ae48535ab9a431a4161  exact_match  solc 0.8.26+commit.8a97fa7a  block 12493791  files 1
  Renderer                       0x2a2fc76d9cb0e5d2bdb2ba6b236b6e7ef264b186  exact_match  solc 0.8.26+commit.8a97fa7a  block 12493793  files 2
  ActivationManager              0xacd5ae3c060c1137fe2ee86b0ab2ef697456f664  exact_match  solc 0.8.26+commit.8a97fa7a  block 12514721  files 3
  DirectedClockInBooster         0x1f12fe622c11947f93f53d63f68f7f46b6d081c9  exact_match  solc 0.8.26+commit.8a97fa7a  block 27108815  files 5
  StonkNFTAMMVault (Anvil)       0xe302733accf4800146e55fc45b46b4e4ffc032d2  exact_match  solc 0.8.26+commit.8a97fa7a  block 12514722  files 7
  StonkLoanVault                 0xa7b9ac696b252b79568a5a01b2fd02177ef23664  exact_match  solc 0.8.26+commit.8a97fa7a  block 12514722  files 5
  TokenEscrowReserve             0x799ae26fa515cef145e8bc8636f7fff87b05cf62  exact_match  solc 0.8.26+commit.8a97fa7a  block 12514722  files 3
  CollectionToken (STONKBROKER)  0xe934e36a439c94017b64a3fece66af12099abf50  exact_match  solc 0.8.26+commit.8a97fa7a  block 12514720  files 2

## identifier overlap (standard ERC / OpenZeppelin names removed)

  functions  coattail 135  stonkbrokers 244  shared 9   ['_update', 'account', 'activate', 'createAccount', 'release', 'setKeeper', 'token0', 'token1', 'withdraw']
  events     coattail 45   stonkbrokers 60   shared 1   ['Activated']
  errors     coattail 69   stonkbrokers 46   shared 1   ['ZeroAddress']
  structs    coattail 7    stonkbrokers 7    shared 0   []
  contracts  coattail 36   stonkbrokers 28   shared 0   []

## 8-token shingle overlap, per Coattail file

  BasketRouter :: BasketRouter.sol             found-in-stonkbrokers   4.3%   best match ActivationManager.sol              jaccard  1.30%
  Booster :: Booster.sol                       found-in-stonkbrokers   6.3%   best match ActivationManager.sol              jaccard  1.92%
  Booster :: CoattailBroker.sol                found-in-stonkbrokers   9.5%   best match StonkBrokers.sol                   jaccard  2.71%
  Booster :: IExternal.sol                     found-in-stonkbrokers  17.9%   best match IStonkSwapRouter.sol               jaccard  6.30%
  Booster :: StrategyRegistry.sol              found-in-stonkbrokers   4.1%   best match StonkBroker6551Account.sol         jaccard  0.78%
  BrokerAccount :: BrokerAccount.sol           found-in-stonkbrokers  12.3%   best match StonkBroker6551Account.sol         jaccard  4.64%
  COAT :: COAT.sol                             found-in-stonkbrokers  11.4%   best match CollectionToken.sol                jaccard  4.73%
  CoatFeeHook :: CoatFeeHook.sol               found-in-stonkbrokers   2.9%   best match ActivationManager.sol              jaccard  0.74%
  CoatFeeHook :: V4Types.sol                   found-in-stonkbrokers   0.7%   best match IBrokerTokenBound.sol              jaccard  0.41%
  CoattailBroker :: CoattailBroker.sol         found-in-stonkbrokers   9.5%   best match StonkBrokers.sol                   jaccard  2.71%
  CoattailBroker :: IExternal.sol              found-in-stonkbrokers  17.9%   best match IStonkSwapRouter.sol               jaccard  6.30%
  FeeSplitter :: FeeSplitter.sol               found-in-stonkbrokers   7.5%   best match StonkBroker6551Account.sol         jaccard  0.81%
  StockRouter :: StockRouter.sol               found-in-stonkbrokers  10.2%   best match ActivationManager.sol              jaccard  2.32%
  StrategyRegistry :: StrategyRegistry.sol     found-in-stonkbrokers   4.1%   best match StonkBroker6551Account.sol         jaccard  0.78%

## what the shared shingles are (first 20, alphabetical)

  ! = address ( 0 ) & &
  ! = address ( 0 ) ) revert
  ! = address ( 0 ) ) {
  ! = address ( 0 ) , "
  " " ) ; if ( ! ok
  " " ) ; if ( ok )
  " " ) ; require ( ok ,
  " ) ; if ( ! ok )
  " ) ; require ( ok , "
  " ; import { ERC20Burnable } from "
  " ; import { IERC721 } from "
  " ; import { Ownable } from "
  " ; import { ReentrancyGuard } from "
  " ; import { SafeERC20 } from "
  " @ openzeppelin / contracts / access /
  " @ openzeppelin / contracts / interfaces /
  " @ openzeppelin / contracts / token /
  " @ openzeppelin / contracts / utils /
  & & to ! = address ( 0
  & to ! = address ( 0 )
  ... 509 shared 8-token runs in total

## ERC-6551 account implementations vs the public EIP-6551 reference text

  BrokerAccount :: BrokerAccount.sol                   shares  62.3% of its token runs with the EIP-6551 reference
  StonkBroker6551Account :: StonkBroker6551Account.sol shares  11.9% of its token runs with the EIP-6551 reference

## own-source size (comment-stripped lines)

  coattail 3312   stonkbrokers 8338

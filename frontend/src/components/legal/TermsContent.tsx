import type { ReactNode } from "react";
import { RESTRICTED_JURISDICTIONS, TERMS_VERSION } from "@/lib/terms";

// The site terms as data: the /terms page renders them at full size, the one-time window
// renders the same sections in a scroll box. Both read this file, so the two can never drift.
export type TermsSection = { id: string; title: string; body: ReactNode };

function P({ children }: { children: ReactNode }) {
  return <p className="text-ink leading-relaxed my-2.5">{children}</p>;
}
function List({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className="list-disc ml-5 space-y-1.5 text-ink my-2.5">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

export const TERMS_SECTIONS: readonly TermsSection[] = [
  {
    id: "website-disclaimer",
    title: "Website Disclaimer",
    body: (
      <>
        <P>
          coattail.cash (the &ldquo;site&rdquo;) is an informational website and a self-service interface for
          public smart contracts deployed on Robinhood Chain. It is operated by the Coattail Brokers project (the
          &ldquo;operator&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). By opening the site, connecting a wallet or
          submitting a transaction through it you accept these terms in full. If you do not accept them, do not use
          the site.
        </P>
        <P>
          Everything on the site is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without warranty of
          any kind. Figures shown on the site are read from public blockchain data, third-party price feeds and
          public government disclosures; they can be delayed, incomplete or wrong, and the chain is the only record
          that counts. We do not guarantee that the site is accurate, uninterrupted, secure or free of errors, and we
          may change, suspend or withdraw any part of it at any time without notice.
        </P>
        <P>
          The project is independent. It is not affiliated with, endorsed by or connected to Robinhood, any member of
          the United States Congress, any data provider, any token issuer or any trading venue. We use the descriptive
          name &ldquo;The Politician&rdquo; and never a real person&rsquo;s name or likeness.
        </P>
      </>
    ),
  },
  {
    id: "stock-token-features",
    title: "Stock Token Features",
    body: (
      <>
        <P>
          Some features of the site let you see, claim, hold, buy or sell tokenized stock instruments (&ldquo;stock
          tokens&rdquo;) that exist as tokens on Robinhood Chain: the Broker claim flow, the basket terminal known as
          The Floor, Playbooks and any trade or swap screen (together, the &ldquo;stock token features&rdquo;).
        </P>
        <P>
          Stock tokens are issued, administered and redeemed by third parties, not by us. We do not issue them, we do
          not custody them, we do not hold the underlying shares and we do not control their price, transferability,
          corporate actions, trading hours or continued existence. Each stock token is governed by its issuer&rsquo;s
          own terms, which you must read and accept on the issuer&rsquo;s side. A stock token is not a share, gives you
          no shareholder or voting rights, and may not be redeemable by you at all.
        </P>
        <P>
          The protocol buys stock tokens with trading fees it has already collected and credits them to active Brokers.
          What is bought, when, and in what proportion follows a published on-chain basket derived from public United
          States congressional trading disclosures, which are filed with a delay and are sometimes corrected. The
          basket mirrors disclosed data, not live positions, and it only includes names that have a tokenized version
          with a working on-chain route.
        </P>
      </>
    ),
  },
  {
    id: "eligibility",
    title: "Eligibility and Who May Use Stock Token Features",
    body: (
      <>
        <P>
          You may use the stock token features only if all of the following are true: you are at least 18 years old and
          have full legal capacity; you are not located in, resident of, incorporated in or a citizen of a restricted
          jurisdiction listed below; you are not a person, and do not act for a person, named on any sanctions list
          maintained by the United Nations, the European Union, the United Kingdom or the United States; you are acting
          for yourself and not for a third party who would be ineligible; you are permitted under the laws that apply to
          you to hold and deal in the stock tokens concerned; and you have read and accepted the terms of the issuer of
          every stock token you hold or trade.
        </P>
        <P>
          Every time you use a stock token feature you repeat these representations. If any of them stops being true,
          you must stop using the stock token features at once. We may ask you for information to confirm your
          eligibility and may refuse, limit or end access to any feature for any account or wallet without giving a
          reason.
        </P>
      </>
    ),
  },
  {
    id: "restricted-jurisdictions",
    title: "Restricted Jurisdictions and Geographic Screening",
    body: (
      <>
        <P>The stock token features are not offered to, and may not be used by, anyone in or from:</P>
        <List items={RESTRICTED_JURISDICTIONS} />
        <P>
          We may use IP-address geolocation, VPN and proxy detection, wallet screening and similar tools to identify
          visitors from restricted jurisdictions, and we may block the site, hide features or refuse to prepare a
          transaction for them without notice. Screening is a best-effort control, not a guarantee, and its absence
          does not make an ineligible person eligible. Using a VPN, proxy or other means to disguise your location in
          order to reach the stock token features is a breach of these terms, and anything you do while doing so is
          your responsibility alone.
        </P>
        <P>
          The smart contracts themselves are public and permissionless. Our controls apply to this interface. We cannot
          and do not stop anyone from interacting with the contracts directly, and doing so is not a use of the site.
        </P>
      </>
    ),
  },
  {
    id: "no-offer-no-advice",
    title: "No Offer, No Advice",
    body: (
      <>
        <P>
          Nothing on the site is an offer, solicitation, recommendation or invitation to buy, sell or hold any security,
          token, stock token, NFT or other asset, in any jurisdiction. Nothing on the site is investment, financial,
          trading, tax, accounting or legal advice, and nothing on it takes your personal circumstances into account.
          We are not a broker, dealer, exchange, investment adviser, portfolio manager or fiduciary.
        </P>
        <P>
          The Broker NFT, the COAT token and the stock token features are provided as software utilities. Past
          scorecard figures, basket returns and comparisons with any index are historical and descriptive; they promise
          nothing about the future. Rewards are funded by trading volume and are never guaranteed. Make your own
          decisions and consult your own advisers.
        </P>
      </>
    ),
  },
  {
    id: "protocol-and-smart-contracts",
    title: "Protocol and Smart Contracts (User Interface Only)",
    body: (
      <>
        <P>
          The site is a user interface. It prepares transactions that you review and sign in your own wallet. It never
          holds a private key, never holds your assets and cannot move anything without your signature. Your assets sit
          in your wallet or in the smart-contract wallet of a Broker you own, under your control.
        </P>
        <P>
          The underlying smart contracts are deployed on Robinhood Chain, with their source code published and verified
          on the public explorer. The contracts that hold value have no owner key that can move user assets and no
          upgrade path; the operator can adjust a small set of published parameters, such as which venues the engine
          may route through, and nothing else. Anyone may read the code and anyone may call the public entry points.
          The operator&rsquo;s keeper is a convenience that submits those calls on a schedule, not a promise that they
          will run.
        </P>
        <P>
          Because the contracts are immutable and permissionless, we cannot reverse, cancel or refund a transaction, and
          we cannot recover assets sent to the wrong address, claimed to the wrong Broker or lost through a compromised
          wallet. You are responsible for your wallet, your keys and every transaction you sign.
        </P>
      </>
    ),
  },
  {
    id: "risk-disclosure",
    title: "Risk Disclosure",
    body: (
      <>
        <P>Using the site and the protocol involves substantial risk, including the risk of losing everything you put in. In particular:</P>
        <List
          items={[
            <><b>Market risk.</b> Stock tokens, COAT and Broker NFTs can lose value quickly and may become worthless or illiquid.</>,
            <><b>Smart-contract risk.</b> The contracts, oracles, routers, pools, indexers and third-party token contracts may contain bugs, may be exploited or may behave in ways no one expected. No third-party audit firm was engaged; the code is published for you to review.</>,
            <><b>Issuer and venue risk.</b> Stock tokens depend on their issuers and on the venues where they trade. Issuers may pause, delist, freeze, redeem or change the terms of a token; a venue may go dark; a route may stop working. None of this is under our control.</>,
            <><b>Data risk.</b> Congressional disclosures are filed with a delay, are sometimes amended, and may not reflect the filer&rsquo;s current holdings. Price feeds may be stale or wrong.</>,
            <><b>Volume risk.</b> Rewards come only from trading fees already collected. If trading stops, the engine has nothing to spend.</>,
            <><b>Operational risk.</b> The keeper, the indexer, the site and any third-party service may be late, offline or wrong. The chain is the record; the site is a view of it.</>,
            <><b>Legal and tax risk.</b> Laws on tokenized securities, NFTs and digital assets differ between countries and change. You alone are responsible for the taxes and reporting that apply to you.</>,
            <><b>Wallet risk.</b> Loss of a key, a phishing site, a malicious signature or a compromised device can drain a wallet and every Broker it holds, and no one can restore it.</>,
          ]}
        />
        <P>Do not use the site with money you cannot afford to lose.</P>
      </>
    ),
  },
  {
    id: "intellectual-property",
    title: "Intellectual Property and NFT Art License",
    body: (
      <>
        <P>
          The Coattail Brokers name, logo, site design, texts and code (except third-party and open-source components,
          which keep their own licences) belong to the operator. The smart-contract source is published under the
          licence stated in each file.
        </P>
        <P>
          The artwork of every Broker NFT is generated and stored on chain. While you hold a Broker you have a
          worldwide, royalty-free, non-exclusive licence to display, copy and share the artwork of that Broker for your
          own personal, non-commercial use, and to show it on marketplaces and social media in connection with owning,
          selling or discussing that Broker. The licence moves with the NFT: it ends the moment you no longer hold that
          Broker and passes to the next holder. It does not cover the Coattail Brokers name or logo, the artwork of
          Brokers you do not hold, or use of the artwork in a way that is unlawful, defamatory or that implies our
          endorsement.
        </P>
        <P>
          The NFT contract reports a fixed 2.5% resale royalty under ERC-2981, payable to the creator by marketplaces
          that honour the standard. Nothing on the site licenses any third-party mark, including the names and marks of
          the companies behind any stock token.
        </P>
      </>
    ),
  },
  {
    id: "changes-to-terms",
    title: "Changes to Terms",
    body: (
      <>
        <P>
          We may change these terms at any time. Each version carries a date, shown at the top of the terms page and in
          the acceptance window. When the terms change in a way that matters, the site shows the window again the next
          time you open it, and you have to accept the new version before continuing. Continuing to use the site after a
          change means you accept the changed terms. The current version is always at coattail.cash/terms.
        </P>
        <P>This version: {TERMS_VERSION}.</P>
      </>
    ),
  },
  {
    id: "governing-law",
    title: "Governing Law and Jurisdiction",
    body: (
      <>
        <P>
          These terms, and any dispute or claim arising out of them or out of your use of the site, are governed by the
          laws of the place where the operator is established, without regard to its conflict-of-law rules. The courts
          of that place have exclusive jurisdiction, and you waive any objection to that venue, except that mandatory
          consumer-protection rules of your country of residence continue to apply where the law says they must.
        </P>
        <P>
          To the fullest extent the law allows, the operator, its contributors and its service providers are not liable
          to you for any loss of assets, profits, data or opportunity, or for any indirect, special or consequential
          loss, arising from the site, the protocol, any stock token, any issuer or any third party, however caused.
          Where liability cannot be excluded, it is limited to the fees you paid to the operator through the site in the
          twelve months before the claim, which for a non-custodial interface is normally zero. If any part of these
          terms is found unenforceable, the rest stays in force.
        </P>
      </>
    ),
  },
];

export function TermsBody({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "text-sm" : ""}>
      {TERMS_SECTIONS.map((s) => (
        <section key={s.id} id={compact ? undefined : s.id} className="scroll-mt-24">
          <h2 className={`font-pixel text-ink-strong pb-1.5 border-b border-line ${compact ? "text-[12px] mt-6 mb-2" : "text-base mt-9 mb-2.5"}`}>
            {s.title}
          </h2>
          {s.body}
        </section>
      ))}
    </div>
  );
}

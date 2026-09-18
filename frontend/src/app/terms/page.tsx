import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { TERMS_SECTIONS, TermsBody } from "@/components/legal/TermsContent";
import { TERMS_VERSION } from "@/lib/terms";

export const metadata: Metadata = {
  title: "Terms · Coattail Brokers",
  description: "Website disclaimer, eligibility, restricted jurisdictions, risk disclosure and NFT art licence for coattail.cash.",
  alternates: { canonical: "/terms" },
};

// The full terms on their own page: the acceptance window links here, the footer links here,
// and a visitor who lands here directly reads them without the window in the way.
export default function TermsPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex-1 py-8 lg:py-10">
        <div className="grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start">
          <aside className="lg:sticky lg:top-24">
            <p className="chip inline-block">Terms</p>
            <h1 className="font-pixel text-xl text-ink-strong mt-3 leading-snug">Terms of use and disclosures</h1>
            <p className="text-xs text-ink-soft mt-2">Version {TERMS_VERSION}</p>
            <nav aria-label="Sections" className="mt-5 border-t border-line">
              {TERMS_SECTIONS.map((s, i) => (
                <a key={s.id} href={`#${s.id}`} className="block text-sm text-ink py-2 border-b border-line hover:text-accent">
                  <span className="font-pixel text-[10px] text-ink-soft mr-2">{String(i + 1).padStart(2, "0")}</span>
                  {s.title}
                </a>
              ))}
            </nav>
            <Link href="/" className="btn btn-ghost shadow-pixel-sm mt-5">← Back to the app</Link>
          </aside>
          <article className="card max-w-3xl">
            <p className="text-lg text-ink-strong leading-relaxed">
              Read this before you use the site. It says who may use the stock token features, where they are not
              offered, what the site is and is not, and what you are agreeing to.
            </p>
            <TermsBody />
          </article>
        </div>
      </main>
      <footer className="border-t-2 border-ink">
        <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 text-xs text-ink-soft flex flex-wrap justify-between gap-2">
          <span>Coattail Brokers · fully on-chain on Robinhood Chain</span>
          <span>Not financial or legal advice · participation involves risk</span>
        </div>
      </footer>
    </div>
  );
}

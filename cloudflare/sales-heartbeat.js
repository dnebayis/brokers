// Coattail heartbeat — Cloudflare Worker (free plan). Two jobs, one worker:
//
//  1. Sales bot sweep, every minute. GitHub stretches a */5 Actions cron to 30-48 real
//     minutes, so sale embeds arrived in batches. Cloudflare's free plan runs cron triggers
//     every minute, and the sweep endpoint is idempotent (KV block cursor — never a duplicate
//     post), so this worker simply pokes it and the GitHub cron stays as a backup.
//  2. Wallet-pass push sweep, every 5 minutes. Walks the Brokers that have an Apple Wallet
//     pass registered, and pings the phones whose card changed (payout landed, switched
//     on/off, sold). Also idempotent and cursor-resumed.
//
// Setup (dashboard, ~5 min):
//   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker ("sales-heartbeat")
//   2. Edit code -> paste this file -> Deploy
//   3. Settings -> Variables and Secrets -> add SECRET named RECHECK_SECRET
//      (same value as the Vercel env / GitHub secret). Optional: PASSKIT_PUSH_SECRET if the
//      pass sweep uses its own bearer on Vercel; otherwise RECHECK_SECRET is used for both.
//   4. Settings -> Triggers -> Cron Triggers -> add TWO:  * * * * *   and   */5 * * * *
//
// Free-plan budget: ~1,730 invocations/day of the 100,000 allowed.

const SITE = "https://www.coattail.cash";

async function poke(path, secret) {
  if (!secret) {
    return { status: 0, body: "secret is NOT set on this worker (Settings -> Variables and Secrets)" };
  }
  const res = await fetch(SITE + path, { headers: { Authorization: `Bearer ${secret}` } });
  return { status: res.status, body: await res.text() };
}

const sweepSales = (env) => poke("/api/discord/sales", env.RECHECK_SECRET);
const sweepPasses = (env) => poke("/api/pass/push", env.PASSKIT_PUSH_SECRET || env.RECHECK_SECRET);

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "*/5 * * * *") {
      const r = await sweepPasses(env);
      console.log("passes", r.status, r.body);
      return;
    }
    const r = await sweepSales(env);
    console.log("sales", r.status, r.body);
  },
  // Debug door: opening the worker URL in a browser runs one sales sweep and shows the
  // result; add ?passes to run the pass sweep instead. Both are idempotent, so extra hits
  // are harmless, and the secrets themselves are never revealed.
  async fetch(request, env) {
    const wantPasses = new URL(request.url).searchParams.has("passes");
    const r = wantPasses ? await sweepPasses(env) : await sweepSales(env);
    return new Response(`${wantPasses ? "pass sweep" : "sales sweep"} -> upstream ${r.status}\n${r.body}`, {
      headers: { "Content-Type": "text/plain" },
    });
  },
};

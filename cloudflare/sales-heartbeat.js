// Coattail sales-bot heartbeat — Cloudflare Worker (free plan).
//
// GitHub stretches a */5 Actions cron to 30-48 real minutes, so sale embeds arrived in
// batches. Cloudflare's free plan runs cron triggers every minute, and the sweep
// endpoint is idempotent (KV block cursor — never a duplicate post), so this worker
// simply pokes it once a minute and the GitHub cron stays as a backup.
//
// Setup (dashboard, ~5 min):
//   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker ("sales-heartbeat")
//   2. Edit code -> paste this file -> Deploy
//   3. Settings -> Variables and Secrets -> add SECRET named RECHECK_SECRET
//      (same value as the Vercel env / GitHub secret)
//   4. Settings -> Triggers -> Cron Triggers -> add:  * * * * *
//
// Free-plan budget: 1,440 invocations/day of the 100,000 allowed.

export default {
  async scheduled(event, env, ctx) {
    const res = await fetch("https://www.coattail.cash/api/discord/sales", {
      headers: { Authorization: `Bearer ${env.RECHECK_SECRET}` },
    });
    // Visible in the worker's live logs; the endpoint reports sales count and cursor.
    console.log(res.status, await res.text());
  },
};

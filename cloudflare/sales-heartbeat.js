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

async function sweep(env) {
  if (!env.RECHECK_SECRET) {
    return { status: 0, body: "RECHECK_SECRET is NOT set on this worker (Settings -> Variables and Secrets)" };
  }
  const res = await fetch("https://www.coattail.cash/api/discord/sales", {
    headers: { Authorization: `Bearer ${env.RECHECK_SECRET}` },
  });
  return { status: res.status, body: await res.text() };
}

export default {
  async scheduled(event, env, ctx) {
    const r = await sweep(env);
    console.log(r.status, r.body);
  },
  // Debug door: opening the worker URL in a browser runs one sweep and shows the
  // result — no log-hunting needed. The sweep is cursor-idempotent, so extra hits
  // are harmless, and the secret itself is never revealed.
  async fetch(request, env) {
    const r = await sweep(env);
    return new Response(`sweep -> upstream ${r.status}\n${r.body}`, {
      headers: { "Content-Type": "text/plain" },
    });
  },
};

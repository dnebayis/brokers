# Discord sales bot — setup

The holder-verification bot (`/verify`, Brokerage role, daily re-check) was retired on
2026-09-03 in favour of an external verification service. What remains is the sales bot:
a serverless sweep on the live site that posts every Broker sale as an embed.

## How it runs
- `GET https://www.coattail.cash/api/discord/sales` (bearer `RECHECK_SECRET`) reads new
  Transfer events since the KV cursor, enriches each sale (price from the receipt, image
  from OpenSea) and posts to the `SALES_WEBHOOK_URL` channel webhook. Idempotent: the block
  cursor lives in KV, so a repeated call never double-posts.
- `.github/workflows/discord-sales.yml` calls it every five minutes for five hours per
  scheduled run (cron every three hours, GitHub's scheduler is sparse); the Cloudflare
  worker in `cloudflare/sales-heartbeat.js` pokes it once a minute as the primary trigger.
- Manual dispatch inputs: `test_id` posts one test embed for a token id; `bio_addr` reads a
  wallet's OpenSea bio (debug of the OpenSea key; nothing posted).

## Vercel environment variables
| name | value |
|---|---|
| `RECHECK_SECRET` | long random string; the same value goes to the GitHub secret and the Cloudflare worker |
| `SALES_WEBHOOK_URL` | the Discord channel webhook the embeds post to |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis (free plan): sweep cursor + image cache |
| `OPENSEA_API_KEY` | for token images and the bio debug read |

GitHub: secret `RECHECK_SECRET`, variable `DISCORD_SALES_ENABLED=1`. Cloudflare: secret
`RECHECK_SECRET` on the worker, cron `* * * * *`.

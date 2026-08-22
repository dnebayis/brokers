# Discord holder-verification bot — owner setup

The bot is serverless: Discord's Interactions webhook points at the live site, so there
is no bot process to host. The code ships with the frontend; everything below is the
one-time owner-side setup (~10 minutes). Never paste the bot token anywhere except the
places named below.

## 1. Create the Discord application
1. https://discord.com/developers/applications → **New Application** → name it (e.g. "Coattail Verify").
2. Note the **Application ID** and **Public Key** (General Information page).
3. **Bot** tab → **Reset Token** → copy the token (shown once).
4. Bot tab: leave all privileged intents OFF (none are needed).

## 2. Invite the bot & create the role
1. In your server: create a role named **Brokerage** (or reuse the existing one) and note its
   role ID (Server Settings → Roles → right-click → Copy Role ID; enable Developer Mode
   in Discord settings if you don't see it). Also copy the **server (guild) ID**.
2. Invite URL — replace APP_ID:
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=268435456`
   (268435456 = Manage Roles, the only permission it needs.)
3. IMPORTANT: in Server Settings → Roles, drag the bot's own role ABOVE the Brokerage role —
   Discord only lets a bot grant roles below its own.

## 3. Vercel environment variables (Project → Settings → Environment Variables)
| name | value |
|---|---|
| `DISCORD_BOT_TOKEN` | the bot token from step 1.3 |
| `DISCORD_PUBLIC_KEY` | the Public Key from step 1.2 |
| `DISCORD_GUILD_ID` | your server ID |
| `DISCORD_ROLE_BROKERAGE` | the Brokerage role ID |
| `VERIFY_STATE_SECRET` | any long random string (e.g. `openssl rand -hex 32`) |
| `RECHECK_SECRET` | another long random string |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | from an Upstash Redis (free tier). STRONGLY recommended: verification is address-only (no signature), and KV powers the two safeguards — the one-address-one-account claim lock and the daily sold-wallet re-check. Without KV, anyone can reuse a holder's public address. |

Redeploy after saving (envs apply on the next build).

## 4. Point Discord at the site
Developer Portal → your app → General Information → **Interactions Endpoint URL**:
`https://www.coattail.cash/api/discord/interactions`
Discord sends a test ping on save — it only accepts if the deployment with the envs is live.

## 5. Register the slash command + arm the re-check (GitHub)
```bash
gh secret set DISCORD_APPLICATION_ID
gh secret set DISCORD_BOT_TOKEN
gh secret set RECHECK_SECRET
gh variable set DISCORD_RECHECK_ENABLED --body "1"
gh workflow run discord-register-commands
```
(each `gh secret set` prompts for the value — paste it there, not on the command line)

## Done — how it works for members
`/verify` in the server → ephemeral one-time link → coattail.cash/verify → **paste wallet
address** (no connection, no signature) → on-chain balance check → Brokerage role.
Each address can only ever verify ONE Discord account (first come, first claim), and a
daily sweep removes the role from wallets that no longer hold a Broker.

Known tradeoff of address-only verification: an address is public information, so in
principle a non-holder could claim a holder's address BEFORE the real holder does. The
claim lock limits each address to one account, and the role should stay cosmetic
(channel access, flair) — never a permission that moves value.

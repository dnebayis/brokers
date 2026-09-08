# Wallet Pass (Apple Wallet)

Every Broker can be added to Apple Wallet as a card: artwork, status, what is in the wallet,
the last payout, the stocks, and links back to the chain. The card updates itself and pings
the phone when payroll lands, when the Broker is switched on or off, and when it is sold.
Nothing on it can move funds; it only reads what the chain already says.

Google Wallet is deliberately not wired yet (issuer accounts start in demo mode and need a
publishing review); the server layout leaves room for it.

## How it works

1. **Issue.** In My Brokers the owner taps *Add to Apple Wallet*. The wallet signs a short
   message naming the site, the Broker, the wallet, the chain and a 10-minute expiry
   (`src/lib/passkit/message.ts`). `POST /api/pass/<id>/issue` verifies the signature
   (EOA or ERC-1271), re-checks `ownerOf` on chain, and answers with a 15-minute signed link.
2. **Download.** `GET /api/pass/<id>/download?t=…` re-checks ownership and streams the signed
   `.pkpass`. On iOS/macOS Safari the navigation opens Apple's "Add" sheet.
3. **Register.** Once added, the phone calls the PassKit web service under `/api/passkit/v1/…`
   with the pass's `authenticationToken` (HMAC of Broker + owner, never stored) and its APNs
   push token. Registrations live in the KV store (`wp:*` keys).
4. **Sweep.** The Cloudflare heartbeat pokes `/api/pass/push` every 5 minutes (bearer
   `PASSKIT_PUSH_SECRET`, falling back to `RECHECK_SECRET`). The sweep compares the chain with
   what each registered card last showed (`src/lib/passkit/record.ts`): payouts are detected as
   growth in token *units* (a price move is never a payday), then one APNs push per phone.
5. **Refresh.** The phone fetches `GET /api/passkit/v1/passes/<type>/<serial>`; unchanged cards
   answer 304. A sold Broker's card turns `voided` ("SOLD") for the previous owner; the new
   owner issues their own, which rotates the token.

Sharing is prohibited in the pass (`sharingProhibited`) and every link on the card is a public
page, so a forwarded `.pkpass` grants nothing.

## Env (Vercel, server-side only — never `NEXT_PUBLIC_`)

| Variable | What |
|---|---|
| `PASSKIT_ENABLED` | `1` switches the feature on; absent = every pass endpoint answers 503 and the button stays hidden, whatever else is set |
| `PASSKIT_PASS_TYPE_ID` | e.g. `pass.cash.coattail.broker` (Certificates, Identifiers & Profiles → Identifiers → Pass Type IDs) |
| `PASSKIT_TEAM_ID` | the 10-character team id (Membership details) |
| `PASSKIT_SIGNER_CERT` | Pass Type ID certificate, PEM — paste raw or as base64 of the PEM |
| `PASSKIT_SIGNER_KEY` | its private key, PEM (raw or base64) |
| `PASSKIT_SIGNER_KEY_PASSPHRASE` | only if the key is encrypted |
| `PASSKIT_WWDR_CERT` | Apple Worldwide Developer Relations G4 intermediate, PEM |
| `PASSKIT_AUTH_SECRET` | 32+ random bytes as hex (`openssl rand -hex 32`) |
| `PASSKIT_ISSUER_NAME` | shown as organization (default "Coattail Brokers") |
| `PASSKIT_ISSUER_ADDRESS` | printed on the back (Apple's pass terms require name, address, contact) |
| `PASSKIT_ISSUER_EMAIL` | printed on the back |
| `PASSKIT_PUSH_SECRET` | optional; the sweep bearer (defaults to `RECHECK_SECRET`) |
| `PASSKIT_SWEEP_LIMIT` | optional; Brokers checked per sweep (default 40) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | already set for the sales bot; needed for live updates |
| `NEXT_PUBLIC_SITE_ORIGIN` | already set; the web service URL is `<origin>/api/passkit` |

**Status: built and mounted, waiting for env.** The button is in My Brokers (`ActivateTab.tsx`)
but renders nothing until `/api/pass/status` reports `apple:true`, which needs `PASSKIT_ENABLED=1`
plus the certificate variables below. Until then every pass endpoint answers 503.

Without the certificate variables the button does not render (`/api/pass/status` → `apple:false`).
Without KV, passes still issue as static cards (no web service fields in the pass).

## Getting the certificate (owner, one time, ~15 minutes)

1. developer.apple.com → Certificates, Identifiers & Profiles → **Identifiers** → `+` →
   *Pass Type IDs* → identifier `pass.cash.coattail.broker`, description "Coattail Broker".
2. Select it → **Create Certificate**. It asks for a CSR. Keychain is not needed: make the key
   and the CSR with OpenSSL (the key never leaves the machine):

   ```bash
   openssl req -new -newkey rsa:2048 -nodes -keyout signerKey.pem -out coattail-pass.certSigningRequest -subj "/CN=Coattail Pass/O=Coattail Brokers/C=TR"
   ```

   Upload the `.certSigningRequest`, download `pass.cer` next to it.
3. Convert Apple's DER certificate and fetch the WWDR G4 intermediate:

   ```bash
   openssl x509 -inform der -in pass.cer -out signerCert.pem
   ```

   ```bash
   curl -sO https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer && openssl x509 -inform der -in AppleWWDRCAG4.cer -out wwdr.pem
   ```

   The certificate subject carries the team id (`OU=`) and the pass type id (`UID=`):
   `openssl x509 -in signerCert.pem -noout -subject`.
4. Paste into Vercel as base64 so line breaks survive:

   ```bash
   base64 -i signerCert.pem | pbcopy
   ```

   (same for `signerKey.pem` and `wwdr.pem`), plus team id and pass type id. No passphrase
   variable is needed for an OpenSSL key made with `-nodes`. Generate `PASSKIT_AUTH_SECRET` with
   `openssl rand -hex 32`. Fill the issuer fields. Set `PASSKIT_ENABLED=1`. Redeploy.
5. (The owner's machine keeps these files in `~/Documents/coattail-passkit/`, outside every
   repo; `make-env.sh` there writes all the values into one `vercel.env` file to paste from.)

6. Cloudflare: the heartbeat worker (`cloudflare/sales-heartbeat.js`) gained a second cron
   trigger `*/5 * * * *`; paste the updated file and add the trigger.

The certificate expires yearly; renewing is steps 2–5 again. Apple can review or revoke a
Pass Type ID at its discretion (Program License Agreement, Attachment 5).

## Checks

- `npm test` covers the bitmap→PNG encoder, token derivation, `pass.json` content (issuer
  contact, voided state, change messages), record transitions (payout vs price move, sold),
  and a real signing round-trip with a throwaway certificate.
- Live smoke after deploy: `curl -s https://www.coattail.cash/api/pass/status` → `{"apple":true,"updates":true}`;
  then add a pass from My Brokers on an iPhone and watch `wp:serials` in KV gain the id.
- The sweep reports what it did: `curl -H "Authorization: Bearer $RECHECK_SECRET" https://www.coattail.cash/api/pass/push`.

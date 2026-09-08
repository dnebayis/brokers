import http2 from "node:http2";

// Tell Apple "this pass changed" so the phone re-fetches it. Wallet pushes authenticate with
// the Pass Type ID certificate itself (mutual TLS), topic = the pass type id, empty payload.
// Returns per-token outcomes; 410 means the device no longer has the pass and should be
// forgotten.

export type PushResult = { token: string; status: number; gone: boolean; error?: string };
export type PushType = "background" | "alert";
export type PushOptions = { pushType?: PushType; priority?: 5 | 10 };

const APNS_HOST = "https://api.push.apple.com";

/** Wallet wake-ups are silent: `background` at priority 5 is what Apple's own guidance and
 *  working implementations use; `alert` at 10 with an empty body can be dropped by iOS. */
export function pushDefaults(): Required<PushOptions> {
  const t = (process.env.PASSKIT_PUSH_TYPE ?? "").trim();
  const pushType: PushType = t === "alert" ? "alert" : "background";
  return { pushType, priority: pushType === "alert" ? 10 : 5 };
}

export async function pushPassUpdates(
  tokens: string[],
  cert: { cert: string; key: string; passphrase?: string },
  passTypeId: string,
  options: PushOptions = {},
  host = APNS_HOST,
): Promise<PushResult[]> {
  const opts = { ...pushDefaults(), ...options };
  if (tokens.length === 0) return [];
  const session = http2.connect(host, { cert: cert.cert, key: cert.key, passphrase: cert.passphrase });
  const results: PushResult[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      session.once("connect", () => resolve());
      session.once("error", reject);
    });
    for (const token of tokens) {
      results.push(await send(session, token, passTypeId, opts));
    }
  } catch (err) {
    for (const token of tokens) {
      if (!results.some((r) => r.token === token)) results.push({ token, status: 0, gone: false, error: String(err) });
    }
  } finally {
    session.close();
  }
  return results;
}

function send(session: http2.ClientHttp2Session, token: string, passTypeId: string, opts: Required<PushOptions>): Promise<PushResult> {
  return new Promise((resolve) => {
    const req = session.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      "apns-topic": passTypeId,
      "apns-push-type": opts.pushType,
      "apns-priority": String(opts.priority),
      "content-type": "application/json",
    });
    let status = 0;
    let body = "";
    const timer = setTimeout(() => {
      req.close();
      resolve({ token, status: 0, gone: false, error: "timeout" });
    }, 10_000);
    req.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      clearTimeout(timer);
      const gone = status === 410;
      resolve({ token, status, gone, error: status >= 200 && status < 300 ? undefined : body || `apns ${status}` });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      resolve({ token, status: 0, gone: false, error: String(err) });
    });
    req.end("{}");
  });
}

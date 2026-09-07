import http2 from "node:http2";

// Tell Apple "this pass changed" so the phone re-fetches it. Wallet pushes authenticate with
// the Pass Type ID certificate itself (mutual TLS), topic = the pass type id, empty payload.
// Returns per-token outcomes; 410 means the device no longer has the pass and should be
// forgotten.

export type PushResult = { token: string; status: number; gone: boolean; error?: string };

const APNS_HOST = "https://api.push.apple.com";

export async function pushPassUpdates(
  tokens: string[],
  cert: { cert: string; key: string; passphrase?: string },
  passTypeId: string,
  host = APNS_HOST,
): Promise<PushResult[]> {
  if (tokens.length === 0) return [];
  const session = http2.connect(host, { cert: cert.cert, key: cert.key, passphrase: cert.passphrase });
  const results: PushResult[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      session.once("connect", () => resolve());
      session.once("error", reject);
    });
    for (const token of tokens) {
      results.push(await send(session, token, passTypeId));
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

function send(session: http2.ClientHttp2Session, token: string, passTypeId: string): Promise<PushResult> {
  return new Promise((resolve) => {
    const req = session.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      "apns-topic": passTypeId,
      "apns-push-type": "alert",
      "apns-priority": "10",
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

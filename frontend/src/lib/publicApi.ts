import { NextResponse } from "next/server";

// The open Broker API is meant to be called from other people's code, and a partner's
// dashboard or campaign tool runs in a browser: without CORS headers the browser blocks the
// response before their JS can even read the status, so an endpoint that works perfectly from
// curl looks broken to them. These endpoints are keyless public reads of public chain state,
// so any origin may read them. Error responses carry the headers too, or a 404 arrives as an
// opaque network failure instead of "that Broker does not exist".
export const PUBLIC_API_CACHE = "public, s-maxage=3600, stale-while-revalidate=600";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** JSON response for a public endpoint: CORS always, cache only on success. */
export function publicJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: status === 200 ? { ...CORS, "Cache-Control": PUBLIC_API_CACHE } : CORS,
  });
}

/** Pre-flight for browsers that send one (any request with a custom header does). */
export function publicOptions(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

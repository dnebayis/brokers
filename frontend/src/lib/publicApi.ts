import { NextResponse } from "next/server";

// The open Broker API is meant to be called from other people's code, and a partner's
// dashboard or campaign tool runs in a browser: without CORS headers the browser blocks the
// response before their JS can even read the status, so an endpoint that works perfectly from
// curl looks broken to them. These endpoints are keyless public reads of public chain state,
// so any origin may read them. Error responses carry the headers too, or a 404 arrives as an
// opaque network failure instead of "that Broker does not exist".
export const PUBLIC_API_CACHE = "public, s-maxage=3600, stale-while-revalidate=600";

/**
 * A caller that needs fresher data than the hour default asks for it with `?ttl=<seconds>`;
 * clamped to [60, 3600] so a live page can poll once a minute without anyone being able to
 * turn the endpoint into an uncached RPC relay. Returns the Cache-Control for that ttl.
 */
export function cacheFor(request: Request | undefined): string {
  if (!request) return PUBLIC_API_CACHE;
  const raw = new URL(request.url).searchParams.get("ttl");
  if (raw === null) return PUBLIC_API_CACHE;
  const ttl = Math.min(3600, Math.max(60, Math.floor(Number(raw)) || 3600));
  return `public, s-maxage=${ttl}, stale-while-revalidate=${Math.min(600, ttl)}`;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** JSON response for a public endpoint: CORS always, cache only on success. */
export function publicJson(body: unknown, status = 200, cacheControl = PUBLIC_API_CACHE): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: status === 200 ? { ...CORS, "Cache-Control": cacheControl } : CORS,
  });
}

/** Pre-flight for browsers that send one (any request with a custom header does). */
export function publicOptions(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

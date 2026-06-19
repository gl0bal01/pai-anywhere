import { stateDir } from "../lib/paths";
import {
  canAttemptPairing,
  clearFailedPairing,
  clearSessionCookie,
  createSessionCookie,
  initRateLimiter,
  isAuthenticated,
  loadOrCreateGatewaySecrets,
  pairingCodeMatches,
  recordFailedPairing,
} from "./auth";
import type { GatewayConfig, GatewaySecrets } from "./types";

const DEFAULT_PORT = 8787;
const MAX_PAIRING_BODY_BYTES = 2048;
const MAX_PULSE_BODY_BYTES = 1_048_576; // 1 MB
const TERMINAL_ROADMAP = "https://github.com/gl0bal01/pai-anywhere/issues/1";

// Gateway-local routes (never proxied). Anything else (when authenticated) goes to Pulse.
const GATEWAY_LOCAL_PATHS = new Set([
  "/__gateway/healthz",
  "/auth/status",
  "/auth/pair",
  "/auth/logout",
  "/terminal",
]);
const ALLOWED_PULSE_METHODS = new Set(["GET", "POST", "HEAD", "OPTIONS"]);

export function gatewayConfigFromArgs(args: string[]): GatewayConfig {
  const envPairingCode = process.env.PAI_ANYWHERE_PAIRING_CODE;
  if (!envPairingCode) {
    throw new Error(
      "PAI_ANYWHERE_PAIRING_CODE is not set. "
      + "Run pai-anywhere reset-access to generate a pairing code, "
      + "then start the gateway with that code in the environment.",
    );
  }

  const portArg = valueAfter(args, "--port");
  const hostname = process.env.PAI_ANYWHERE_GATEWAY_HOST || "127.0.0.1";
  return {
    hostname,
    port: portArg ? Number.parseInt(portArg, 10) : Number.parseInt(process.env.PAI_ANYWHERE_GATEWAY_PORT || `${DEFAULT_PORT}`, 10),
    stateDir: stateDir(),
    pairingCode: envPairingCode,
    cookieSecure: process.env.PAI_ANYWHERE_COOKIE_SECURE !== "0",
    sessionTtlSeconds: Number.parseInt(process.env.PAI_ANYWHERE_SESSION_TTL_SECONDS || `${24 * 60 * 60}`, 10),
    pulseOrigin: process.env.PAI_ANYWHERE_PULSE_ORIGIN || "http://127.0.0.1:31337",
  };
}

export function startGateway(config: GatewayConfig): ReturnType<typeof Bun.serve> {
  if (!isLoopbackHost(config.hostname)) {
    throw new Error(`refusing to bind gateway to non-loopback host: ${config.hostname}`);
  }
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error(`invalid gateway port: ${config.port}`);
  }
  // Pairing codes are randomBytes(15).base64url → always exactly 20 chars.
  // (T20) The code is drawn from a CSPRNG, so no weak-pattern/dictionary check is
  // needed; rejecting anything but the exact length/alphabet is sufficient.
  if (!/^[A-Za-z0-9_\-]{20}$/.test(config.pairingCode)) {
    throw new Error("pairing code must be exactly 20 base64url characters ([A-Za-z0-9_-])");
  }
  // Fail closed if the Pulse upstream is not a loopback http origin. The gateway
  // proxies authenticated requests to pulseOrigin; an attacker who can influence
  // PAI_ANYWHERE_PULSE_ORIGIN (or a misconfiguration) could otherwise turn the
  // authenticated proxy into an SSRF primitive against an arbitrary host. Same
  // fail-closed shape as the loopback bind check above.
  assertLoopbackPulseOrigin(config.pulseOrigin);

  // Load the persisted rate-limit counter so a restart cannot reset the
  // failed-pairing window (defends against restart-induced brute force).
  initRateLimiter(config.stateDir);

  const secrets = loadOrCreateGatewaySecrets(config.stateDir);
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch: (request) => handleGatewayRequest(request, config, secrets),
  });

  // Graceful shutdown: systemd sends SIGTERM on stop/restart (SIGINT on Ctrl-C).
  // Stop accepting connections and let in-flight requests drain instead of being
  // killed mid-response.
  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`pai-anywhere gateway received ${signal}; shutting down`);
    server.stop();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(`pai-anywhere gateway listening on http://${server.hostname}:${server.port}`);
  console.log("pairing code loaded from environment; value not printed to stdout");

  return server;
}

/**
 * Validate that pulseOrigin is a loopback http origin. Throws (fail closed) if:
 *  - it is not a parseable URL,
 *  - the protocol is not exactly "http:" (no https/ftp/protocol-relative),
 *  - it carries userinfo (http://user:pass@host bypasses host checks in some
 *    parsers and is never legitimate for a loopback upstream),
 *  - the hostname is not a loopback name/address (127.0.0.0/8, ::1, localhost).
 */
export function assertLoopbackPulseOrigin(pulseOrigin: string): void {
  let url: URL;
  try {
    url = new URL(pulseOrigin);
  } catch {
    throw new Error(`invalid PAI_ANYWHERE_PULSE_ORIGIN (not a URL): ${pulseOrigin}`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`PAI_ANYWHERE_PULSE_ORIGIN must use http: (got ${url.protocol || "no protocol"})`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("PAI_ANYWHERE_PULSE_ORIGIN must not contain a username or password");
  }
  if (!isLoopbackPulseHost(url.hostname)) {
    throw new Error(`PAI_ANYWHERE_PULSE_ORIGIN host must be loopback (127.0.0.0/8, ::1, localhost): ${url.hostname}`);
  }
}

export async function handleGatewayRequest(
  request: Request,
  config: GatewayConfig,
  secrets: GatewaySecrets,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/__gateway/healthz" && request.method === "GET") {
    return json({ ok: true, service: "pai-anywhere-gateway" });
  }

  if (url.pathname === "/auth/status" && request.method === "GET") {
    return json({ authenticated: isAuthenticated(request, secrets) });
  }

  if (url.pathname === "/auth/pair" && request.method === "POST") {
    return pair(request, config, secrets);
  }

  if (url.pathname === "/auth/logout" && request.method === "POST") {
    const formLogout = (request.headers.get("content-type") || "").includes("application/x-www-form-urlencoded");
    if (formLogout) {
      return new Response(null, {
        status: 303,
        headers: {
          "location": "/",
          "set-cookie": clearSessionCookie(config),
          ...securityHeaders("text/html; charset=utf-8"),
        },
      });
    }
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(config) } });
  }

  const authenticated = isAuthenticated(request, secrets);

  // Anonymous root → pairing page
  if (url.pathname === "/" && request.method === "GET" && !authenticated) {
    return html(pairingPage());
  }

  // Anonymous everything else → 401
  if (!authenticated) {
    return json({ error: "authentication required" }, { status: 401 });
  }

  // Authenticated terminal → 410 (deferred)
  if (url.pathname === "/terminal" || url.pathname.startsWith("/terminal/")) {
    return json(
      { status: "deferred", roadmap: TERMINAL_ROADMAP },
      { status: 410 },
    );
  }

  // Authenticated everything else → proxy to Pulse upstream.
  // Pulse owns /, /_next/*, /agents, /telos, /api/*, /favicon.ico, /pai-logo.png, etc.
  return proxyPulse(request, config);
}

async function pair(request: Request, config: GatewayConfig, secrets: GatewaySecrets): Promise<Response> {
  // v0.1: single global rate-limit bucket (single-tenant home VPS).
  if (!canAttemptPairing()) {
    return json({ error: "too many pairing attempts" }, { status: 429 });
  }

  const contentType = request.headers.get("content-type") || "";
  const isMultipart = contentType.includes("multipart/form-data");
  const isUrlEncoded = contentType.includes("application/x-www-form-urlencoded");
  const formPairing = isMultipart || isUrlEncoded;

  // Fast reject on a declared oversize body…
  const contentLength = Number.parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_PAIRING_BODY_BYTES) {
    recordFailedPairing();
    return json({ error: "request body too large" }, { status: 413 });
  }

  let provided = "";
  try {
    // …then enforce the cap on the actual bytes (Content-Length is spoofable / omittable).
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_PAIRING_BODY_BYTES) {
      recordFailedPairing();
      return json({ error: "request body too large" }, { status: 413 });
    }
    if (isMultipart) {
      // Re-parse the buffered bytes as multipart without re-reading the stream.
      const form = await new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": contentType },
        body: buf,
      }).formData();
      const value = form.get("code");
      provided = typeof value === "string" ? value.trim() : "";
    } else if (isUrlEncoded) {
      const value = new URLSearchParams(new TextDecoder().decode(buf)).get("code");
      provided = value ? value.trim() : "";
    } else {
      const body = JSON.parse(new TextDecoder().decode(buf)) as unknown;
      if (body && typeof body === "object" && typeof (body as Record<string, unknown>).code === "string") {
        provided = ((body as Record<string, unknown>).code as string).trim();
      }
    }
  } catch {
    recordFailedPairing();
    return formPairing
      ? html(pairingPage("Invalid pairing request."), { status: 400 })
      : json({ error: "invalid pairing request" }, { status: 400 });
  }

  if (!pairingCodeMatches(provided, config.pairingCode)) {
    recordFailedPairing();
    return formPairing
      ? html(pairingPage("Invalid pairing code."), { status: 401 })
      : json({ error: "invalid pairing code" }, { status: 401 });
  }

  clearFailedPairing();
  const cookie = createSessionCookie(config, secrets);
  if (formPairing) {
    return new Response(null, {
      status: 303,
      headers: {
        "location": "/",
        "set-cookie": cookie,
        ...securityHeaders("text/html; charset=utf-8"),
      },
    });
  }
  return json({ ok: true }, { headers: { "set-cookie": cookie } });
}

async function proxyPulse(request: Request, config: GatewayConfig): Promise<Response> {
  // Method allowlist (defense in depth)
  if (!ALLOWED_PULSE_METHODS.has(request.method)) {
    return json({ error: "method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);

  // Reject gateway-namespace paths (must not reach Pulse)
  if (url.pathname.startsWith("/__gateway/") || GATEWAY_LOCAL_PATHS.has(url.pathname)) {
    return json({ error: "not found" }, { status: 404 });
  }

  // Reject obvious path-traversal attempts even though new URL() normalizes
  if (url.pathname.includes("..")) {
    return json({ error: "invalid path" }, { status: 400 });
  }

  // Reject protocol-relative / network-path references. A pathname beginning
  // with "//" (or backslashes that WHATWG normalizes to "//") would, if passed
  // as the first argument to `new URL(path, base)`, override the upstream host
  // and turn this proxy into an SSRF primitive (e.g. //169.254.169.254/...).
  // Pulse never serves "//"-prefixed paths, so reject them outright.
  if (url.pathname.startsWith("//")) {
    return json({ error: "invalid path" }, { status: 400 });
  }

  // Build the upstream URL from a FIXED origin and copy only path + query.
  // Never use `new URL(path, origin)` here — see the "//" host-override note above.
  const upstream = new URL(config.pulseOrigin);
  upstream.pathname = url.pathname;
  upstream.search = url.search;

  // Enforce the body cap on the actual bytes, not just the (spoofable)
  // Content-Length header. Buffer non-idempotent bodies up to the cap.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let body: ArrayBuffer | undefined;
  if (hasBody) {
    const contentLength = Number.parseInt(request.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_PULSE_BODY_BYTES) {
      return json({ error: "request body too large" }, { status: 413 });
    }
    try {
      body = await request.arrayBuffer();
    } catch {
      return json({ error: "invalid request body" }, { status: 400 });
    }
    if (body.byteLength > MAX_PULSE_BODY_BYTES) {
      return json({ error: "request body too large" }, { status: 413 });
    }
  }

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("host");
  // Defense in depth: do not let a client forge forwarding/identity headers to
  // the loopback Pulse upstream.
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  headers.delete("forwarded");
  // Body was re-buffered; let fetch recompute Content-Length from `body`.
  headers.delete("content-length");

  try {
    const upstreamRes = await fetch(upstream, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
    // (T3) Rewrite the Server header on the proxied response too so neither the
    // gateway's nor Pulse's runtime/version leaks through. Re-wrap in a fresh
    // Response because a fetch() Response's headers are immutable.
    const outHeaders = new Headers(upstreamRes.headers);
    outHeaders.set("server", "pai-anywhere");
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: outHeaders,
    });
  } catch {
    return json({ error: "pulse unavailable" }, { status: 502 });
  }
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [key, val] of Object.entries(securityHeaders("application/json; charset=utf-8"))) {
    headers.set(key, val);
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

function html(markup: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [key, val] of Object.entries(securityHeaders("text/html; charset=utf-8"))) {
    headers.set(key, val);
  }
  return new Response(markup, { ...init, headers });
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // (T19) Tailscale Serve terminates HTTPS in front of this gateway, so pin
    // HSTS for the tailnet hostname.
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    // (T3) Bun.serve advertises "Server: Bun/x.y.z" by default; overwrite it with
    // a static generic value so we never leak the runtime/version.
    "server": "pai-anywhere",
  };
}

function pairingPage(error = ""): string {
  return page("Pair pai-anywhere", `
    <main class="panel">
      <h1>pai-anywhere</h1>
      <form method="post" action="/auth/pair">
        <label for="code">Pairing code</label>
        <input id="code" name="code" autocomplete="one-time-code" pattern="[A-Za-z0-9_\\-]{20}" required autofocus>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
        <button type="submit">Pair</button>
      </form>
    </main>
  `);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f6f7f8; color: #17191c; }
    .panel { width: min(92vw, 24rem); padding: 1.5rem; border: 1px solid #d8dde3; border-radius: 8px; background: #fff; }
    h1 { margin: 0 0 1.25rem; font-size: 1.35rem; font-weight: 650; }
    label { display: block; margin-bottom: 0.45rem; font-size: 0.95rem; }
    input { box-sizing: border-box; width: 100%; min-height: 2.75rem; padding: 0.55rem 0.7rem; border: 1px solid #aeb7c2; border-radius: 6px; font: inherit; }
    button, a { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; min-height: 2.5rem; margin-top: 1rem; padding: 0.55rem 0.85rem; border: 1px solid #111827; border-radius: 6px; background: #111827; color: #fff; font: inherit; text-decoration: none; cursor: pointer; }
    nav { display: grid; gap: 0.75rem; }
    .disabled { color: #697382; }
    .error { margin: 0.75rem 0 0; color: #a31515; }
    @media (prefers-color-scheme: dark) {
      body { background: #111418; color: #eef1f5; }
      .panel { background: #191e24; border-color: #343c47; }
      input { background: #111418; color: #eef1f5; border-color: #4d5866; }
      button, a { background: #eef1f5; color: #111418; border-color: #eef1f5; }
      .disabled { color: #a8b1bd; }
      .error { color: #ffb4a8; }
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : null;
}

function isLoopbackHost(hostname: string): boolean {
  // (T15) "localhost" is intentionally accepted: it is a reserved loopback name
  // (RFC 6761) that resolves to 127.0.0.1/::1, so binding to it never exposes a
  // routable interface. Keep it alongside the literal loopback addresses.
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

/**
 * Loopback check for a URL hostname (as produced by WHATWG `new URL().hostname`).
 * Accepts the whole 127.0.0.0/8 block (not just 127.0.0.1), the IPv6 loopback
 * ::1 (which URL surfaces bracketed as "[::1]"), and the "localhost" name.
 */
function isLoopbackPulseHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  if (hostname === "[::1]" || hostname === "::1") return true;
  // 127.0.0.0/8 — any 127.x.y.z is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

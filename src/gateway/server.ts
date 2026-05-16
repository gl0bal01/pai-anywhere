import { stateDir } from "../lib/paths";
import {
  canAttemptPairing,
  clearFailedPairing,
  clearSessionCookie,
  createSessionCookie,
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
  // Validate pairing code is base64url (20 chars; also accepts wider range for flexibility)
  if (!/^[A-Za-z0-9_\-]{12,32}$/.test(config.pairingCode)) {
    throw new Error("pairing code must be 12–32 base64url characters ([A-Za-z0-9_-])");
  }

  const secrets = loadOrCreateGatewaySecrets(config.stateDir);
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch: (request) => handleGatewayRequest(request, config, secrets),
  });

  console.log(`pai-anywhere gateway listening on http://${server.hostname}:${server.port}`);
  console.log("pairing code loaded from environment; value not printed to stdout");

  return server;
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

  const contentLength = Number.parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_PAIRING_BODY_BYTES) {
    recordFailedPairing();
    return json({ error: "request body too large" }, { status: 413 });
  }

  let provided = "";
  const contentType = request.headers.get("content-type") || "";
  const formPairing = contentType.includes("application/x-www-form-urlencoded")
    || contentType.includes("multipart/form-data");
  try {
    if (formPairing) {
      const form = await request.formData();
      const value = form.get("code");
      provided = typeof value === "string" ? value.trim() : "";
    } else {
      const body = await request.json() as unknown;
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

  // Body cap
  const contentLength = Number.parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_PULSE_BODY_BYTES) {
    return json({ error: "request body too large" }, { status: 413 });
  }

  const upstream = new URL(url.pathname + url.search, config.pulseOrigin);
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("host");

  try {
    return await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
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
  };
}

function pairingPage(error = ""): string {
  return page("Pair pai-anywhere", `
    <main class="panel">
      <h1>pai-anywhere</h1>
      <form method="post" action="/auth/pair">
        <label for="code">Pairing code</label>
        <input id="code" name="code" autocomplete="one-time-code" pattern="[A-Za-z0-9_\\-]{12,32}" required autofocus>
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
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

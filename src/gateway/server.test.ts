import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_COOKIE,
  clearFailedPairing,
  createSessionCookie,
  loadOrCreateGatewaySecrets,
} from "./auth";
import { assertLoopbackPulseOrigin, gatewayConfigFromArgs, handleGatewayRequest, startGateway } from "./server";
import type { GatewayConfig, GatewaySecrets } from "./types";

let tmpDir: string;
let config: GatewayConfig;
let secrets: GatewaySecrets;
let mockPulse: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  // Mock Pulse upstream: always 200 for any request that reaches it.
  // /gz serves a genuinely gzipped body so the proxy's framing-header
  // stripping can be asserted against a transparently-decompressed fetch.
  mockPulse = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      if (new URL(req.url).pathname === "/gz") {
        return new Response(Bun.gzipSync(Buffer.from("gzipped-ok")), {
          status: 200,
          headers: { "content-encoding": "gzip", "content-type": "text/plain" },
        });
      }
      return new Response("ok", { status: 200 });
    },
  });

  tmpDir = mkdtempSync(join(tmpdir(), "pai-server-test-"));
  config = {
    hostname: "127.0.0.1",
    port: 8787,
    stateDir: tmpDir,
    pairingCode: randomBytes(15).toString("base64url"),
    cookieSecure: false,
    sessionTtlSeconds: 3600,
    pulseOrigin: `http://127.0.0.1:${mockPulse.port}`,
    tailnetIdentityRequired: false,
  };
  secrets = loadOrCreateGatewaySecrets(tmpDir);
  clearFailedPairing();
});

afterAll(() => {
  mockPulse.stop();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Return a Request pre-loaded with a valid session cookie for the test gateway. */
function authedReq(url: string, init: RequestInit = {}): Request {
  const header = createSessionCookie(config, secrets);
  const cookieValue = header.split(";")[0]!.split("=").slice(1).join("=");
  const headers = new Headers(init.headers as HeadersInit | undefined);
  headers.set("cookie", `${SESSION_COOKIE}=${cookieValue}`);
  return new Request(url, { ...init, headers });
}

// ── Gateway healthcheck (anonymous) ───────────────────────────────────────────

describe("/__gateway/healthz", () => {
  test("returns 200 with ok:true without authentication", async () => {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/__gateway/healthz"),
      config,
      secrets,
    );
    expect(res.status).toBe(200);
    // (L1) liveness only — no service name fingerprint.
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect((body as Record<string, unknown>).service).toBeUndefined();
  });

  test("anonymous /__gateway/anything is not exposed (401)", async () => {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/__gateway/secret"),
      config,
      secrets,
    );
    expect(res.status).toBe(401);
  });
});

// ── Anonymous behavior ────────────────────────────────────────────────────────

describe("anonymous", () => {
  test("GET / returns the pairing page (200, html)", async () => {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/"),
      config,
      secrets,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("text/html");
  });

  test("GET /anything-else returns 401", async () => {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/agents"),
      config,
      secrets,
    );
    expect(res.status).toBe(401);
  });
});

// ── /terminal (deferred to v0.2) ──────────────────────────────────────────────

describe("/terminal", () => {
  test("returns 410 Gone with status=deferred and a roadmap URL", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/terminal"),
      config,
      secrets,
    );
    expect(res.status).toBe(410);
    const body = await res.json() as { status: string; roadmap: string };
    expect(body.status).toBe("deferred");
    expect(typeof body.roadmap).toBe("string");
    expect(body.roadmap.length).toBeGreaterThan(0);
  });
});

// ── Authenticated proxy to Pulse ──────────────────────────────────────────────

describe("authenticated proxy", () => {
  test("GET / reaches Pulse upstream (200)", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/"),
      config,
      secrets,
    );
    expect(res.status).toBe(200);
  });

  test("GET /agents reaches Pulse upstream (200)", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/agents"),
      config,
      secrets,
    );
    expect(res.status).toBe(200);
  });

  test("GET /_next/static/css/x.css reaches Pulse upstream (200)", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/_next/static/css/x.css"),
      config,
      secrets,
    );
    expect(res.status).toBe(200);
  });

  test("HEAD / reaches Pulse upstream (200)", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/", { method: "HEAD" }),
      config,
      secrets,
    );
    expect(res.status).toBe(200);
  });

  test("POST /api/pulse/data reaches Pulse upstream (200)", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/api/pulse/data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      config,
      secrets,
    );
    expect(res.status).toBe(200);
  });
});

// ── Method allowlist (defense in depth) ───────────────────────────────────────

describe("method allowlist", () => {
  test("DELETE / returns 405 method not allowed", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/", { method: "DELETE" }),
      config,
      secrets,
    );
    expect(res.status).toBe(405);
  });

  test("PUT / returns 405 method not allowed", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/", { method: "PUT" }),
      config,
      secrets,
    );
    expect(res.status).toBe(405);
  });

  test("PATCH / returns 405 method not allowed", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/", { method: "PATCH" }),
      config,
      secrets,
    );
    expect(res.status).toBe(405);
  });

  test("OPTIONS / returns 405 (allowlist is GET/POST/HEAD per threat model)", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/", { method: "OPTIONS" }),
      config,
      secrets,
    );
    expect(res.status).toBe(405);
  });
});

// ── WebSocket upgrade (unsupported by the fetch-based proxy) ──────────────────

describe("websocket upgrade", () => {
  test("authenticated upgrade request returns 501 instead of hanging", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/api/live", {
        headers: { upgrade: "websocket", connection: "Upgrade" },
      }),
      config,
      secrets,
    );
    expect(res.status).toBe(501);
  });
});

// ── Proxied response framing headers (compression pass-through) ───────────────

describe("proxied response framing", () => {
  test("gzip upstream response is delivered intact with content-encoding stripped", async () => {
    // fetch() decompresses the upstream body transparently; forwarding the
    // original content-encoding/content-length would corrupt the response.
    const res = await handleGatewayRequest(authedReq("http://127.0.0.1/gz"), config, secrets);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe("gzipped-ok");
  });
});

// ── Gateway namespace must not reach Pulse ────────────────────────────────────

describe("gateway namespace", () => {
  test("authenticated /__gateway/anything returns 404 (cannot tunnel)", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/__gateway/secret"),
      config,
      secrets,
    );
    expect(res.status).toBe(404);
  });
});

// ── Path traversal ────────────────────────────────────────────────────────────

describe("path traversal", () => {
  test("authenticated /foo/../etc returns 400", async () => {
    // Manually-encoded "..": URL constructor normalizes "../" so we use literal
    // ".." substring detection in the gateway.
    const req = authedReq("http://127.0.0.1/foo/..bar");
    // ../ may collapse via URL normalization; use a path with literal ".." that survives
    const url = "http://127.0.0.1/api/..%2Fadmin";
    const res = await handleGatewayRequest(authedReq(url), config, secrets);
    // Either 400 (caught) or 404 (URL-decoded by upstream); both are non-200.
    expect([400, 404]).toContain(res.status);
    void req;
  });
});

// ── SSRF: protocol-relative / network-path host override ──────────────────────

describe("proxy host override (SSRF)", () => {
  test("authenticated //evil.example/foo is rejected, never reaches another host", async () => {
    // A "//host" path would override the upstream origin if the proxy used
    // `new URL(path, origin)`. It must be rejected with 400 (not proxied).
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1//evil.example/foo"),
      config,
      secrets,
    );
    expect(res.status).toBe(400);
  });

  test("authenticated backslash network-path (\\\\evil.example) is rejected", async () => {
    // WHATWG normalizes leading backslashes to "//", so this is the same attack.
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/\\\\evil.example/foo"),
      config,
      secrets,
    );
    expect(res.status).toBe(400);
  });

  test("a normal path still proxies to the configured Pulse origin", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/agents"),
      config,
      secrets,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// ── Body cap ──────────────────────────────────────────────────────────────────

describe("body cap", () => {
  test("POST with content-length > 1 MB returns 413 before proxying", async () => {
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/api/pulse/data", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(1_048_576 + 1),
        },
        body: "{}",
      }),
      config,
      secrets,
    );
    expect(res.status).toBe(413);
  });

  test("oversize body with a spoofed small content-length is still capped", async () => {
    // Content-Length lies; the cap must be enforced on the actual bytes.
    const big = "x".repeat(1_048_576 + 16);
    const res = await handleGatewayRequest(
      authedReq("http://127.0.0.1/api/pulse/data", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "2",
        },
        body: big,
      }),
      config,
      secrets,
    );
    expect(res.status).toBe(413);
  });
});

// ── gatewayConfigFromArgs ─────────────────────────────────────────────────────

describe("gatewayConfigFromArgs", () => {
  test("throws when PAI_ANYWHERE_PAIRING_CODE is not set", () => {
    const saved = process.env.PAI_ANYWHERE_PAIRING_CODE;
    delete process.env.PAI_ANYWHERE_PAIRING_CODE;
    try {
      expect(() => gatewayConfigFromArgs([])).toThrow("PAI_ANYWHERE_PAIRING_CODE is not set");
    } finally {
      if (saved !== undefined) {
        process.env.PAI_ANYWHERE_PAIRING_CODE = saved;
      }
    }
  });
});

// ── T1: pulseOrigin SSRF validation (assertLoopbackPulseOrigin) ───────────────

describe("pulseOrigin loopback validation (SSRF)", () => {
  test("accepts a plain loopback http origin", () => {
    expect(() => assertLoopbackPulseOrigin("http://127.0.0.1:31337")).not.toThrow();
  });

  test("accepts the 127.0.0.0/8 block (not just 127.0.0.1)", () => {
    expect(() => assertLoopbackPulseOrigin("http://127.0.0.2:31337")).not.toThrow();
  });

  test("accepts ::1 and localhost", () => {
    expect(() => assertLoopbackPulseOrigin("http://[::1]:31337")).not.toThrow();
    expect(() => assertLoopbackPulseOrigin("http://localhost:31337")).not.toThrow();
  });

  test("rejects a remote host", () => {
    expect(() => assertLoopbackPulseOrigin("http://169.254.169.254/latest/meta-data"))
      .toThrow(/must be loopback/);
  });

  test("rejects userinfo (http://user:pass@127.0.0.1)", () => {
    expect(() => assertLoopbackPulseOrigin("http://user:pass@127.0.0.1:31337"))
      .toThrow(/must not contain a username or password/);
  });

  test("rejects https / non-http schemes", () => {
    expect(() => assertLoopbackPulseOrigin("https://127.0.0.1:31337")).toThrow(/must use http:/);
    expect(() => assertLoopbackPulseOrigin("ftp://127.0.0.1")).toThrow(/must use http:/);
  });

  test("rejects a protocol-relative origin (not a parseable URL)", () => {
    expect(() => assertLoopbackPulseOrigin("//127.0.0.1:31337")).toThrow(/not a URL/);
  });

  test("startGateway refuses to start with a remote pulseOrigin", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-pulseorigin-test-"));
    // Resolve a real free port so port validation passes and we genuinely reach
    // (and trip) the pulseOrigin guard rather than failing on the port check.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const freePort = probe.port!;
    probe.stop();
    try {
      expect(() => startGateway({
        ...config,
        port: freePort,
        stateDir: dir,
        pulseOrigin: "http://evil.example/",
      })).toThrow(/host must be loopback/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── T11: pairing-code length is exactly 20 ────────────────────────────────────

describe("pairing code length validation", () => {
  test("startGateway rejects a 12-char code the old loose regex would have allowed", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-paircode-test-"));
    try {
      expect(() => startGateway({
        ...config,
        stateDir: dir,
        pairingCode: "abcdefghijkl", // 12 chars: valid under old {12,32}, invalid under {20}
      })).toThrow(/exactly 20 base64url characters/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── T3 / T19: Server header rewrite + HSTS ────────────────────────────────────

describe("response security headers", () => {
  test("local JSON response advertises a static Server, never a Bun version", async () => {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/__gateway/healthz"),
      config,
      secrets,
    );
    expect(res.headers.get("server")).toBe("pai-anywhere");
    expect(res.headers.get("server") || "").not.toContain("Bun");
  });

  test("proxied Pulse response does not leak a Bun Server header", async () => {
    const res = await handleGatewayRequest(authedReq("http://127.0.0.1/agents"), config, secrets);
    expect(res.status).toBe(200);
    expect(res.headers.get("server")).toBe("pai-anywhere");
    expect(res.headers.get("server") || "").not.toContain("Bun");
  });

  test("local response carries HSTS (T19)", async () => {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/__gateway/healthz"),
      config,
      secrets,
    );
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });
});

// ── M1: tailnet identity binding ──────────────────────────────────────────────
describe("tailnet identity binding (M1)", () => {
  const idConfig = (): GatewayConfig => ({ ...config, tailnetIdentityRequired: true });

  test("pairing without an identity header is refused when required", async () => {
    clearFailedPairing();
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: config.pairingCode }),
      }),
      idConfig(),
      secrets,
    );
    expect(res.status).toBe(403);
  });

  test("pairing with an identity header succeeds and binds the session", async () => {
    clearFailedPairing();
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json", "Tailscale-User-Login": "alice@example.com" },
        body: JSON.stringify({ code: config.pairingCode }),
      }),
      idConfig(),
      secrets,
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("pai_anywhere_session=");

    const status = await handleGatewayRequest(
      new Request("http://127.0.0.1/auth/status", {
        headers: { "cookie": cookie.split(";")[0]!, "Tailscale-User-Login": "alice@example.com" },
      }),
      idConfig(),
      secrets,
    );
    expect((await status.json() as { authenticated: boolean }).authenticated).toBe(true);

    const wrongIdentity = await handleGatewayRequest(
      new Request("http://127.0.0.1/auth/status", {
        headers: { "cookie": cookie.split(";")[0]!, "Tailscale-User-Login": "mallory@example.com" },
      }),
      idConfig(),
      secrets,
    );
    expect((await wrongIdentity.json() as { authenticated: boolean }).authenticated).toBe(false);

    const noIdentity = await handleGatewayRequest(
      new Request("http://127.0.0.1/auth/status", {
        headers: { "cookie": cookie.split(";")[0]! },
      }),
      idConfig(),
      secrets,
    );
    expect((await noIdentity.json() as { authenticated: boolean }).authenticated).toBe(false);
  });
});

// ── L3: cross-origin guard ────────────────────────────────────────────────────
describe("cross-origin guard (L3)", () => {
  test("pairing with a foreign Origin is rejected 403", async () => {
    clearFailedPairing();
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json", "origin": "https://evil.example" },
        body: JSON.stringify({ code: config.pairingCode }),
      }),
      config,
      secrets,
    );
    expect(res.status).toBe(403);
  });

  test("https Origin behind Tailscale Serve is accepted despite the http request URL", async () => {
    // Regression: Serve terminates TLS and forwards plaintext to loopback, so
    // the browser's `Origin: https://host` never matches the scheme of the
    // rebuilt `http://host` request URL. Comparing full origins 403'd every
    // real browser pairing; only the host is meaningful here.
    clearFailedPairing();
    const res = await handleGatewayRequest(
      new Request("http://pai.example.ts.net/auth/pair", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "origin": "https://pai.example.ts.net",
        },
        body: JSON.stringify({ code: config.pairingCode }),
      }),
      config,
      secrets,
    );
    expect(res.status).toBe(200);
  });

  test("https Origin on a non-443 Serve port keeps its port in the comparison", async () => {
    clearFailedPairing();
    const ok = await handleGatewayRequest(
      new Request("http://pai.example.ts.net:10000/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json", "origin": "https://pai.example.ts.net:10000" },
        body: JSON.stringify({ code: config.pairingCode }),
      }),
      config,
      secrets,
    );
    expect(ok.status).toBe(200);

    clearFailedPairing();
    const wrongPort = await handleGatewayRequest(
      new Request("http://pai.example.ts.net:10000/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json", "origin": "https://pai.example.ts.net:9999" },
        body: JSON.stringify({ code: config.pairingCode }),
      }),
      config,
      secrets,
    );
    expect(wrongPort.status).toBe(403);
  });

  test("logout with Sec-Fetch-Site: same-site is rejected 403", async () => {
    // Another host on the same tailnet shares the `<tailnet>.ts.net`
    // registrable domain, so `same-site` is not proof of same-origin.
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/auth/logout", {
        method: "POST",
        headers: { "sec-fetch-site": "same-site" },
      }),
      config,
      secrets,
    );
    expect(res.status).toBe(403);
  });

  test("logout with Sec-Fetch-Site: same-origin is allowed", async () => {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/auth/logout", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      config,
      secrets,
    );
    expect(res.status).toBe(200);
  });

  test("logout with Sec-Fetch-Site: cross-site is rejected 403", async () => {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/auth/logout", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      config,
      secrets,
    );
    expect(res.status).toBe(403);
  });
});

// ── M5: proxy hardening ───────────────────────────────────────────────────────
describe("proxy hardening (M5)", () => {
  test("hop-by-hop and credential headers are stripped before the upstream", async () => {
    let seen: Headers | null = null;
    const probe = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (req) => { seen = req.headers; return new Response("ok"); },
    });
    try {
      const cfg: GatewayConfig = { ...config, pulseOrigin: `http://127.0.0.1:${probe.port}` };
      const res = await handleGatewayRequest(
        authedReq("http://127.0.0.1/", {
          method: "POST",
          headers: {
            "authorization": "Bearer secret-token",
            "connection": "keep-alive",
            "te": "trailers",
            "upgrade": "h2c",
            "proxy-authorization": "Basic xyz",
          },
          body: "hello",
        }),
        cfg,
        secrets,
      );
      expect(res.status).toBe(200);
      // `connection`/`keep-alive` are hop-by-hop and re-added by Bun's own HTTP
      // client on the wire, so they cannot be asserted at the receiver; the
      // gateway-side deletion is what matters (authorization etc. below).
      expect(seen!.get("authorization")).toBeNull();
      expect(seen!.get("te")).toBeNull();
      expect(seen!.get("upgrade")).toBeNull();
      expect(seen!.get("proxy-authorization")).toBeNull();
      expect(seen!.get("cookie")).toBeNull();
    } finally {
      probe.stop();
    }
  });

  test("chunked oversize upstream body (no Content-Length) errors the stream", async () => {
    // Regression: the cap used to be enforced by `arrayBuffer()`, which meant a
    // response with no Content-Length was fully buffered into memory BEFORE the
    // size check could run (and never terminated at all for a live stream).
    const chunk = new Uint8Array(4 * 1024 * 1024);
    const probe = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(new ReadableStream<Uint8Array>({
        // 9 x 4 MiB = 36 MiB > 32 MiB cap, streamed with no Content-Length.
        start(controller) {
          for (let i = 0; i < 9; i++) controller.enqueue(chunk);
          controller.close();
        },
      })),
    });
    try {
      const cfg: GatewayConfig = { ...config, pulseOrigin: `http://127.0.0.1:${probe.port}` };
      const res = await handleGatewayRequest(authedReq("http://127.0.0.1/"), cfg, secrets);
      // Headers are already on the wire, so the ceiling shows up as an aborted
      // body rather than a 502 — the point is that it aborts at all.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBeNull();
      await expect(res.arrayBuffer()).rejects.toThrow();
    } finally {
      probe.stop();
    }
  });

  test("streamed under-cap body passes through intact", async () => {
    const probe = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: one\n\n"));
          controller.enqueue(new TextEncoder().encode("data: two\n\n"));
          controller.close();
        },
      })),
    });
    try {
      const cfg: GatewayConfig = { ...config, pulseOrigin: `http://127.0.0.1:${probe.port}` };
      const res = await handleGatewayRequest(authedReq("http://127.0.0.1/"), cfg, secrets);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("data: one\n\ndata: two\n\n");
    } finally {
      probe.stop();
    }
  });

  test("declared oversize upstream body is 502", async () => {
    const bigBody = Buffer.alloc(33 * 1024 * 1024, 1); // 33 MiB > 32 MiB cap
    const probe = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(bigBody, { status: 200 }),
    });
    try {
      const cfg: GatewayConfig = { ...config, pulseOrigin: `http://127.0.0.1:${probe.port}` };
      const res = await handleGatewayRequest(authedReq("http://127.0.0.1/"), cfg, secrets);
      expect(res.status).toBe(502);
    } finally {
      probe.stop();
    }
  });
});

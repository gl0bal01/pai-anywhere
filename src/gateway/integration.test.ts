import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFailedPairing } from "./auth";
import { startGateway } from "./server";
import type { GatewayConfig } from "./types";

/**
 * Ask the OS for a free TCP port by briefly binding to port 0, recording the
 * assigned port, then stopping. startGateway rejects port 0, so we resolve an
 * actual port number before calling it.
 */
function probeFreePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop();
  return port;
}

describe("reset-access: rotating secrets invalidates existing session cookies", () => {
  test("cookie issued before secret rotation is rejected after gateway restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-integ-test-"));
    const pairingCode = randomBytes(15).toString("base64url");
    clearFailedPairing();

    const baseConfig: GatewayConfig = {
      hostname: "127.0.0.1",
      port: probeFreePort(), // resolved before startGateway validates it
      stateDir: dir,
      pairingCode,
      cookieSecure: false,
      sessionTtlSeconds: 3600,
      pulseOrigin: "http://127.0.0.1:1", // nothing listening; only auth flow tested here
    };

    // ── Step 1: start first gateway and pair ───────────────────────────────────
    const server1 = startGateway(baseConfig);
    const base1 = `http://127.0.0.1:${server1.port}`;

    const pairRes = await fetch(`${base1}/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
    });
    expect(pairRes.status).toBe(200);

    const setCookieHeader = pairRes.headers.get("set-cookie") ?? "";
    expect(setCookieHeader.length).toBeGreaterThan(0);
    // Extract "pai_anywhere_session=<value>" (drop the attributes after the first semicolon)
    const cookieKV = setCookieHeader.split(";")[0] ?? "";

    // ── Step 2: confirm cookie is valid against first gateway ──────────────────
    const statusRes1 = await fetch(`${base1}/auth/status`, {
      headers: { cookie: cookieKV },
    });
    const body1 = await statusRes1.json() as { authenticated: boolean };
    expect(body1.authenticated).toBe(true);

    // ── Step 3: stop first gateway and rotate the session secret ──────────────
    // Simulates `pai-anywhere reset-access`: delete secrets file so next start
    // generates a new HMAC key, invalidating all existing cookies.
    server1.stop();
    unlinkSync(join(dir, "gateway-secrets.json"));

    // ── Step 4: restart gateway — new secrets file is created on startup ───────
    clearFailedPairing();
    const server2 = startGateway({ ...baseConfig, port: probeFreePort() });
    const base2 = `http://127.0.0.1:${server2.port}`;

    // ── Step 5: old cookie must be rejected by the new gateway ────────────────
    const statusRes2 = await fetch(`${base2}/auth/status`, {
      headers: { cookie: cookieKV },
    });
    const body2 = await statusRes2.json() as { authenticated: boolean };
    expect(body2.authenticated).toBe(false);

    // ── Cleanup ───────────────────────────────────────────────────────────────
    server2.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

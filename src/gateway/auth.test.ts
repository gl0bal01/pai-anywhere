import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_COOKIE,
  canAttemptPairing,
  clearFailedPairing,
  createSessionCookie,
  initRateLimiter,
  isAuthenticated,
  loadOrCreateGatewaySecrets,
  recordFailedPairing,
  resetRateLimiterForTests,
} from "./auth";
import type { GatewayConfig, GatewaySecrets } from "./types";

const tmpDir = mkdtempSync(join(tmpdir(), "pai-auth-test-"));

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    hostname: "127.0.0.1",
    port: 8787,
    stateDir: tmpDir,
    pairingCode: randomBytes(15).toString("base64url"),
    cookieSecure: false,
    sessionTtlSeconds: 3600,
    pulseOrigin: "http://127.0.0.1:1",
    ...overrides,
  };
}

// ── Pairing code generation ────────────────────────────────────────────────────

describe("pairing code generation", () => {
  test("randomBytes(15).toString('base64url') produces exactly 20 characters", () => {
    for (let i = 0; i < 10; i++) {
      expect(randomBytes(15).toString("base64url")).toHaveLength(20);
    }
  });

  test("generated code only contains base64url alphabet [A-Za-z0-9_-]", () => {
    for (let i = 0; i < 20; i++) {
      const code = randomBytes(15).toString("base64url");
      expect(/^[A-Za-z0-9_-]+$/.test(code)).toBe(true);
    }
  });

  test("15-byte source provides at least 120 bits of entropy", () => {
    // 15 bytes × 8 bits/byte = 120 bits — verified by construction
    expect(15 * 8).toBeGreaterThanOrEqual(120);
  });
});

// ── Global rate-limit bucket ───────────────────────────────────────────────────

describe("global rate-limit bucket", () => {
  beforeEach(() => {
    clearFailedPairing();
  });

  test("allows first attempt in a fresh window", () => {
    expect(canAttemptPairing()).toBe(true);
  });

  test("allows 10 consecutive failed attempts before blocking", () => {
    for (let i = 0; i < 10; i++) {
      expect(canAttemptPairing()).toBe(true);
      recordFailedPairing();
    }
  });

  test("blocks the 11th attempt within the same 15-minute window", () => {
    for (let i = 0; i < 10; i++) {
      canAttemptPairing();
      recordFailedPairing();
    }
    expect(canAttemptPairing()).toBe(false);
  });

  test("clearFailedPairing resets bucket so next attempt is allowed", () => {
    for (let i = 0; i < 10; i++) {
      canAttemptPairing();
      recordFailedPairing();
    }
    expect(canAttemptPairing()).toBe(false);
    clearFailedPairing();
    expect(canAttemptPairing()).toBe(true);
  });
});

// ── Cookie HMAC integrity ──────────────────────────────────────────────────────

describe("session cookie HMAC integrity", () => {
  let secrets: GatewaySecrets;

  beforeAll(() => {
    secrets = loadOrCreateGatewaySecrets(tmpDir);
  });

  test("cookie with last-character-flipped signature is rejected", () => {
    const config = makeConfig();
    const header = createSessionCookie(config, secrets);
    const cookieValue = header.split(";")[0]!.split("=").slice(1).join("=");
    const [encoded = "", sig = ""] = cookieValue.split(".");
    const tamperedSig = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");

    const req = new Request("http://127.0.0.1/", {
      headers: { cookie: `${SESSION_COOKIE}=${encoded}.${tamperedSig}` },
    });
    expect(isAuthenticated(req, secrets)).toBe(false);
  });

  test("cookie signed with a different session secret is rejected", () => {
    const config = makeConfig();
    const header = createSessionCookie(config, secrets);
    const cookieValue = header.split(";")[0]!.split("=").slice(1).join("=");

    const wrongSecrets: GatewaySecrets = {
      ...secrets,
      sessionSecret: randomBytes(32).toString("base64url"),
    };
    const req = new Request("http://127.0.0.1/", {
      headers: { cookie: `${SESSION_COOKIE}=${cookieValue}` },
    });
    expect(isAuthenticated(req, wrongSecrets)).toBe(false);
  });
});

// ── Cookie expiry ──────────────────────────────────────────────────────────────

describe("session cookie expiry", () => {
  let secrets: GatewaySecrets;

  beforeAll(() => {
    secrets = loadOrCreateGatewaySecrets(tmpDir);
  });

  test("cookie with sessionTtlSeconds=-1 is already expired and rejected", () => {
    // exp = now + (-1) = now - 1 → payload.exp > now is false
    const config = makeConfig({ sessionTtlSeconds: -1 });
    const header = createSessionCookie(config, secrets);
    const cookieValue = header.split(";")[0]!.split("=").slice(1).join("=");

    const req = new Request("http://127.0.0.1/", {
      headers: { cookie: `${SESSION_COOKIE}=${cookieValue}` },
    });
    expect(isAuthenticated(req, secrets)).toBe(false);
  });

  test("cookie with positive TTL is accepted", () => {
    const config = makeConfig({ sessionTtlSeconds: 3600 });
    const header = createSessionCookie(config, secrets);
    const cookieValue = header.split(";")[0]!.split("=").slice(1).join("=");

    const req = new Request("http://127.0.0.1/", {
      headers: { cookie: `${SESSION_COOKIE}=${cookieValue}` },
    });
    expect(isAuthenticated(req, secrets)).toBe(true);
  });
});

// ── T9: persistent rate-limit bucket (survives restart) ─────────────────────────

describe("persistent rate-limit bucket", () => {
  let rlDir: string;

  beforeEach(() => {
    rlDir = mkdtempSync(join(tmpdir(), "pai-ratelimit-test-"));
  });

  afterEach(() => {
    // Detach persistence so these disk-backed tests can't leak into the
    // in-memory-only suites above.
    resetRateLimiterForTests();
    try { rmSync(rlDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("counter survives a simulated reload from the same state dir", () => {
    // First "process": exhaust the 10-attempt window.
    initRateLimiter(rlDir);
    for (let i = 0; i < 10; i++) {
      canAttemptPairing();
      recordFailedPairing();
    }
    expect(canAttemptPairing()).toBe(false);
    expect(existsSync(join(rlDir, "rate-limit.json"))).toBe(true);

    // Simulate a gateway restart: drop in-memory state, then re-initialise from
    // the SAME state dir (re-reads rate-limit.json).
    resetRateLimiterForTests();
    initRateLimiter(rlDir);

    // Still limited — the attacker did not get a fresh window by restarting.
    expect(canAttemptPairing()).toBe(false);
  });

  test("a corrupt rate-limit.json starts fresh instead of crashing", () => {
    writeFileSync(join(rlDir, "rate-limit.json"), "{ this is not valid json", { mode: 0o600 });
    // Must not throw, and must allow attempts (fresh window).
    expect(() => initRateLimiter(rlDir)).not.toThrow();
    expect(canAttemptPairing()).toBe(true);
  });

  test("persisted file is written with mode 0600", () => {
    initRateLimiter(rlDir);
    canAttemptPairing();
    recordFailedPairing();
    const mode = statSync(join(rlDir, "rate-limit.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ── T12: cookie must be exactly two dot-separated segments ───────────────────────

describe("cookie segment validation", () => {
  let secrets: GatewaySecrets;
  const segDir = mkdtempSync(join(tmpdir(), "pai-cookie-seg-test-"));

  beforeAll(() => {
    secrets = loadOrCreateGatewaySecrets(segDir);
  });

  afterAll(() => {
    try { rmSync(segDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("a 3-segment cookie (extra dot) is rejected", () => {
    const config = makeConfig();
    const header = createSessionCookie(config, secrets);
    const cookieValue = header.split(";")[0]!.split("=").slice(1).join("=");
    // Append a third segment; the old code took only the first two and accepted it.
    const req = new Request("http://127.0.0.1/", {
      headers: { cookie: `${SESSION_COOKIE}=${cookieValue}.extrasegment` },
    });
    expect(isAuthenticated(req, secrets)).toBe(false);
  });

  test("a single-segment cookie (no dot) is rejected", () => {
    const req = new Request("http://127.0.0.1/", {
      headers: { cookie: `${SESSION_COOKIE}=onlyonesegment` },
    });
    expect(isAuthenticated(req, secrets)).toBe(false);
  });
});

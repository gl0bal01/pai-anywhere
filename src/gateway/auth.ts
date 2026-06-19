import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayConfig, GatewaySecrets, SessionPayload } from "./types";

export const SESSION_COOKIE = "pai_anywhere_session";

type AttemptBucket = {
  count: number;
  resetAt: number;
};

// v0.1: single-tenant home VPS; global bucket.
// Tailscale-User-Login per-user rate-limit upgrade deferred to v0.2.
const GLOBAL_KEY = "global";
const attemptBuckets = new Map<string, AttemptBucket>();
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// Write-through persistence target for the rate-limit bucket. The in-memory
// Map above stays the hot path; whenever the bucket changes we mirror it here so
// the failed-pairing counter survives a gateway restart (systemd
// Restart=on-failure). Without this an attacker can reset the 10-attempt window
// by inducing restarts and brute-force the pairing code. Null until
// initRateLimiter() wires a STATE_DIR (kept null in unit tests that exercise the
// pure in-memory bucket so they touch no disk).
const RATE_LIMIT_FILE = "rate-limit.json";
let rateLimitPath: string | null = null;

export function loadOrCreateGatewaySecrets(stateDir: string): GatewaySecrets {
  const path = secretsPath(stateDir);
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isGatewaySecrets(parsed)) return parsed;
    throw new Error(`gateway secrets file is invalid: ${path}`);
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const secrets: GatewaySecrets = {
    schema: "pai-anywhere.gateway-secrets.v1",
    createdAt: new Date().toISOString(),
    sessionSecret: randomBytes(32).toString("base64url"),
  };
  writeJsonAtomic(path, secrets, 0o600);
  return secrets;
}

export function createSessionCookie(config: GatewayConfig, secrets: GatewaySecrets): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    schema: "pai-anywhere.session.v1",
    iat: now,
    exp: now + config.sessionTtlSeconds,
    nonce: randomBytes(16).toString("base64url"),
  };
  const value = signPayload(payload, secrets.sessionSecret);
  const secure = config.cookieSecure ? "; Secure" : "";
  // No Domain attribute by design: omitting it makes the cookie host-only, so it
  // is never sent to sibling subdomains of the tailnet name. Host-only is the
  // tighter scope here; do not add a Domain.
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionTtlSeconds}${secure}`;
}

export function clearSessionCookie(config: GatewayConfig): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export function isAuthenticated(request: Request, secrets: GatewaySecrets): boolean {
  const value = readCookie(request, SESSION_COOKIE);
  if (!value) return false;
  const payload = verifyPayload(value, secrets.sessionSecret);
  if (!payload) return false;
  return payload.exp > Math.floor(Date.now() / 1000);
}

/**
 * Wire the rate-limit bucket to a write-through persistence file under stateDir
 * and load any existing counter state from disk. Called once at gateway startup
 * so a restart cannot reset the failed-pairing window. The file is created 0600
 * and owned by the gateway process user (STATE_DIR is already in the unit's
 * systemd ReadWritePaths). A missing or corrupt file starts fresh.
 */
export function initRateLimiter(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  rateLimitPath = join(stateDir, RATE_LIMIT_FILE);
  const loaded = loadRateLimitBucket(rateLimitPath);
  if (loaded) {
    attemptBuckets.set(GLOBAL_KEY, loaded);
  } else {
    attemptBuckets.delete(GLOBAL_KEY);
  }
}

export function canAttemptPairing(): boolean {
  const now = Date.now();
  const bucket = attemptBuckets.get(GLOBAL_KEY);
  if (!bucket || bucket.resetAt <= now) {
    setBucket({ count: 0, resetAt: now + ATTEMPT_WINDOW_MS });
    return true;
  }
  return bucket.count < MAX_ATTEMPTS;
}

export function recordFailedPairing(): void {
  const now = Date.now();
  const bucket = attemptBuckets.get(GLOBAL_KEY);
  if (!bucket || bucket.resetAt <= now) {
    setBucket({ count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  bucket.count += 1;
  setBucket(bucket);
}

export function clearFailedPairing(): void {
  attemptBuckets.delete(GLOBAL_KEY);
  if (rateLimitPath) removeRateLimitFile(rateLimitPath);
}

/**
 * Test-only: clear the in-memory bucket and detach the persistence file so a
 * suite that exercised disk-backed limiting cannot leak `rateLimitPath` into
 * other tests. Not used by production code.
 */
export function resetRateLimiterForTests(): void {
  attemptBuckets.delete(GLOBAL_KEY);
  rateLimitPath = null;
}

function setBucket(bucket: AttemptBucket): void {
  attemptBuckets.set(GLOBAL_KEY, bucket);
  if (rateLimitPath) persistRateLimitBucket(rateLimitPath, bucket);
}

function loadRateLimitBucket(path: string): AttemptBucket | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isAttemptBucket(parsed) ? parsed : null;
  } catch {
    // Corrupt/unreadable file → start fresh rather than crash-loop the gateway.
    return null;
  }
}

function persistRateLimitBucket(path: string, bucket: AttemptBucket): void {
  try {
    writeJsonAtomic(path, bucket, 0o600);
  } catch {
    // Persistence is best-effort; a write failure must not break pairing. The
    // in-memory bucket remains authoritative for the current process lifetime.
  }
}

function removeRateLimitFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best effort */
  }
}

function isAttemptBucket(value: unknown): value is AttemptBucket {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.count === "number"
    && Number.isFinite(candidate.count)
    && typeof candidate.resetAt === "number"
    && Number.isFinite(candidate.resetAt);
}

export function pairingCodeMatches(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

function signPayload(payload: SessionPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
}

function verifyPayload(value: string, secret: string): SessionPayload | null {
  // A valid cookie is exactly "<base64url-payload>.<base64url-signature>".
  // base64url never contains ".", so a token with any other number of segments
  // is malformed — reject it outright rather than silently using the first two.
  const segments = value.split(".");
  if (segments.length !== 2) return null;
  const [encoded, providedSignature] = segments;
  if (!encoded || !providedSignature) return null;
  const expectedSignature = signature(encoded, secret);
  const providedBytes = Buffer.from(providedSignature);
  const expectedBytes = Buffer.from(expectedSignature);
  if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return isSessionPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function signature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=");
  }
  return null;
}

function secretsPath(stateDir: string): string {
  return join(stateDir, "gateway-secrets.json");
}

function writeJsonAtomic(path: string, value: unknown, mode: number): void {
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tempPath, path);
}

function isGatewaySecrets(value: unknown): value is GatewaySecrets {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schema === "pai-anywhere.gateway-secrets.v1"
    && typeof candidate.createdAt === "string"
    && typeof candidate.sessionSecret === "string"
    && candidate.sessionSecret.length >= 32;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schema === "pai-anywhere.session.v1"
    && typeof candidate.iat === "number"
    && typeof candidate.exp === "number"
    && typeof candidate.nonce === "string";
}

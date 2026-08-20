import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayConfig, GatewaySecrets, SessionPayload } from "./types";

export const SESSION_COOKIE = "pai_anywhere_session";
// (L9) With Secure cookies (the default behind Tailscale Serve HTTPS) use the
// __Host- prefix: the browser then refuses the cookie unless it is Secure,
// Path=/, and Domain-less — hardening against subdomain/sibling injection.
// The plain name remains for cookieSecure=0 (local http testing), where a
// browser would reject a __Host- cookie outright.
export const SECURE_SESSION_COOKIE = "__Host-pai_anywhere_session";

export function sessionCookieName(config: GatewayConfig): string {
  return config.cookieSecure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

type AttemptBucket = {
  count: number;
  resetAt: number;
};

// (M2) Per-source rate limiting: the bucket is keyed by the caller's tailnet
// identity (Tailscale-User-Login, set by Tailscale Serve and unforgeable by the
// client once Serve strips incoming copies), falling back to the socket remote
// address, and finally to a single global bucket when neither is available
// (handler invoked directly in tests). This replaces the v0.1 global bucket so
// one noisy tailnet device cannot lock every other source out of pairing.
export const GLOBAL_KEY = "global";
type RateLimitFile = {
  schema: "pai-anywhere.rate-limit.v2";
  buckets: Record<string, AttemptBucket>;
};
// Every bucket mutation rewrites the whole persistence file, so this bound is
// also the write-amplification bound: 256 buckets is ~15 KB per failed pairing
// attempt, and far more distinct sources than a single-tenant tailnet has.
const MAX_BUCKETS = 256;
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

export function createSessionCookie(config: GatewayConfig, secrets: GatewaySecrets, tailnetLogin = ""): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    schema: "pai-anywhere.session.v1",
    iat: now,
    exp: now + config.sessionTtlSeconds,
    nonce: randomBytes(16).toString("base64url"),
    // (M1) Bind the session to the pairing client's tailnet identity: a stolen
    // cookie replayed from a different tailnet user fails isAuthenticated even
    // though its signature is valid. Stored as a sha256 digest so the payload
    // never carries the raw login.
    ...(tailnetLogin ? { sub: hashIdentity(tailnetLogin) } : {}),
  };
  const value = signPayload(payload, secrets.sessionSecret);
  const secure = config.cookieSecure ? "; Secure" : "";
  // No Domain attribute by design: omitting it makes the cookie host-only, so it
  // is never sent to sibling subdomains of the tailnet name. Host-only is the
  // tighter scope here; do not add a Domain. (Path=/ is also required for the
  // __Host- prefix to be accepted.)
  return `${sessionCookieName(config)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionTtlSeconds}${secure}`;
}

export function clearSessionCookie(config: GatewayConfig): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${sessionCookieName(config)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export function isAuthenticated(
  request: Request,
  secrets: GatewaySecrets,
  tailnetIdentityRequired = false,
): boolean {
  // Accept either cookie name: which one was set depends on cookieSecure at
  // issue time, and verification is signature-based either way.
  const value = readCookie(request, SECURE_SESSION_COOKIE) ?? readCookie(request, SESSION_COOKIE);
  if (!value) return false;
  const payload = verifyPayload(value, secrets.sessionSecret);
  if (!payload) return false;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return false;
  // (M1) When identity binding is required the request must carry the same
  // tailnet login the session was paired with. Cookies issued before this
  // feature (no sub) are rejected while required — reset-access re-pairs.
  if (tailnetIdentityRequired) {
    if (!payload.sub) return false;
    const current = hashIdentity(tailnetIdentityHeader(request));
    return digestEqual(payload.sub, current);
  }
  return true;
}

/**
 * The tailnet identity Tailscale Serve stamps on the request (empty when the
 * header is absent — e.g. tailnets without user isolation, or local testing).
 */
export function tailnetIdentityHeader(request: Request): string {
  return (request.headers.get("Tailscale-User-Login") ?? "").trim();
}

/** sha256 hex digest of a tailnet login (used for session binding + comparison). */
export function hashIdentity(login: string): string {
  return createHash("sha256").update(login, "utf8").digest("hex");
}

function digestEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "utf8");
  const b = Buffer.from(bHex, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
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
  const loaded = loadRateLimitFile(rateLimitPath);
  attemptBuckets.clear();
  for (const [key, bucket] of Object.entries(loaded)) {
    if (bucket.resetAt > Date.now()) attemptBuckets.set(key, bucket);
  }
}

export function canAttemptPairing(sourceKey = GLOBAL_KEY): boolean {
  const now = Date.now();
  const bucket = attemptBuckets.get(sourceKey);
  if (!bucket || bucket.resetAt <= now) {
    setBucket(sourceKey, { count: 0, resetAt: now + ATTEMPT_WINDOW_MS });
    return true;
  }
  return bucket.count < MAX_ATTEMPTS;
}

export function recordFailedPairing(sourceKey = GLOBAL_KEY): void {
  const now = Date.now();
  const bucket = attemptBuckets.get(sourceKey);
  if (!bucket || bucket.resetAt <= now) {
    setBucket(sourceKey, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  bucket.count += 1;
  setBucket(sourceKey, bucket);
}

export function clearFailedPairing(sourceKey = GLOBAL_KEY): void {
  attemptBuckets.delete(sourceKey);
  if (rateLimitPath && attemptBuckets.size === 0) removeRateLimitFile(rateLimitPath);
  else if (rateLimitPath) persistRateLimitFile(rateLimitPath);
}

/**
 * Test-only: clear the in-memory buckets and detach the persistence file so a
 * suite that exercised disk-backed limiting cannot leak `rateLimitPath` into
 * other tests. Not used by production code.
 */
export function resetRateLimiterForTests(): void {
  attemptBuckets.clear();
  rateLimitPath = null;
}

function setBucket(sourceKey: string, bucket: AttemptBucket): void {
  attemptBuckets.set(sourceKey, bucket);
  evictStaleBuckets();
  if (rateLimitPath) persistRateLimitFile(rateLimitPath);
}

/**
 * Bound the map so a flood of distinct source keys (many tailnet identities or
 * spoofed IPs) cannot grow memory unboundedly: drop expired buckets first,
 * then the bucket with the oldest resetAt. Callers add at most one bucket per
 * invocation, so the overflow loop runs at most once and this stays O(n).
 *
 * Eviction is itself a (bounded) rate-limit bypass: a flood of fresh keys can
 * push out a saturated bucket. Accepted — the pairing code carries >=120 bits
 * of entropy, so the limiter is anti-noise, not the thing standing between an
 * attacker and the code.
 */
function evictStaleBuckets(): void {
  const now = Date.now();
  for (const [key, bucket] of attemptBuckets) {
    if (bucket.resetAt <= now) attemptBuckets.delete(key);
  }
  while (attemptBuckets.size > MAX_BUCKETS) {
    let oldestKey: string | null = null;
    let oldestReset = Infinity;
    for (const [key, bucket] of attemptBuckets) {
      if (bucket.resetAt < oldestReset) { oldestReset = bucket.resetAt; oldestKey = key; }
    }
    if (!oldestKey) break;
    attemptBuckets.delete(oldestKey);
  }
}

function loadRateLimitFile(path: string): Record<string, AttemptBucket> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isRateLimitFile(parsed)) return parsed.buckets;
    // v1 format (a bare AttemptBucket persisted by v0.1) → migrate into the
    // global bucket so an upgrade cannot reset the failed-pairing window.
    if (isAttemptBucket(parsed)) return { [GLOBAL_KEY]: parsed };
    return {};
  } catch {
    // Corrupt/unreadable file → start fresh rather than crash-loop the gateway.
    return {};
  }
}

function persistRateLimitFile(path: string): void {
  try {
    const file: RateLimitFile = {
      schema: "pai-anywhere.rate-limit.v2",
      buckets: Object.fromEntries(attemptBuckets),
    };
    writeJsonAtomic(path, file, 0o600);
  } catch {
    // Persistence is best-effort; a write failure must not break pairing. The
    // in-memory buckets remain authoritative for the current process lifetime.
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

function isRateLimitFile(value: unknown): value is RateLimitFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== "pai-anywhere.rate-limit.v2") return false;
  if (!candidate.buckets || typeof candidate.buckets !== "object") return false;
  for (const bucket of Object.values(candidate.buckets as Record<string, unknown>)) {
    if (!isAttemptBucket(bucket)) return false;
  }
  return true;
}

export function pairingCodeMatches(provided: string, expected: string): boolean {
  // (L2) Compare fixed-length sha256 digests instead of the raw strings so the
  // comparison is constant-time over equal-length buffers with no early-exit
  // that would leak the expected code's length or per-byte prefix.
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
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
  // If renameSync throws (cross-device, EACCES on target), do not leave a
  // 0600 temp file with secret content lingering next to the target.
  try {
    renameSync(tempPath, path);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* temp already gone */ }
    throw error;
  }
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

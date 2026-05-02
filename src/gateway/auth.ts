import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export function canAttemptPairing(): boolean {
  const now = Date.now();
  const bucket = attemptBuckets.get(GLOBAL_KEY);
  if (!bucket || bucket.resetAt <= now) {
    attemptBuckets.set(GLOBAL_KEY, { count: 0, resetAt: now + ATTEMPT_WINDOW_MS });
    return true;
  }
  return bucket.count < MAX_ATTEMPTS;
}

export function recordFailedPairing(): void {
  const now = Date.now();
  const bucket = attemptBuckets.get(GLOBAL_KEY);
  if (!bucket || bucket.resetAt <= now) {
    attemptBuckets.set(GLOBAL_KEY, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  bucket.count += 1;
}

export function clearFailedPairing(): void {
  attemptBuckets.delete(GLOBAL_KEY);
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
  const [encoded, providedSignature] = value.split(".");
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

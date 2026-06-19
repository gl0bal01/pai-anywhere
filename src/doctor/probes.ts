import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { currentUserClaudeDir, managedClaudeDir, manifestPath } from "../lib/paths";
import {
  cmdExists,
  firstLine,
  getListeners,
  isLoopback,
  readDirSafe,
  readFileSafe,
  run,
  safeJson,
  safeLstat,
  safeRealpath,
  safeStat,
} from "../lib/sys";
import type { PostInstallProbe, PostInstallReport } from "./types";

const PULSE_PORT = 31337;
const PULSE_URL = `http://127.0.0.1:${PULSE_PORT}`;
const GATEWAY_SERVICE = "pai-anywhere.service";
const GATEWAY_PORT = process.env.PAI_ANYWHERE_GATEWAY_PORT || "8787";
const GATEWAY_URL = process.env.PAI_ANYWHERE_GATEWAY_URL || `http://127.0.0.1:${GATEWAY_PORT}`;

export async function runPostInstallProbes(): Promise<PostInstallReport> {
  const claudeConfigDir = managedClaudeDir();
  const userClaudeDir = currentUserClaudeDir();
  const mPath = manifestPath();
  const settings = readSettings(claudeConfigDir);
  const listeners = getListeners();

  return {
    schema: "pai-anywhere.probes.v1",
    generatedAt: new Date().toISOString(),
    target: {
      claudeConfigDir,
      userClaudeDir,
      manifestPath: mPath,
      pulseUrl: PULSE_URL,
      gatewayService: GATEWAY_SERVICE,
      gatewayUrl: GATEWAY_URL,
    },
    probes: [
      profileExists(claudeConfigDir),
      profileIsolated(claudeConfigDir, userClaudeDir),
      userClaudePreserved(claudeConfigDir, userClaudeDir),
      requiredFile(claudeConfigDir, "pai.claude_md", "PAI CLAUDE.md", ["CLAUDE.md"]),
      requiredFile(claudeConfigDir, "pai.system_prompt", "PAI system prompt", ["PAI", "PAI_SYSTEM_PROMPT.md"]),
      algorithmLatest(claudeConfigDir),
      settingsJson(settings),
      hooksConfigured(settings),
      hookFiles(claudeConfigDir),
      pulseLoopback(listeners),
      await pulseHealth(),
      gatewayService(),
      await gatewayAuthGate(),
      tailscaleServe(),
      manifestValid(mPath),
    ],
  };
}

function profileExists(dir: string): PostInstallProbe {
  const stat = safeStat(dir);
  if (!stat)
    return p("profile.exists", "Managed Claude profile", "fail", "Managed PAI Claude profile is missing", { path: dir });
  if (safeLstat(dir)?.isSymbolicLink())
    return p("profile.exists", "Managed Claude profile", "fail", "Managed profile path is a symlink, forbidden for safety", { path: dir });
  return p("profile.exists", "Managed Claude profile", stat.isDirectory() ? "pass" : "fail",
    stat.isDirectory() ? "Managed PAI Claude profile exists" : "Managed profile path exists but is not a directory",
    { path: dir });
}

function profileIsolated(claudeDir: string, userDir: string): PostInstallProbe {
  const managed = safeRealpath(claudeDir) ?? resolve(claudeDir);
  const user = safeRealpath(userDir) ?? resolve(userDir);
  const ok = managed !== user;
  return p("profile.isolated", "Profile isolation", ok ? "pass" : "fail",
    ok ? "PAI uses a managed profile outside ~/.claude" : "PAI target points at ~/.claude, which is forbidden",
    { claudeConfigDir: claudeDir, userClaudeDir: userDir });
}

function userClaudePreserved(claudeDir: string, userDir: string): PostInstallProbe {
  if (!existsSync(userDir))
    return p("profile.user_claude_preserved", "Existing ~/.claude preservation", "skip", "No existing ~/.claude detected", { path: userDir });
  const managed = safeRealpath(claudeDir) ?? resolve(claudeDir);
  const user = safeRealpath(userDir) ?? resolve(userDir);
  const ok = managed !== user;
  return p("profile.user_claude_preserved", "Existing ~/.claude preservation", ok ? "pass" : "fail",
    ok ? "Existing ~/.claude is outside the managed PAI target" : "Managed PAI target is ~/.claude, risking user config overwrite",
    { path: userDir });
}

function requiredFile(dir: string, id: string, title: string, parts: string[]): PostInstallProbe {
  const path = join(dir, ...parts);
  const ok = safeStat(path)?.isFile() === true;
  return p(id, title, ok ? "pass" : "fail", ok ? `${title} exists` : `${title} is missing`, { path });
}

function algorithmLatest(dir: string): PostInstallProbe {
  const latestPath = join(dir, "PAI", "ALGORITHM", "LATEST");
  if (!existsSync(latestPath))
    return p("pai.algorithm_latest", "PAI Algorithm version", "fail", "Algorithm LATEST marker is missing", { path: latestPath });
  const ver = firstLine(readFileSafe(latestPath));
  if (!ver)
    return p("pai.algorithm_latest", "PAI Algorithm version", "fail", "Algorithm LATEST marker is empty", { path: latestPath });
  const vf = ver.startsWith("v") ? `${ver}.md` : `v${ver}.md`;
  const vp = join(dir, "PAI", "ALGORITHM", vf);
  const ok = safeStat(vp)?.isFile() === true;
  return p("pai.algorithm_latest", "PAI Algorithm version", ok ? "pass" : "fail",
    ok ? `Algorithm version ${ver} is present` : `Algorithm version file for ${ver} is missing`,
    { latestPath, versionPath: vp });
}

type SettingsRead = { path: string; exists: boolean; parsed: unknown | null; error?: string };

function readSettings(dir: string): SettingsRead {
  const path = join(dir, "settings.json");
  if (!existsSync(path)) return { path, exists: false, parsed: null };
  try {
    return { path, exists: true, parsed: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (e) {
    return { path, exists: true, parsed: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function settingsJson(s: SettingsRead): PostInstallProbe {
  if (!s.exists)
    return p("pai.settings_json", "Claude settings JSON", "fail", "settings.json is missing", { path: s.path });
  return p("pai.settings_json", "Claude settings JSON", s.parsed ? "pass" : "fail",
    s.parsed ? "settings.json is valid JSON" : "settings.json is not valid JSON",
    { path: s.path, ...(s.error ? { error: s.error } : {}) });
}

function hooksConfigured(s: SettingsRead): PostInstallProbe {
  if (!s.parsed || typeof s.parsed !== "object")
    return p("pai.hooks_configured", "PAI hook configuration", "fail", "Cannot check hooks without valid settings.json", { path: s.path });
  const hooks = (s.parsed as Record<string, unknown>).hooks;
  const names = hooks && typeof hooks === "object" && !Array.isArray(hooks) ? Object.keys(hooks) : [];
  const hasPulse = /https?:\/\/(?:localhost|127\.0\.0\.1):31337\b/.test(JSON.stringify(s.parsed));
  if (names.length === 0)
    return p("pai.hooks_configured", "PAI hook configuration", "fail", "No Claude hooks configured in the managed profile", { path: s.path });
  return p("pai.hooks_configured", "PAI hook configuration", hasPulse ? "pass" : "warn",
    hasPulse ? "Hooks configured and reference loopback Pulse" : "Hooks configured but no loopback Pulse endpoint found",
    { path: s.path, hookNames: names });
}

function hookFiles(dir: string): PostInstallProbe {
  const path = join(dir, "hooks");
  if (!safeStat(path)?.isDirectory())
    return p("pai.hook_files", "PAI hook files", "fail", "hooks directory is missing from the managed profile", { path });
  const files = readDirSafe(path).filter((f) => f.endsWith(".hook.ts"));
  return p("pai.hook_files", "PAI hook files", files.length > 0 ? "pass" : "fail",
    files.length > 0 ? `${files.length} hook file(s) found` : "No *.hook.ts files found",
    { path, count: files.length, files: files.slice(0, 20) });
}

function pulseLoopback(listeners: string[]): PostInstallProbe {
  const pulse = listeners.filter((l) => /:31337\b/.test(l));
  const pub = pulse.filter((l) => !isLoopback(l));
  if (pulse.length === 0)
    return p("pulse.loopback", "Pulse loopback binding", "fail", `Pulse is not listening on port ${PULSE_PORT}`);
  return p("pulse.loopback", "Pulse loopback binding", pub.length > 0 ? "fail" : "pass",
    pub.length > 0 ? "Pulse is exposed on a non-loopback address" : "Pulse is listening only on loopback",
    { listeners: pulse });
}

async function pulseHealth(): Promise<PostInstallProbe> {
  // (T22) Probe both health paths by design: different Pulse versions expose the
  // endpoint at either /healthz or /api/pulse/health, so a pass on either is a
  // healthy Pulse. This is intentional, not redundant.
  for (const url of [`${PULSE_URL}/healthz`, `${PULSE_URL}/api/pulse/health`]) {
    const r = await fetchStatus(url, 1_500);
    if (r.ok) return p("pulse.health", "Pulse health endpoint", "pass", "Pulse health endpoint responded", { url, status: r.status });
  }
  return p("pulse.health", "Pulse health endpoint", "fail", "Pulse health endpoint did not respond", { tried: `${PULSE_URL}/healthz` });
}

function gatewayService(): PostInstallProbe {
  if (!cmdExists("systemctl"))
    return p("gateway.service", "Gateway service", "fail", "systemctl is unavailable; cannot verify gateway service state");
  const r = run(["systemctl", "is-active", GATEWAY_SERVICE], 3_000);
  const active = r.code === 0 && firstLine(r.out) === "active";
  return p("gateway.service", "Gateway service", active ? "pass" : "fail",
    active ? "Gateway service is active" : "Gateway service is not active",
    { service: GATEWAY_SERVICE, state: firstLine(r.out || r.err) || "unknown" });
}

async function gatewayAuthGate(): Promise<PostInstallProbe> {
  const health = await fetchStatus(`${GATEWAY_URL}/__gateway/healthz`, 1_500);
  if (!health.ok)
    return p("gateway.auth_gate", "Gateway authentication gate", "fail", "Gateway health endpoint did not respond", { url: GATEWAY_URL });
  const prot = await fetchStatus(`${GATEWAY_URL}/pulse`, 1_500);
  // (T21) A transport error (timeout / connection refused) means we got NO status
  // back — a slow Pulse upstream must not be reported as an auth-gate failure.
  // Treat it as "warn"/unknown; only a real non-401 HTTP status is a true fail.
  if (prot.transportError)
    return p("gateway.auth_gate", "Gateway authentication gate", "warn",
      "Could not determine the auth gate; /pulse did not respond in time (slow upstream?)",
      { url: GATEWAY_URL });
  const ok = prot.status === 401;
  return p("gateway.auth_gate", "Gateway authentication gate", ok ? "pass" : "fail",
    ok ? "Gateway blocks unauthenticated requests" : "Gateway did not block an unauthenticated request",
    { url: GATEWAY_URL, ...(!ok ? { status: prot.status ?? "unavailable" } : {}) });
}

function tailscaleServe(): PostInstallProbe {
  if (!cmdExists("tailscale"))
    return p("tailscale.private_serve", "Private Tailscale Serve", "fail", "Tailscale is not installed");
  const r = run(["tailscale", "serve", "status"], 5_000);
  const combined = `${r.out}\n${r.err}`;
  if (/\bFunnel\b/i.test(combined))
    return p("tailscale.private_serve", "Private Tailscale Serve", "fail",
      "Tailscale Funnel appears configured; public Funnel exposure is forbidden",
      { status: firstLine(combined) });
  const ok = r.code === 0 && /\bServe\b|https?:\/\//i.test(combined);
  return p("tailscale.private_serve", "Private Tailscale Serve", ok ? "pass" : "fail",
    ok ? "Tailscale Serve is configured without Funnel" : "Tailscale Serve is not configured");
}

function manifestValid(mPath: string): PostInstallProbe {
  if (!existsSync(mPath))
    return p("manifest.valid", "Install manifest", "fail", "Install manifest is missing", { path: mPath });
  const first = readFileSafe(mPath).split("\n").find((l) => l.trim().length > 0);
  const ok = Boolean(first && safeJson(first));
  return p("manifest.valid", "Install manifest", ok ? "pass" : "fail",
    ok ? "Install manifest is valid JSONL" : "Install manifest first entry is not valid JSON",
    { path: mPath });
}

// --- probe factory ---
function p(
  id: string,
  title: string,
  status: PostInstallProbe["status"],
  summary: string,
  details?: Record<string, unknown>,
): PostInstallProbe {
  return { id, title, status, summary, ...(details && Object.keys(details).length > 0 ? { details } : {}) };
}

async function fetchStatus(url: string, ms: number): Promise<{ ok: boolean; status?: number; transportError?: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { ok: res.ok, status: res.status };
  } catch {
    // No HTTP response at all (timeout/abort, connection refused, DNS). The
    // caller must not treat this the same as a real non-expected status code.
    return { ok: false, transportError: true };
  }
  finally { clearTimeout(t); }
}

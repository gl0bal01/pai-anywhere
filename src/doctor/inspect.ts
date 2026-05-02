import { existsSync, readFileSync } from "node:fs";
import { hostname, platform, release, userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import {
  currentUserClaudeDir,
  managedClaudeDir,
  managedHomeDir,
  managedUser,
  manifestPath,
} from "../lib/paths";
import type { DoctorCheck, DoctorReport } from "./types";

const DEPS = [
  { id: "dep.bun", title: "Bun", cmd: "bun" },
  { id: "dep.git", title: "Git", cmd: "git" },
  { id: "dep.tailscale", title: "Tailscale", cmd: "tailscale" },
  { id: "dep.fail2ban", title: "fail2ban", cmd: "fail2ban-client" },
  { id: "dep.ufw", title: "ufw", cmd: "ufw" },
];

export async function inspectHost(): Promise<DoctorReport> {
  const u = safeUser();
  return {
    schema: "pai-anywhere.health-check.v1",
    generatedAt: new Date().toISOString(),
    host: { platform: platform(), arch: process.arch, release: release(), hostname: hostname(), user: u.username, uid: u.uid },
    checks: [
      checkOS(),
      checkUser(u),
      ...checkDeps(),
      checkTailscale(),
      checkServe(),
      checkListeners(),
      checkPulse(),
      checkUfw(),
      checkFail2ban(),
      checkSshDropIn(),
      checkClaudeProfile(),
      checkManagedAccount(),
      checkManagedProfile(),
      checkManifest(),
    ],
  };
}

function checkOS(): DoctorCheck {
  const rel = readOsRelease();
  const name = rel.PRETTY_NAME ?? rel.NAME ?? platform();
  const ok = platform() === "linux" && /ubuntu|debian/i.test(`${rel.ID ?? ""} ${rel.ID_LIKE ?? ""} ${name}`);
  return { id: "host.os", title: "Operating system",
    status: ok ? "pass" : "warn",
    summary: ok ? `Supported Linux distribution detected: ${name}` : `V1 targets Ubuntu/Debian; detected ${name}` };
}

function checkUser(u: { username: string; uid: number | null }): DoctorCheck {
  const root = u.uid === 0;
  const sudo = cmdExists("sudo");
  return { id: "host.user", title: "Current user",
    status: root || sudo ? "pass" : "warn",
    summary: root ? "Running as root" : sudo ? "sudo available for install steps" : "sudo not found; install steps may need root",
    details: { user: u.username, uid: u.uid ?? "unknown", sudo: sudo ? "available" : "missing" } };
}

function checkDeps(): DoctorCheck[] {
  return DEPS.map(({ id, title, cmd }) => {
    const found = cmd === "bun" ? (!!process.versions.bun || cmdExists(cmd)) : cmdExists(cmd);
    return { id, title: `${title} dependency`,
      status: found ? "pass" : "warn",
      summary: found ? `${title} found` : `${title} is not installed or not on PATH` };
  });
}

function checkTailscale(): DoctorCheck {
  if (!cmdExists("tailscale"))
    return { id: "tailscale.status", title: "Tailscale status", status: "warn", summary: "Tailscale is not installed" };
  const r = run(["tailscale", "status", "--json"], 5_000);
  const parsed = safeJson(r.out) as Record<string, unknown> | null;
  const state = typeof parsed?.BackendState === "string" ? parsed.BackendState : "unknown";
  const self = parsed?.Self as Record<string, unknown> | undefined;
  const dnsName = typeof self?.DNSName === "string" ? self.DNSName : undefined;
  return { id: "tailscale.status", title: "Tailscale status",
    status: state === "Running" ? "pass" : "warn",
    summary: state === "Running" ? "Tailscale is running" : `Tailscale state is ${state}`,
    details: { backendState: state, ...(dnsName ? { dnsName } : {}) } };
}

function checkServe(): DoctorCheck {
  if (!cmdExists("tailscale"))
    return { id: "tailscale.serve", title: "Tailscale Serve/Funnel", status: "info", summary: "Skipped: Tailscale not installed" };
  const r = run(["tailscale", "serve", "status"], 5_000);
  const combined = `${r.out}\n${r.err}`;
  if (/\bFunnel\b/i.test(combined))
    return { id: "tailscale.serve", title: "Tailscale Serve/Funnel", status: "fail",
      summary: "Tailscale Funnel detected; V1 forbids public Funnel exposure" };
  const hasServe = /\bServe\b|https?:\/\//i.test(combined);
  return { id: "tailscale.serve", title: "Tailscale Serve/Funnel",
    status: hasServe ? "pass" : "info",
    summary: hasServe ? "Tailscale Serve configured, no Funnel detected" : "No Tailscale Serve config detected" };
}

function checkListeners(): DoctorCheck {
  const lines = getListeners();
  const pub = lines.filter((l) => /LISTEN/i.test(l) && !isLoopback(l));
  return { id: "network.listeners", title: "Listening ports",
    status: pub.length > 0 ? "warn" : "pass",
    summary: pub.length > 0 ? `${pub.length} non-loopback TCP listener(s) detected` : "No non-loopback TCP listeners detected",
    details: pub.length > 0 ? { publicListeners: pub.slice(0, 10) } : {} };
}

function checkPulse(): DoctorCheck {
  const pulse = getListeners().filter((l) => /:31337\b/.test(l));
  const pub = pulse.filter((l) => !isLoopback(l));
  if (pulse.length === 0)
    return { id: "pulse.bind", title: "Pulse bind address", status: "info", summary: "Pulse is not listening on port 31337" };
  return { id: "pulse.bind", title: "Pulse bind address",
    status: pub.length > 0 ? "fail" : "pass",
    summary: pub.length > 0 ? "Pulse exposed on non-loopback address" : "Pulse listening only on loopback",
    details: { listeners: pulse } };
}

function checkUfw(): DoctorCheck {
  if (!cmdExists("ufw"))
    return { id: "firewall.ufw", title: "ufw firewall", status: "info", summary: "ufw is not installed" };
  const r = run(["ufw", "status", "verbose"], 5_000);
  return { id: "firewall.ufw", title: "ufw firewall", status: "info",
    summary: firstLine(r.out || r.err) || "ufw status checked" };
}

function checkFail2ban(): DoctorCheck {
  if (!cmdExists("fail2ban-client"))
    return { id: "hardening.fail2ban", title: "fail2ban", status: "info", summary: "fail2ban is not installed" };
  const r = run(["fail2ban-client", "ping"], 5_000);
  return { id: "hardening.fail2ban", title: "fail2ban",
    status: r.code === 0 ? "pass" : "warn",
    summary: r.code === 0 ? "fail2ban daemon responded" : "fail2ban installed but daemon did not respond" };
}

function checkSshDropIn(): DoctorCheck {
  const path = "/etc/ssh/sshd_config.d/99-pai-anywhere.conf";
  return { id: "ssh.dropin", title: "SSH hardening drop-in",
    status: existsSync(path) ? "info" : "pass",
    summary: existsSync(path) ? "pai-anywhere SSH drop-in exists" : "No pai-anywhere SSH drop-in found",
    details: { path } };
}

function checkClaudeProfile(): DoctorCheck {
  const path = currentUserClaudeDir();
  const exists = existsSync(path);
  return { id: "profile.existing_claude", title: "Existing ~/.claude preservation",
    status: exists ? "warn" : "pass",
    summary: exists ? "Existing ~/.claude detected; default install must leave it untouched" : "No existing ~/.claude detected",
    ...(exists ? { details: { path } } : {}) };
}

function checkManagedAccount(): DoctorCheck {
  const user = managedUser();
  const r = run(["id", "-u", user], 3_000);
  return { id: "profile.managed_user", title: "Managed PAI account",
    status: r.code === 0 ? "info" : "pass",
    summary: r.code === 0
      ? `Managed user ${user} exists; install must confirm ownership before using it`
      : `Managed user ${user} is not created yet`,
    details: { user, home: managedHomeDir() } };
}

function checkManagedProfile(): DoctorCheck {
  const path = managedClaudeDir();
  return { id: "profile.managed", title: "Managed PAI profile",
    status: existsSync(path) ? "info" : "pass",
    summary: existsSync(path) ? "Managed profile exists" : "Managed profile not created yet",
    details: { path } };
}

function checkManifest(): DoctorCheck {
  const path = manifestPath();
  if (!existsSync(path))
    return { id: "manifest", title: "Install manifest", status: "pass", summary: "No install manifest exists yet", details: { path } };
  const first = readFileSafe(path).split("\n").find((l) => l.trim().length > 0);
  const valid = Boolean(first && safeJson(first));
  return { id: "manifest", title: "Install manifest",
    status: valid ? "info" : "warn",
    summary: valid ? "Install manifest exists (JSONL)" : "Install manifest exists but first entry is not valid JSON",
    details: { path } };
}

// --- helpers ---

function run(cmd: string[], ms = 5_000): { code: number | null; out: string; err: string } {
  const [bin, ...a] = cmd;
  if (!bin) return { code: null, out: "", err: "empty command" };
  const r = spawnSync(bin, a, { encoding: "utf8", timeout: ms, maxBuffer: 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function cmdExists(name: string): boolean {
  return spawnSync("sh", ["-lc", `command -v '${name.replaceAll("'", "'\\''")}' >/dev/null 2>&1`],
    { timeout: 2_000 }).status === 0;
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
}

function readFileSafe(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s) as unknown; } catch { return null; }
}

function safeUser(): { username: string; uid: number | null } {
  try {
    const u = userInfo();
    return { username: u.username, uid: typeof u.uid === "number" ? u.uid : null };
  } catch {
    return { username: process.env.USER ?? "unknown", uid: typeof process.getuid === "function" ? process.getuid() : null };
  }
}

function readOsRelease(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync("/etc/os-release", "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^"|"$/g, "");
    }
  } catch { /* ignore */ }
  return out;
}

function getListeners(): string[] {
  const cmd = cmdExists("ss") ? ["ss", "-lntup"] : cmdExists("lsof") ? ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"] : null;
  if (!cmd) return [];
  return run(cmd, 5_000).out.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

function isLoopback(line: string): boolean {
  return /\b127\.\d+\.\d+\.\d+:/i.test(line)
    || /\[::1\]:/i.test(line)
    || /\blocalhost:/i.test(line)
    || /\b::1:/i.test(line);
}


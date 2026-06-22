import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function run(cmd: string[], ms = 10_000): { code: number | null; out: string; err: string } {
  // (T8) Default 10s timeout: probes invoke tools (systemctl, tailscale, ufw)
  // that can be slow on a loaded VPS; a 5s default produced spurious failures.
  const [bin, ...a] = cmd;
  if (!bin) return { code: null, out: "", err: "empty command" };
  const r = spawnSync(bin, a, { encoding: "utf8", timeout: ms, maxBuffer: 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// (T4) `name` is interpolated into a shell command. This is only safe because
// every caller passes a hardcoded string literal (e.g. "ss", "systemctl",
// "tailscale"). Do NOT pass untrusted/user-controlled input here — there is no
// general escaping beyond the single-quote wrap below.
//
// NOT a login shell: `sh -lc` sources the user's profile, which (a) resets PATH
// from /etc/profile — dropping /usr/sbin and /sbin for non-root users, so admin
// tools like ufw vanish — and (b) can abort outright when a profile.d snippet
// uses bash syntax under dash, making `command -v` never run and every dep look
// missing. Run a plain shell and search a PATH augmented with the standard
// admin directories so probes find binaries regardless of the caller's account.
const PROBE_PATH = `${process.env.PATH ?? ""}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

export function cmdExists(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v '${name.replaceAll("'", "'\\''")}' >/dev/null 2>&1`],
    { timeout: 2_000, env: { ...process.env, PATH: PROBE_PATH } }).status === 0;
}

export function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
}

export function readFileSafe(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

export function safeJson(s: string): unknown {
  try { return JSON.parse(s) as unknown; } catch { return null; }
}

export function readDirSafe(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

export function safeStat(path: string): ReturnType<typeof statSync> | null {
  try { return statSync(path); } catch { return null; }
}

export function safeLstat(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); } catch { return null; }
}

export function safeRealpath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

export function getListeners(): string[] {
  const cmd = cmdExists("ss") ? ["ss", "-lntup"] : cmdExists("lsof") ? ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"] : null;
  if (!cmd) return [];
  return run(cmd, 5_000).out.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

export function isLoopback(line: string): boolean {
  return /\b127\.\d+\.\d+\.\d+:/i.test(line)
    || /\[::1\]:/i.test(line)
    || /\blocalhost:/i.test(line)
    || /\b::1:/i.test(line);
}

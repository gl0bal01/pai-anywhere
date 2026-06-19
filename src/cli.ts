#!/usr/bin/env bun
import { chmodSync, chownSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { inspectHost } from "./doctor/inspect";
import { runPostInstallProbes } from "./doctor/probes";
import { printDoctorReport, printProbeReport } from "./doctor/report";
import { gatewayConfigFromArgs, startGateway } from "./gateway/server";
import { configDir, managedUser, stateDir } from "./lib/paths";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

async function main(): Promise<void> {
  if (command === "doctor") {
    const json = args.includes("--json");
    const postInstall = args.includes("--post-install");
    if (postInstall) {
      const report = await runPostInstallProbes();
      json ? console.log(JSON.stringify(report, null, 2)) : printProbeReport(report);
      process.exitCode = report.probes.some((p) => p.status === "fail") ? 2 : 0;
    } else {
      const report = await inspectHost();
      json ? console.log(JSON.stringify(report, null, 2)) : printDoctorReport(report);
      process.exitCode = report.checks.some((c) => c.status === "fail") ? 2 : 0;
    }
    return;
  }

  if (command === "verify") {
    const json = args.includes("--json");
    const report = await runPostInstallProbes();
    json ? console.log(JSON.stringify(report, null, 2)) : printProbeReport(report);
    process.exitCode = report.probes.some((p) => p.status === "fail") ? 2 : 0;
    return;
  }

  if (command === "reset-access") {
    process.exitCode = resetAccess();
    return;
  }

  if (command === "gateway") {
    const config = gatewayConfigFromArgs(args.slice(1));
    startGateway(config);
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

export function resetAccess(): number {
  // gateway.env lives under /etc/pai-anywhere (root-owned). Refusing as non-root
  // prevents half-rotation: gateway-secrets.json gets updated in stateDir, then
  // the gateway.env writeAtomic fails with EACCES, leaving cookies invalidated
  // but the pairing code unchanged.
  if (typeof process.geteuid === "function" && process.geteuid() !== 0) {
    console.error("reset-access must be run as root.");
    console.error("Try: sudo pai-anywhere reset-access");
    return 1;
  }

  const cfg = configDir();
  const state = stateDir();
  mkdirSync(cfg, { recursive: true, mode: 0o755 });
  mkdirSync(state, { recursive: true, mode: 0o700 });

  // The gateway runs as the managed user and reads gateway-secrets.json at
  // startup. reset-access runs as root, so files it writes are root-owned;
  // without re-chowning, the next gateway start hits EACCES and crash-loops
  // (rotation half-applied: old cookies dead, new secret unreadable). Resolve
  // the managed user's ids up front and mirror install.sh's ownership.
  const user = managedUser();
  const ids = resolveUserIds(user);

  // (T2) Abort BEFORE writing any secrets if the managed user can't be resolved.
  // Otherwise we would write a fresh gateway-secrets.json owned by root that the
  // gateway (User=<managed>) cannot read, crash-looping the service while old
  // cookies are already dead. Fail closed and change nothing.
  if (!ids) {
    console.error(`reset-access: managed user '${user}' could not be resolved (resolveUserIds returned null).`);
    console.error("Refusing to rotate secrets — doing so would leave root-owned files the gateway cannot read.");
    console.error(`Create the '${user}' account (or set PAI_ANYWHERE_USER) and re-run reset-access.`);
    return 1;
  }

  // 20-char base64url pairing code (120 bits entropy)
  const pairingCode = randomBytes(15).toString("base64url");

  // Write gateway.env for EnvironmentFile= in systemd unit
  const envFile = join(cfg, "gateway.env");
  const envContent = [
    "# Created by pai-anywhere reset-access.",
    "# Keep mode 0600. Contains the gateway pairing code.",
    `PAI_ANYWHERE_PAIRING_CODE=${pairingCode}`,
    "",
  ].join("\n");
  writeAtomic(envFile, envContent, 0o600);
  // gateway.env is read by systemd (as root); keep root:<managed-group> 0600
  // for parity with install.sh.
  // (T6) Warn instead of swallowing: a failed chown can leave the env file with
  // unexpected group ownership, which the operator should know about.
  try {
    chownSync(envFile, 0, ids.gid);
  } catch {
    console.error(`Warning: could not chown ${envFile} to root:${ids.gid}; check its ownership/permissions.`);
  }

  // Rotate session secret so old cookies are immediately invalidated
  const secretsFile = join(state, "gateway-secrets.json");
  const secrets = {
    schema: "pai-anywhere.gateway-secrets.v1",
    createdAt: new Date().toISOString(),
    sessionSecret: randomBytes(32).toString("base64url"),
  };
  writeAtomic(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
  // gateway-secrets.json is read by the gateway process — it MUST be owned by
  // the managed user or the service cannot start after rotation.
  try {
    chownSync(secretsFile, ids.uid, ids.gid);
  } catch {
    console.error(`Warning: could not chown ${secretsFile} to ${user}; the gateway may fail to read it.`);
  }

  // Restart gateway service if active so new secrets take effect immediately.
  // (T2) If the restart fails the secrets ARE already rotated (old cookies dead)
  // but the running gateway still holds the old in-memory secret, so surface it
  // loudly and exit non-zero so the operator performs a manual restart.
  let exitCode = 0;
  const active = spawnSync("systemctl", ["is-active", "pai-anywhere.service"], { encoding: "utf8", timeout: 3_000 });
  if (active.status === 0) {
    const restart = spawnSync("systemctl", ["restart", "pai-anywhere.service"], { encoding: "utf8", timeout: 10_000 });
    if (restart.status === 0) {
      console.log("Gateway service restarted; old session cookies are now invalid.");
    } else {
      console.error("ERROR: secrets were rotated but 'systemctl restart pai-anywhere.service' failed.");
      console.error("The new pairing code/secret are on disk, but the running gateway still uses the old ones.");
      console.error("Run: sudo systemctl restart pai-anywhere.service");
      exitCode = 1;
    }
  }

  console.log(`New pairing code: ${pairingCode}`);
  console.log(`Written to ${envFile} (mode 0600)`);
  return exitCode;
}

function writeAtomic(path: string, content: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  // (T7) If renameSync throws (e.g. cross-device, EACCES on the target), the temp
  // file would otherwise linger with 0600 secret content. Unlink it on failure.
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* temp already gone */ }
    throw error;
  }
}

function resolveUserIds(user: string): { uid: number; gid: number } | null {
  // (T16) 10s timeout: `id` can be slow when NSS hits a remote directory
  // (LDAP/SSSD); a 3s cap was prone to spurious null → unnecessary abort.
  const uid = spawnSync("id", ["-u", user], { encoding: "utf8", timeout: 10_000 });
  const gid = spawnSync("id", ["-g", user], { encoding: "utf8", timeout: 10_000 });
  if (uid.status !== 0 || gid.status !== 0) return null;
  const u = Number.parseInt((uid.stdout || "").trim(), 10);
  const g = Number.parseInt((gid.stdout || "").trim(), 10);
  if (!Number.isInteger(u) || !Number.isInteger(g)) return null;
  return { uid: u, gid: g };
}

function printHelp(): void {
  console.log(`pai-anywhere

Usage:
  pai-anywhere doctor [--json] [--post-install]
  pai-anywhere verify [--json]
  pai-anywhere reset-access
  pai-anywhere gateway [--port <port>]

Commands:
  doctor       Read-only host inspection; --post-install checks running install
  verify       Post-install safety verification (alias: doctor --post-install)
  reset-access Rotate gateway pairing code and session secret (requires root)
  gateway      Loopback-only private gateway
`);
}

// Only run the CLI when executed as the entrypoint, not when imported (e.g. by
// tests that exercise resetAccess() directly). import.meta.main is true only for
// the file Bun/Node was launched with.
if (import.meta.main) {
  main().catch((error: unknown) => {
    // (T5) `error instanceof Error` then String() fallback is intentional: thrown
    // values are not guaranteed to be Error instances, and we only need a readable
    // message for the operator, not a typed rethrow.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

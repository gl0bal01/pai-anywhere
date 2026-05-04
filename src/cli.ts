#!/usr/bin/env bun
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { inspectHost } from "./doctor/inspect";
import { runPostInstallProbes } from "./doctor/probes";
import { printDoctorReport, printProbeReport } from "./doctor/report";
import { gatewayConfigFromArgs, startGateway } from "./gateway/server";
import { configDir, stateDir } from "./lib/paths";

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
    resetAccess();
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

function resetAccess(): void {
  // gateway.env lives under /etc/pai-anywhere (root-owned). Refusing as non-root
  // prevents half-rotation: gateway-secrets.json gets updated in stateDir, then
  // the gateway.env writeAtomic fails with EACCES, leaving cookies invalidated
  // but the pairing code unchanged.
  if (typeof process.geteuid === "function" && process.geteuid() !== 0) {
    console.error("reset-access must be run as root.");
    console.error("Try: sudo pai-anywhere reset-access");
    process.exitCode = 1;
    return;
  }

  const cfg = configDir();
  const state = stateDir();
  mkdirSync(cfg, { recursive: true, mode: 0o755 });
  mkdirSync(state, { recursive: true, mode: 0o700 });

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

  // Rotate session secret so old cookies are immediately invalidated
  const secretsFile = join(state, "gateway-secrets.json");
  const secrets = {
    schema: "pai-anywhere.gateway-secrets.v1",
    createdAt: new Date().toISOString(),
    sessionSecret: randomBytes(32).toString("base64url"),
  };
  writeAtomic(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);

  // Restart gateway service if active so new secrets take effect immediately
  const active = spawnSync("systemctl", ["is-active", "pai-anywhere.service"], { encoding: "utf8", timeout: 3_000 });
  if (active.status === 0) {
    const restart = spawnSync("systemctl", ["restart", "pai-anywhere.service"], { encoding: "utf8", timeout: 10_000 });
    if (restart.status === 0) {
      console.log("Gateway service restarted; old session cookies are now invalid.");
    } else {
      console.error("Warning: gateway service failed to restart. Old cookies remain valid until it restarts.");
    }
  }

  console.log(`New pairing code: ${pairingCode}`);
  console.log(`Written to ${envFile} (mode 0600)`);
}

function writeAtomic(path: string, content: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

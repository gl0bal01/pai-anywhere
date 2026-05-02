import type { CheckStatus, DoctorReport, PostInstallReport, ProbeStatus } from "./types";

const CHECK_LABELS: Record<CheckStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", info: "INFO" };
const PROBE_LABELS: Record<ProbeStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export function printDoctorReport(report: DoctorReport): void {
  console.log("pai-anywhere doctor");
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Host: ${report.host.hostname} (${report.host.platform} ${report.host.release}, ${report.host.arch})`);
  console.log(`User: ${report.host.user}${report.host.uid !== null ? ` (uid ${report.host.uid})` : ""}`);
  console.log("");
  printItems(report.checks, CHECK_LABELS);
  const c = tally(report.checks);
  console.log(`Summary: ${c.pass ?? 0} pass, ${c.warn ?? 0} warn, ${c.fail ?? 0} fail, ${c.info ?? 0} info`);
}

export function printProbeReport(report: PostInstallReport): void {
  console.log("pai-anywhere verify");
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Profile: ${report.target.claudeConfigDir}`);
  console.log(`Pulse: ${report.target.pulseUrl}`);
  console.log(`Gateway: ${report.target.gatewayUrl}`);
  console.log("");
  printItems(report.probes, PROBE_LABELS);
  const c = tally(report.probes);
  console.log(`Summary: ${c.pass ?? 0} pass, ${c.warn ?? 0} warn, ${c.fail ?? 0} fail, ${c.skip ?? 0} skip`);
}

function printItems<T extends { status: string; title: string; summary: string; details?: Record<string, unknown> }>(
  items: T[],
  labels: Record<string, string>,
): void {
  for (const item of items) {
    console.log(`${(labels[item.status] ?? item.status).padEnd(4)}  ${item.title}`);
    console.log(`      ${item.summary}`);
    for (const [k, v] of Object.entries(item.details ?? {})) {
      const fmt = Array.isArray(v) ? v.join(", ") : (typeof v === "object" && v !== null) ? JSON.stringify(v) : String(v);
      console.log(`      ${k}: ${fmt}`);
    }
    console.log("");
  }
}

function tally<T extends { status: string }>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.status] = (out[item.status] ?? 0) + 1;
  return out;
}

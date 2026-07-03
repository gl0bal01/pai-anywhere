import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAccess } from "./cli";

/**
 * T2: reset-access must abort BEFORE rotating any secrets when the managed user
 * cannot be resolved. Otherwise it would write a root-owned gateway-secrets.json
 * that the gateway (User=<managed>) cannot read, crash-looping the service while
 * old cookies are already invalidated (half-rotation).
 *
 * We drive resetAccess() directly with env overrides pointing at temp dirs and a
 * deliberately non-existent managed user, and temporarily force geteuid()→0 so
 * the root gate passes (the test runner is not actually root).
 */
describe("reset-access half-rotation guard (T2)", () => {
  let cfgDir: string;
  let stateDir: string;
  const saved: Record<string, string | undefined> = {};
  let savedGeteuid: typeof process.geteuid;

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), "pai-cli-cfg-"));
    stateDir = mkdtempSync(join(tmpdir(), "pai-cli-state-"));
    for (const key of ["PAI_ANYWHERE_CONFIG_DIR", "PAI_ANYWHERE_STATE_DIR", "PAI_ANYWHERE_USER"]) {
      saved[key] = process.env[key];
    }
    process.env.PAI_ANYWHERE_CONFIG_DIR = cfgDir;
    process.env.PAI_ANYWHERE_STATE_DIR = stateDir;
    // A user that cannot exist → resolveUserIds() returns null.
    process.env.PAI_ANYWHERE_USER = "pai-nonexistent-user-zzz9999";
    savedGeteuid = process.geteuid;
    process.geteuid = () => 0;
  });

  afterEach(() => {
    process.geteuid = savedGeteuid;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("returns non-zero and writes NO secrets when the managed user is unresolved", () => {
    const code = resetAccess();
    expect(code).toBe(1);
    // The critical safety property: nothing was rotated/written.
    expect(existsSync(join(stateDir, "gateway-secrets.json"))).toBe(false);
    expect(existsSync(join(stateDir, "pairing-code.txt"))).toBe(false);
    expect(existsSync(join(cfgDir, "gateway.env"))).toBe(false);
  });
});

/**
 * T2 (companion): the non-root gate still fails closed before touching disk.
 */
describe("reset-access requires root (T2 companion)", () => {
  let savedGeteuid: typeof process.geteuid;

  beforeEach(() => {
    savedGeteuid = process.geteuid;
    process.geteuid = () => 1000;
  });

  afterEach(() => {
    process.geteuid = savedGeteuid;
  });

  test("returns 1 when not run as root", () => {
    expect(resetAccess()).toBe(1);
  });
});

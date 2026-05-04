import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MANAGED_USER = "pai";

export function managedUser(): string {
  return process.env.PAI_ANYWHERE_USER || DEFAULT_MANAGED_USER;
}

export function managedHomeDir(): string {
  return process.env.PAI_ANYWHERE_HOME || `/home/${managedUser()}`;
}

export function managedClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(managedHomeDir(), ".claude");
}

export function currentUserClaudeDir(): string {
  return join(homedir(), ".claude");
}

export function stateDir(): string {
  return process.env.PAI_ANYWHERE_STATE_DIR || "/var/lib/pai-anywhere";
}

export function configDir(): string {
  return process.env.PAI_ANYWHERE_CONFIG_DIR || "/etc/pai-anywhere";
}

export function manifestPath(): string {
  return process.env.PAI_ANYWHERE_MANIFEST || join(configDir(), "install-manifest.jsonl");
}

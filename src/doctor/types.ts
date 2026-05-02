export type CheckStatus = "pass" | "warn" | "fail" | "info";
export type ProbeStatus = "pass" | "warn" | "fail" | "skip";

export type DoctorCheck = {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  details?: Record<string, unknown>;
};

export type DoctorReport = {
  schema: "pai-anywhere.health-check.v1";
  generatedAt: string;
  host: {
    platform: string;
    arch: string;
    release: string;
    hostname: string;
    user: string;
    uid: number | null;
  };
  checks: DoctorCheck[];
};

export type PostInstallProbe = {
  id: string;
  title: string;
  status: ProbeStatus;
  summary: string;
  details?: Record<string, unknown>;
};

export type PostInstallReport = {
  schema: "pai-anywhere.probes.v1";
  generatedAt: string;
  target: {
    claudeConfigDir: string;
    userClaudeDir: string;
    manifestPath: string;
    pulseUrl: string;
    gatewayService: string;
    gatewayUrl: string;
  };
  probes: PostInstallProbe[];
};

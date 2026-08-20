export type GatewayConfig = {
  hostname: string;
  port: number;
  stateDir: string;
  pairingCode: string;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
  pulseOrigin: string;
  /** (M1) Require requests to carry the Tailscale-User-Login they paired with. */
  tailnetIdentityRequired: boolean;
};

export type GatewaySecrets = {
  schema: "pai-anywhere.gateway-secrets.v1";
  createdAt: string;
  sessionSecret: string;
};

export type SessionPayload = {
  schema: "pai-anywhere.session.v1";
  iat: number;
  exp: number;
  nonce: string;
  /** (M1) sha256 hex of the pairing client's Tailscale-User-Login, when bound. */
  sub?: string;
};

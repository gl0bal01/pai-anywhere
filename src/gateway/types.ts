export type GatewayConfig = {
  hostname: string;
  port: number;
  stateDir: string;
  pairingCode: string;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
  pulseOrigin: string;
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
};

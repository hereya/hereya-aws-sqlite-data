import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import type { Config } from "./types.ts";

/**
 * Resolve the capability HMAC secret at boot. When CAPABILITY_SECRET_ARN is set
 * (the CDK stack injects it), fetch the plaintext SecretString from Secrets
 * Manager; otherwise fall back to the CAPABILITY_SECRET env var already loaded
 * into `cfg.capabilitySecret`. Fails closed: if enforcement is on but no secret
 * could be resolved, the boot aborts rather than run unauthenticated.
 *
 * The stack generates a RAW random secret string (no SecretStringTemplate), so
 * SecretString is the secret verbatim — no JSON key to unwrap.
 */
export async function resolveCapabilitySecret(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  let secret = cfg.capabilitySecret;
  const arn = env.CAPABILITY_SECRET_ARN;
  if (arn !== undefined && arn !== "") {
    const client = new SecretsManagerClient({ region: cfg.awsRegion });
    try {
      const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
      secret = res.SecretString ?? "";
    } finally {
      client.destroy();
    }
  }
  if (cfg.capabilityEnforce && secret === "") {
    throw new Error("CAPABILITY_ENFORCE is on but no capability secret could be resolved");
  }
  return secret;
}

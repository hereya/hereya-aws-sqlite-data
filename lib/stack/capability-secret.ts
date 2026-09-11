import type * as cdk from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { StackContext } from "./context.ts";

export function createCapabilitySecret(stack: cdk.Stack, ctx: StackContext): void {
  // --- Capability token secret (spec §6 caller-binding) --------------------
  // The connector mints per-request HMAC capability tokens with this secret;
  // the VM re-derives the HMAC and checks the token's (org, app) matches the
  // request. RAW random string — no SecretStringTemplate/GenerateStringKey —
  // so GetSecretValue returns the secret verbatim (both the service and the
  // connector read SecretString as-is, not a JSON key).
  const capabilitySecret = new secretsmanager.Secret(stack, "CapabilitySecret", {
    description: "Dilaya SQLite Data API capability-token HMAC secret (shared with the connector)",
    generateSecretString: {
      passwordLength: 48,
      excludePunctuation: true,
    },
    removalPolicy: ctx.removalPolicy,
  });
  ctx.capabilitySecret = capabilitySecret;
  // The instance role reads the secret at boot to verify incoming tokens.
  capabilitySecret.grantRead(ctx.role);
}

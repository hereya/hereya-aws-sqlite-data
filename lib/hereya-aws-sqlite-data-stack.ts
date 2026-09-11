import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyContext } from "./stack/context.ts";
import { readStackConfig } from "./stack/config.ts";
import { createStorage } from "./stack/storage.ts";
import { createNetwork } from "./stack/network.ts";
import { createDiscovery } from "./stack/discovery.ts";
import { createHttpApi } from "./stack/http-api.ts";
import { createServiceArtifact } from "./stack/service-artifact.ts";
import { createInstanceRole } from "./stack/instance-role.ts";
import { createCapabilitySecret } from "./stack/capability-secret.ts";
import { createUserData } from "./stack/instance-user-data.ts";
import { createLaunchTemplate } from "./stack/launch-template.ts";
import { createAsg } from "./stack/asg.ts";
import { createLivenessAlarms } from "./stack/alarms/liveness.ts";
import { createHeadroomAlarms } from "./stack/alarms/headroom.ts";
import { createRegistryAlarms } from "./stack/alarms/registry.ts";
import { createTelegramRelay } from "./stack/telegram-relay.ts";
import { createOutputs } from "./stack/outputs.ts";

// THIS file's own depth is what the repo root is measured from — `lib/` is one
// level below it. The step modules under `lib/stack/` sit one level deeper, so
// none of them recomputes this; they read `ctx.repoRoot`, which is anchored
// here and here only.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The SQLite data stack, as an ordered list of build steps.
 *
 * Each step lives in `lib/stack/` and takes (stack, ctx): it reads what earlier
 * steps produced off the context and writes back what later ones need. Every
 * construct is still created with THIS stack as its scope, so logical ids — and
 * therefore the deployed resources, the production database VM and volume among
 * them — are exactly what they were when this was one 894-line constructor.
 *
 * THE ORDER BELOW IS LOAD-BEARING. `addToPolicy` appends to the instance role
 * in call order, so re-ordering two steps re-orders the synthesized policy
 * document; and a step reads context fields that only an earlier step sets.
 * `scripts/synth-golden.ts` is what proves a change here kept the template
 * intact — neither `tsc` nor a green `cdk synth` can see either kind of drift.
 */
export class HereyaAwsSqliteDataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ctx = emptyContext(repoRoot);

    readStackConfig(this, ctx);

    createStorage(this, ctx);
    createNetwork(this, ctx);
    createDiscovery(this, ctx);
    createHttpApi(this, ctx);
    createServiceArtifact(this, ctx);

    createInstanceRole(this, ctx);
    createCapabilitySecret(this, ctx);

    createUserData(this, ctx);
    createLaunchTemplate(this, ctx);
    createAsg(this, ctx);

    createLivenessAlarms(this, ctx);
    createHeadroomAlarms(this, ctx);
    createRegistryAlarms(this, ctx);
    createTelegramRelay(this, ctx);

    createOutputs(this, ctx);
  }
}

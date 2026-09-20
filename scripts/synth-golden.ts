/**
 * Golden-template harness for the SQLite data stack.
 *
 * Splitting lib/hereya-aws-sqlite-data-stack.ts must be a PURE MOVE: every
 * construct keeps its logical id, every property its value. Neither `tsc` nor
 * `cdk synth` proves that (a synth can be green and still have moved a
 * resource) — only the synthesized TEMPLATE does.
 *
 * Synthesizes the stack under several input profiles, each lighting up a
 * different set of branches, and writes one JSON per profile.
 *
 *   node scripts/synth-golden.ts <outDir>
 *
 * Then `diff -r` the before and after directories: it must be empty.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { HereyaAwsSqliteDataStack } from "../lib/hereya-aws-sqlite-data-stack.ts";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: synth-golden.ts <outDir>");
fs.mkdirSync(outDir, { recursive: true });

// Every input the stack reads, so a profile starts from a known-clean env and
// a value left over from the previous profile can never leak into the next.
const KEYS = [
  "autoDelete", "bootRestoreConcurrency", "capabilityEnforce", "diskHeadroomBytes",
  "evictionIdleDays", "evictionSweepMs", "fallbackInstanceType", "instanceType",
  "litestreamL0Retention", "litestreamL0RetentionCheckInterval", "litestreamLevelIntervals",
  "litestreamRetention", "litestreamSyncIntervalMs", "maxInflightPerApp", "maxLiveWorkers",
  "memoryHeadroomBytes", "registryPollSeconds", "rootVolumeGb", "servicePort",
  "spotPercentage", "sqlTimeoutMs", "telegramBotTokenParam", "telegramChatId", "vmCount",
  "writeStatsFlushMs",
];

const profiles: { name: string; env: Record<string, string> }[] = [
  {
    // A — every input at its default: the shape a bare `hereya add` produces.
    name: "a-defaults",
    env: {},
  },
  {
    // B — the ephemeral dev shape: destroyable, capability enforcement on,
    // Telegram relay wired (it appears only when BOTH of its inputs are set).
    name: "b-autodelete-telegram-capability",
    env: {
      autoDelete: "true",
      capabilityEnforce: "true",
      telegramBotTokenParam: "/dilaya/telegram/token",
      telegramChatId: "123456789",
    },
  },
  {
    // C — the production shape: bigger instance with a spot fallback, larger
    // root volume, eviction sweeping, tuned Litestream levels and headrooms.
    name: "c-production",
    env: {
      instanceType: "t4g.small",
      fallbackInstanceType: "t4g.medium",
      spotPercentage: "50",
      rootVolumeGb: "100",
      evictionIdleDays: "7",
      evictionSweepMs: "900000",
      diskHeadroomBytes: "5368709120",
      memoryHeadroomBytes: "314572800",
      maxLiveWorkers: "16",
      maxInflightPerApp: "32",
      bootRestoreConcurrency: "16",
      litestreamRetention: "168h",
      litestreamLevelIntervals: "15m,1h,4h",
      litestreamL0Retention: "6h",
      litestreamL0RetentionCheckInterval: "15m",
      litestreamSyncIntervalMs: "500",
      registryPollSeconds: "15",
      sqlTimeoutMs: "30000",
      writeStatsFlushMs: "60000",
      servicePort: "9090",
      telegramBotTokenParam: "/dilaya/telegram/token",
      telegramChatId: "123456789",
    },
  },
  {
    // D — the same headline features as C but every optional half OFF: no spot,
    // no eviction, and a Telegram chat id WITHOUT its token param (the relay
    // must stay absent — that half-set case is a real branch).
    name: "d-featureoff",
    env: {
      instanceType: "t4g.small",
      fallbackInstanceType: "t4g.medium",
      spotPercentage: "0",
      rootVolumeGb: "100",
      evictionIdleDays: "0",
      telegramChatId: "123456789",
    },
  },
];

for (const p of profiles) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(p.env)) process.env[k] = v;

  const app = new cdk.App();
  const stack = new HereyaAwsSqliteDataStack(app, "GoldenStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  });
  const json = Template.fromStack(stack).toJSON();
  fs.writeFileSync(path.join(outDir, `${p.name}.json`), JSON.stringify(json, null, 2) + "\n");
  console.log(`${p.name}: ${Object.keys(json.Resources ?? {}).length} resources`);
}

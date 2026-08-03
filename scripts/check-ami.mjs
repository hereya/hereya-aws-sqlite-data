// Says whether the pinned AMI has fallen behind what AWS publishes.
//
// Why a command and not a line in a runbook: the pin (CLAUDE.md invariant 12)
// stops AWS from replacing the production database VM on an unrelated deploy,
// and the accepted cost is that OS patches then arrive only when someone rolls
// the pin. Two documents already said "compare the pin with the current
// AL2023". Both were right, neither was executable, and the comparison went
// four weeks without being made. This is that sentence, made runnable.
//
//   npm run check:ami                      # pin vs the published AL2023
//   npm run check:ami -- --stack <name>    # also check the RUNNING instance
//
// Exit codes are the point — a caller (the agent's twice-daily sweep, a human,
// CI if anyone wants it) branches on them without parsing prose:
//   0  in sync
//   1  a newer AL2023 exists, or the running instance is on neither → plan a roll
//   2  could not determine (no aws CLI, no credentials, unreadable parameter)
//
// 2 is deliberately NOT 0. A check that cannot see must not report health.
import { execFileSync } from "node:child_process";
import {
  AL2023_SSM_PARAMETER,
  PINNED_AMI_ID,
  PINNED_AMI_REGION,
  amiPinStatus,
  describeVerdict,
} from "../lib/ami-pin.ts";

const args = process.argv.slice(2);
const stackName = argValue("--stack");
const region = argValue("--region") ?? PINNED_AMI_REGION;

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

/** Run an aws CLI call; null on ANY failure — the caller turns that into exit 2. */
function aws(cliArgs) {
  try {
    const out = execFileSync("aws", [...cliArgs, "--region", region, "--output", "text"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out === "" || out === "None" ? null : out;
  } catch {
    return null;
  }
}

const latest = aws([
  "ssm",
  "get-parameter",
  "--name",
  AL2023_SSM_PARAMETER,
  "--query",
  "Parameter.Value",
]);

// Best-effort and optional: the pin-vs-published question — the one that
// actually decides whether to plan a roll — needs no EC2 permission at all, so
// a caller without one still gets the answer that matters.
let running = null;
if (stackName) {
  running = aws([
    "ec2",
    "describe-instances",
    "--filters",
    `Name=tag:aws:cloudformation:stack-name,Values=${stackName}`,
    "Name=instance-state-name,Values=running",
    "--query",
    "Reservations[0].Instances[0].ImageId",
  ]);
}

const verdict = amiPinStatus({ pinned: PINNED_AMI_ID, latest, running });
console.log(describeVerdict(verdict, PINNED_AMI_ID));
if (stackName && running === null) {
  console.log(`(could not read a running instance for stack ${stackName} — pin check above still stands)`);
}

process.exit(
  verdict.state === "current" ? 0 : verdict.state === "unknown" ? 2 : 1,
);

// Says whether the pinned AMI has fallen behind what AWS publishes.
//
// Why a command and not a line in a runbook: the pin (CLAUDE.md invariant 12)
// stops AWS from replacing the production database VM on an unrelated deploy,
// and the accepted cost is that OS patches then arrive only when someone rolls
// the pin. Two documents already said "compare the pin with the current
// AL2023". Both were right, neither was executable, and the comparison went
// four weeks without being made. This is that sentence, made runnable.
//
//   npm run check:ami                              # pin vs the published AL2023
//   npm run check:ami -- --stack <name>            # also check the RUNNING instance(s)
//   npm run check:ami -- --region <r> --stack <n>  # same, in another pinned region
//   npm run check:ami -- --all-regions             # every pinned region, every stack of
//                                                  # this package found there
//
// ONE region per check, used for all three questions — the pin of that region,
// the image AWS publishes there, and the instance looked up there by stack tag.
// It comes from `--region`, else AWS_REGION, else AWS_DEFAULT_REGION, else
// eu-west-1 (`resolveRegion`, lib/ami-region.ts). Until 2026-11-18 only `--region`
// counted: `AWS_REGION=ca-central-1 … --stack <ca stack>` measured the eu-west-1
// pin and searched Ireland for a Canadian stack, so drift in Canada went unseen.
//
// Exit codes are the point — a caller (the agent's twice-daily sweep, a human,
// CI if anyone wants it) branches on them without parsing prose:
//   0  in sync
//   1  a newer AL2023 exists, or a running instance is on neither → plan a roll
//   2  could not determine (no aws CLI, no credentials, unreadable parameter,
//      a --stack that designates no running instance in the measured region,
//      or, with --all-regions, a pinned region where no stack was found)
//
// 2 is deliberately NOT 0. A check that cannot see must not report health —
// including when the blindness was caused by the caller's own argument. Passing
// --stack and getting 0 means BOTH halves were verified; see `exitCodeFor`.
import { execFileSync } from "node:child_process";
import {
  AL2023_SSM_PARAMETER,
  PINNED_AMI_IDS,
  PINNED_AMI_REGION,
  amiPinStatus,
  describeLookup,
  describeVerdict,
  exitCodeFor,
} from "../lib/ami-pin.ts";
import {
  combineExitCodes,
  describeStackRegion,
  isPackageStack,
  pickRunningImage,
  resolveRegion,
} from "../lib/ami-region.ts";

const args = process.argv.slice(2);
const stackName = argValue("--stack");
const allRegions = args.includes("--all-regions");

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

/**
 * Run an aws CLI call in `region` — always passed explicitly, so the CLI's own
 * profile default can never silently pick a different region than the pin's.
 *
 * Returns the two outcomes SEPARATELY — `{ok:true, value}` where `value` may be
 * null for "ran fine, matched nothing", and `{ok:false, error}` for "could not
 * run". Collapsing those two into one null is what let a truncated stack name
 * masquerade as a permissions problem and silently disable half this check.
 */
function aws(region, cliArgs) {
  try {
    const out = execFileSync("aws", [...cliArgs, "--region", region, "--output", "text"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, value: out === "" || out === "None" ? null : out };
  } catch (err) {
    return { ok: false, error: firstLine(err) };
  }
}

/** The aws CLI puts the useful part on stderr; keep one line of it. */
function firstLine(err) {
  const raw = String(err?.stderr ?? err?.message ?? err).trim();
  return raw.split("\n").find((l) => l.trim()) ?? "aws CLI failed";
}

const words = (value) => (value ? value.split(/\s+/).filter(Boolean) : []);

/** Every running instance of the stack, in `region`; the image compared is any off the pin. */
function lookUpInstance(region, name, pinned) {
  const res = aws(region, [
    "ec2",
    "describe-instances",
    "--filters",
    `Name=tag:aws:cloudformation:stack-name,Values=${name}`,
    "Name=instance-state-name,Values=running",
    "--query",
    "Reservations[].Instances[].ImageId",
  ]);
  if (!res.ok) return { state: "unreadable", stackName: name, reason: res.error };
  const imageId = pickRunningImage(words(res.value), pinned);
  if (imageId === null) return { state: "no-match", stackName: name };
  return { state: "found", imageId, count: words(res.value).length };
}

/** Does the stack exist in `region`? null = could not tell. */
function stackExists(region, name) {
  const res = aws(region, ["cloudformation", "describe-stacks", "--stack-name", name, "--query", "Stacks[0].StackName"]);
  if (res.ok) return res.value !== null;
  return /does not exist/.test(res.error) ? false : null;
}

/** Best-effort: stacks whose name starts with what the caller typed. */
function suggestStacks(region, prefix) {
  const res = aws(region, [
    "cloudformation",
    "list-stacks",
    "--stack-status-filter",
    "CREATE_COMPLETE",
    "UPDATE_COMPLETE",
    "UPDATE_ROLLBACK_COMPLETE",
    "--query",
    `StackSummaries[?starts_with(StackName,'${prefix}')].StackName`,
  ]);
  return res.ok ? words(res.value).slice(0, 5) : [];
}

/** One region, one optional stack: print the verdict, return the exit code. */
function checkRegion(region, stack) {
  const tag = `[${region}${stack ? ` ${stack}` : ""}]`;
  // The pin OF the region measured (t_rca_p0_infra): comparing the eu-west-1 id
  // with another region's published image would report a permanent "behind".
  const pinned = PINNED_AMI_IDS[region];
  if (!pinned) {
    console.log(`${tag} No pinned AMI for ${region} (pinned: ${Object.keys(PINNED_AMI_IDS).join(", ")}).`);
    return 2;
  }
  const latestResult = aws(region, ["ssm", "get-parameter", "--name", AL2023_SSM_PARAMETER, "--query", "Parameter.Value"]);
  const latest = latestResult.ok ? latestResult.value : null;

  // The pin-vs-published question — the one that decides whether to plan a
  // roll — needs no EC2 permission at all, so a caller without one still gets
  // the answer that matters by simply not passing --stack.
  const lookup = stack ? lookUpInstance(region, stack, pinned) : { state: "not-requested" };
  const running = lookup.state === "found" ? lookup.imageId : null;
  const verdict = amiPinStatus({ pinned, latest, running });

  console.log(`${tag} ${describeVerdict(verdict, pinned)}`);
  // A behind pin outranks the instance in the verdict; say what the instance
  // is on anyway, so a sweep still learns whether the LAST roll reached it.
  if (lookup.state === "found") {
    const onPin = lookup.imageId === pinned;
    console.log(`${tag} ${lookup.count} running instance(s) checked: ${onPin ? "all on the pin" : `one is on ${lookup.imageId}, not the pin`}.`);
  }
  const lookupLine = describeLookup(lookup);
  if (lookupLine) {
    console.log(`${tag} ${lookupLine}`);
    if (lookup.state === "no-match") explainNoMatch(region, stack, tag);
  }
  return exitCodeFor(verdict, lookup);
}

/**
 * A name that matches nothing is either in another region or a truncation.
 * Both get a hint, never a silent substitution: guessing which stack was
 * intended is exactly the helpfulness that would hide the next mistake.
 */
function explainNoMatch(region, stack, tag) {
  if (stackExists(region, stack) === false) {
    const others = Object.keys(PINNED_AMI_IDS).filter((r) => r !== region && stackExists(r, stack));
    console.log(`${tag} ${describeStackRegion(stack, region, others)}`);
    if (others.length > 0) return;
  }
  for (const candidate of suggestStacks(region, stack)) console.log(`${tag}   did you mean: ${candidate}`);
}

/** This package's stacks in `region`, found by their marker output — never by name. */
function discoverStacks(region) {
  const res = aws(region, ["cloudformation", "describe-stacks", "--query", "Stacks[].[StackName, join(',', Outputs[].OutputKey || `[]`)]"]);
  if (!res.ok) return { ok: false, error: res.error };
  const rows = (res.value ?? "").split("\n").filter(Boolean).map((l) => l.split("\t"));
  return { ok: true, stacks: rows.filter(([, keys]) => isPackageStack((keys ?? "").split(","))).map(([n]) => n) };
}

function runAllRegions() {
  const codes = [];
  for (const region of Object.keys(PINNED_AMI_IDS)) {
    const found = discoverStacks(region);
    if (!found.ok) {
      console.log(`[${region}] Could not list stacks: ${found.error}. The instances were NOT checked.`);
      codes.push(2, checkRegion(region, undefined));
    } else if (found.stacks.length === 0) {
      // A region is pinned because a stack runs there: finding none means the
      // discovery is blind, and blindness is never 0.
      console.log(`[${region}] No stack of this package found. The instances were NOT checked.`);
      codes.push(2, checkRegion(region, undefined));
    } else {
      for (const stack of found.stacks) codes.push(checkRegion(region, stack));
    }
  }
  return combineExitCodes(codes);
}

if (allRegions) {
  if (stackName || argValue("--region")) {
    console.log("--all-regions discovers the stacks itself: drop --stack / --region.");
    process.exit(2);
  }
  process.exit(runAllRegions());
}
const { region, source } = resolveRegion(argValue("--region"), process.env, PINNED_AMI_REGION);
if (source !== "default") console.log(`Region ${region} (from ${source}).`);
process.exit(checkRegion(region, stackName));

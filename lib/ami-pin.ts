// The AMI pin, and the one function that says whether it has fallen behind.
//
// The pin itself is CLAUDE.md invariant 12: the launch template gets a literal
// AMI id, never a `latestAmazonLinux2023()` lookup, because that lookup
// re-resolves at every deploy and terminates the production database VM the
// first time anything is deployed after AWS publishes an image (~monthly).
//
// The pin has a cost, and this file exists because we kept paying it silently:
// OS security patches no longer arrive by accident, so they arrive only when
// someone bumps `PINNED_AMI_ID`. Both this package's notes and the agent's
// sweep recipe already said "compare the pin with the current AL2023" — in
// prose, as a thing to remember. Nobody ever did, and on 2026-08-03 the sweep
// found a VM that had been running the same image for four weeks.
//
// A written instruction that nothing executes is not a control. So the
// comparison lives here as code, `npm run check:ami` runs it, and the sweep
// runs that command instead of remembering a procedure. The command's exit
// code is the signal: a newer AL2023 makes it fail, which is what turns
// "somebody should look" into a planned, announced roll.

/** Region the pinned id belongs to — an AMI id is region-scoped. */
export const PINNED_AMI_REGION = "eu-west-1";

/**
 * AL2023, kernel 6.1, arm64, eu-west-1; published 2026-08-03, rolled 2026-08-05
 * (previous pin: `ami-0ab117b5527d5fe24`, published 2026-07-27 — the first roll
 * `check:ami` ever asked for, four days after the check existed). To roll the
 * OS: `npm run check:ami`, bump this constant to the id it reports, publish the
 * package, and roll it out through a connector release. Rolling replaces the VM
 * — ~60 s with no Data API — so it is a dated, announced act, never a side
 * effect.
 */
export const PINNED_AMI_ID = "ami-053d8df569ac57bbb";

/**
 * The SSM public parameter the pin is measured against. It MUST stay the same
 * parameter the pin was taken from: `al2023-ami-kernel-default-arm64` follows
 * whatever kernel AL2023 currently defaults to, while `-kernel-6.1-` is frozen
 * on that line. They resolve to the same image today and will diverge the day
 * AL2023 moves its default — at which point comparing against the wrong one
 * would report a permanent, unfixable "upgrade available".
 */
export const AL2023_SSM_PARAMETER =
  "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64";

export type AmiPinVerdict =
  /** The pin is the newest published image. Nothing to do. */
  | { state: "current" }
  /** A newer image exists: propose a dated roll. */
  | { state: "behind"; latest: string }
  /** The running instance is on neither — it predates the current pin. */
  | { state: "instance-stale"; running: string }
  /** Something could not be read; never mistake this for "current". */
  | { state: "unknown"; reason: string };

export interface AmiPinInput {
  /** `PINNED_AMI_ID`, or whatever a caller pinned. */
  pinned: string;
  /** Resolved from `AL2023_SSM_PARAMETER`; null when it could not be read. */
  latest: string | null;
  /**
   * `ImageId` of the instance actually running, when the caller could read it.
   * Optional on purpose: the drift that matters is pin-vs-published, and that
   * question needs no EC2 permission at all.
   */
  running?: string | null;
}

/**
 * Compare a pin with what AWS publishes — pure, so the test suite covers every
 * branch without credentials or a network.
 *
 * Order matters. An unreadable parameter is reported as `unknown` rather than
 * assumed current: this function's whole job is to be the thing that notices,
 * and a check that silently passes when it cannot see is worse than no check,
 * because it manufactures the reassurance nobody verified.
 *
 * A stale *instance* is reported separately from a stale *pin*. They have
 * different causes and different fixes: a behind pin means AWS published
 * something and we should plan a roll; an instance that matches neither means a
 * previous pin bump was published but never rolled out, so the fix is a deploy,
 * not an edit.
 */
export function amiPinStatus({
  pinned,
  latest,
  running,
}: AmiPinInput): AmiPinVerdict {
  if (!latest) {
    return { state: "unknown", reason: `could not resolve ${AL2023_SSM_PARAMETER}` };
  }
  if (pinned !== latest) return { state: "behind", latest };
  if (running && running !== pinned) {
    return { state: "instance-stale", running };
  }
  return { state: "current" };
}

/**
 * What came back when the caller asked about a specific stack's instance.
 *
 * The four cases exist because the script used to collapse the last three into
 * one `null`, and that cost us the check. On 2026-08-05 the sweep ran with a
 * TRUNCATED stack name (`p-263b1e67` for
 * `p-263b1e67-4f7d-498a-8f5a-8635f2e68a87`). The CloudFormation tag filter is an
 * exact match, so it selected nothing, `describe-instances` returned an empty
 * `Reservations`, and that empty result was indistinguishable from "no
 * permission" — reported as a gentle aside while the command exited 0. The
 * `instance-stale` branch had therefore never once executed since it shipped.
 *
 * `no-match` is a bad ARGUMENT and says so; `unreadable` is a bad ENVIRONMENT.
 * Neither may exit 0, because both leave the question the caller actually asked
 * unanswered — the same rule that already makes an unresolvable SSM parameter
 * `unknown` rather than `current`.
 */
export type InstanceLookup =
  /** No `--stack` was passed: only the pin was ever in question. */
  | { state: "not-requested" }
  /** The stack's running instance was read. */
  | { state: "found"; imageId: string }
  /** The lookup worked and matched nothing — the stack name designates no instance. */
  | { state: "no-match"; stackName: string }
  /** The lookup itself failed: no CLI, no credentials, API error. */
  | { state: "unreadable"; stackName: string; reason: string };

/**
 * The command's exit code — the part callers actually branch on.
 *
 * 0 in sync · 1 a roll is needed · 2 could not determine.
 *
 * Two rules, in this order:
 *
 * 1. A known-actionable verdict wins. If the pin is behind, a roll is needed
 *    whether or not we could read an instance, so `1` — the more useful answer —
 *    beats "could not determine".
 * 2. Otherwise, a requested-but-unanswered instance question forbids `0`.
 *    Passing `--stack` and getting `0` now means BOTH halves were verified;
 *    that is the whole point of the flag.
 */
export function exitCodeFor(
  verdict: AmiPinVerdict,
  lookup: InstanceLookup,
): 0 | 1 | 2 {
  if (verdict.state === "behind" || verdict.state === "instance-stale") return 1;
  if (verdict.state === "unknown") return 2;
  return lookup.state === "not-requested" || lookup.state === "found" ? 0 : 2;
}

/** The line that explains a lookup that produced no image id. Empty when it did. */
export function describeLookup(lookup: InstanceLookup): string {
  switch (lookup.state) {
    case "not-requested":
    case "found":
      return "";
    case "no-match":
      return (
        `No running instance carries tag aws:cloudformation:stack-name=${lookup.stackName}. ` +
        `That filter is an exact match, so a truncated or misspelt stack name selects nothing — ` +
        `pass the FULL stack name. The instance was NOT checked.`
      );
    case "unreadable":
      return (
        `Could not read the running instance of ${lookup.stackName}: ${lookup.reason}. ` +
        `The instance was NOT checked.`
      );
  }
}

/** One line a human (or a Telegram digest) can read without context. */
export function describeVerdict(v: AmiPinVerdict, pinned: string): string {
  switch (v.state) {
    case "current":
      return `AMI pin is current (${pinned}).`;
    case "behind":
      return `A newer AL2023 exists: ${v.latest} (pinned: ${pinned}). Plan a roll — bump PINNED_AMI_ID, publish, connector release, announce.`;
    case "instance-stale":
      return `The running instance is on ${v.running}, but the pin is ${pinned} — a bumped pin was never rolled out. Fix with a deploy, not an edit.`;
    case "unknown":
      return `Could not determine AMI freshness: ${v.reason}. This is NOT "up to date".`;
  }
}

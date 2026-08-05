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

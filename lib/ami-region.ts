// Which region `npm run check:ami` measures, and how it finds this package's
// stacks there — pure, so the test suite covers it without credentials.
//
// Why this file exists: the script used to take its region from `--region`
// ONLY, defaulting to eu-west-1, and then passed that region explicitly to
// every aws call. `AWS_REGION=ca-central-1 npm run check:ami -- --stack <ca>`
// therefore compared the eu-west-1 pin with the eu-west-1 image AND looked the
// Canadian stack up in Ireland — where it does not exist — and reported "no
// running instance carries tag …". The variable every other AWS tool honours
// was silently overridden, and image drift in Canada was never seen.
//
// One region, chosen once, used for all three questions (the pin, the
// published image, the running instance): flag, then environment, then the
// default.

/** Where the measured region came from — printed, so a run says what it looked at. */
export type RegionSource = "--region" | "AWS_REGION" | "AWS_DEFAULT_REGION" | "default";

export interface ResolvedRegion {
  region: string;
  source: RegionSource;
}

/**
 * `--region` wins, then `AWS_REGION`, then `AWS_DEFAULT_REGION` (the aws CLI's
 * own order for the two variables), then `fallback`. Empty strings count as
 * unset: `AWS_REGION= npm run …` must not produce a region named "".
 */
export function resolveRegion(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  fallback: string,
): ResolvedRegion {
  if (flag) return { region: flag, source: "--region" };
  if (env.AWS_REGION) return { region: env.AWS_REGION, source: "AWS_REGION" };
  if (env.AWS_DEFAULT_REGION) {
    return { region: env.AWS_DEFAULT_REGION, source: "AWS_DEFAULT_REGION" };
  }
  return { region: fallback, source: "default" };
}

/**
 * The image to compare with the pin, given EVERY running instance of a stack.
 *
 * A stack runs one VM per cell (`vmCount`), and briefly two during a roll. The
 * script used to read `Instances[0]` only, so a cell left on an old image was
 * invisible whenever another cell happened to be listed first. Any instance off
 * the pin is the answer; only when all match is the pin returned.
 */
export function pickRunningImage(imageIds: readonly string[], pinned: string): string | null {
  if (imageIds.length === 0) return null;
  return imageIds.find((id) => id !== pinned) ?? pinned;
}

/**
 * The CloudFormation output that marks a stack as THIS package's, for
 * `--all-regions`. It is emitted by this package alone (since 0.1.54): the
 * forked `hereya/aws-sqlite-db` shares most other output names, and its AMI is
 * not governed by this pin, so matching on a shared output would compare it
 * with the wrong one. Discovery by output keeps prod stack names out of code.
 */
export const PACKAGE_STACK_MARKER_OUTPUT = "iamPolicySqliteRefusalRead";

/** Does a stack's list of output keys mark it as one of this package's stacks? */
export function isPackageStack(outputKeys: readonly string[]): boolean {
  return outputKeys.includes(PACKAGE_STACK_MARKER_OUTPUT);
}

/**
 * Exit code of several region/stack checks: a roll (1) outranks "could not
 * determine" (2), which outranks "in sync" (0) — the rule `exitCodeFor` applies
 * within one check, applied across them.
 */
export function combineExitCodes(codes: readonly (0 | 1 | 2)[]): 0 | 1 | 2 {
  if (codes.includes(1)) return 1;
  if (codes.includes(2)) return 2;
  return 0;
}

/**
 * The line printed when a stack is absent from the measured region. Naming the
 * region it IS in turns "no running instance" into the actual mistake.
 */
export function describeStackRegion(
  stackName: string,
  measured: string,
  foundIn: readonly string[],
): string {
  const where =
    foundIn.length > 0
      ? `It exists in ${foundIn.join(", ")} — pass --region ${foundIn[0]} (or set AWS_REGION).`
      : `It was not found in any pinned region either.`;
  return `Stack ${stackName} does not exist in ${measured}, the region measured. ${where}`;
}

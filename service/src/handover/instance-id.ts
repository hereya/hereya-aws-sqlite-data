// This machine's EC2 instance id, or null off EC2 / when IMDS refuses.
//
// The handover uses it for exactly one decision that matters: a departing
// instance must not mistake its OWN warming announcement for a replacement's
// (`observeWarming`). Null is therefore not fatal but it is not free either —
// without an id the two sides cannot tell each other apart, so the caller
// treats it the way it treats every other unknown here: fall back to the slow,
// correct path rather than guess.
const IMDS_BASE = "http://169.254.169.254";

export async function readInstanceId(base = IMDS_BASE): Promise<string | null> {
  try {
    const tokenRes = await fetch(`${base}/latest/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(3000),
    });
    if (!tokenRes.ok) return null;
    const token = await tokenRes.text();
    const res = await fetch(`${base}/latest/meta-data/instance-id`, {
      headers: { "X-aws-ec2-metadata-token": token },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const id = (await res.text()).trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

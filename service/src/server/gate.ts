import { verifyCapability } from "../capability.ts";
import { ServiceError } from "../errors.ts";
import type { Authorize, ServerDeps } from "./deps.ts";

export interface Gate {
  enforceCapability: (
    capHeader: string | undefined,
    routeName: string,
    orgId: string | undefined,
    appId: string | undefined,
  ) => void;
  authorize: Authorize;
}

export function createGate(deps: ServerDeps): Gate {
  const { cfg, registry } = deps;

  /**
   * Capability gate — binds the SigV4 caller to the (org, app) it operates on.
   * ADDITIONAL to authorize(); never a replacement. Runs before any DB work.
   *   - header present → must verify AND its (org, app) must equal the request's
   *     pair, else CAPABILITY_DENIED (403).
   *   - header absent  → enforce=true denies; enforce=false allows but logs a
   *     distinct cap_missing warn (the rollout-compat window).
   */
  function enforceCapability(
    capHeader: string | undefined,
    routeName: string,
    orgId: string | undefined,
    appId: string | undefined,
  ): void {
    if (capHeader !== undefined) {
      const res = verifyCapability(capHeader, cfg.capabilitySecret, Math.floor(Date.now() / 1000));
      if (!res.ok) {
        throw new ServiceError("CAPABILITY_DENIED", `capability rejected: ${res.reason}`);
      }
      if (res.orgId !== orgId || res.appId !== appId) {
        throw new ServiceError("CAPABILITY_DENIED", "capability rejected: pair_mismatch");
      }
      return;
    }
    if (cfg.capabilityEnforce) {
      throw new ServiceError("CAPABILITY_DENIED", "capability token required");
    }
    console.warn(JSON.stringify({ type: "cap_missing", route: routeName, orgId, appId }));
  }

  /** Fail-closed org/app check — the VM-side half of the spec §6 double control. */
  async function authorize(orgId: string, appId: string): Promise<void> {
    const status = await registry.lookup(orgId, appId);
    if (status !== "active") {
      throw new ServiceError("CROSS_ORG_DENIED", "unknown or inactive org/app pair");
    }
    // Registry says active: make sure the local db is restored before any
    // worker can create an empty file that would shadow the S3 replica.
    if (deps.ensureServed) await deps.ensureServed(orgId, appId);
  }

  return { enforceCapability, authorize };
}

import { readFileSync, statSync } from "node:fs";
import { ServiceError } from "./errors.ts";

export type RegistryStatus = "active" | "inactive" | "unknown";

export interface AppRef {
  orgId: string;
  appId: string;
}

/**
 * The service's own copy of the org/app registry — the defense-in-depth check
 * (spec §6): it never trusts the connector's declared pair. Every lookup is
 * fail-closed: backend errors surface as UNAVAILABLE, never as "allowed".
 */
export interface Registry {
  lookup(orgId: string, appId: string): Promise<RegistryStatus>;
  listActive(): Promise<AppRef[]>;
  reload(): Promise<void>;
}

interface FileEntry {
  org_id: string;
  app_id: string;
  status: string;
}

/**
 * Local-dev registry: a JSON file of {org_id, app_id, status} entries,
 * re-read when its mtime changes. The DynamoDB registry lands with the AWS
 * wiring; this keeps the whole API testable on a laptop.
 */
export class FileRegistry implements Registry {
  private readonly file: string;
  private entries = new Map<string, RegistryStatus>();
  private loadedMtimeMs = -1;

  constructor(file: string) {
    if (!file) throw new Error("REGISTRY_FILE is required in file registry mode");
    this.file = file;
  }

  async lookup(orgId: string, appId: string): Promise<RegistryStatus> {
    this.refresh();
    return this.entries.get(`${orgId}/${appId}`) ?? "unknown";
  }

  async listActive(): Promise<AppRef[]> {
    this.refresh();
    const active: AppRef[] = [];
    for (const [key, status] of this.entries) {
      if (status !== "active") continue;
      const [orgId, appId] = key.split("/") as [string, string];
      active.push({ orgId, appId });
    }
    return active;
  }

  async reload(): Promise<void> {
    this.loadedMtimeMs = -1;
    this.refresh();
  }

  private refresh(): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch (err) {
      throw new ServiceError("UNAVAILABLE", `registry file unreadable: ${(err as Error).message}`);
    }
    if (mtimeMs === this.loadedMtimeMs) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      throw new ServiceError("UNAVAILABLE", `registry file invalid: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new ServiceError("UNAVAILABLE", "registry file must be a JSON array");
    }
    const next = new Map<string, RegistryStatus>();
    for (const entry of parsed as FileEntry[]) {
      if (!entry || typeof entry.org_id !== "string" || typeof entry.app_id !== "string") continue;
      next.set(`${entry.org_id}/${entry.app_id}`, entry.status === "active" ? "active" : "inactive");
    }
    this.entries = next;
    this.loadedMtimeMs = mtimeMs;
  }
}

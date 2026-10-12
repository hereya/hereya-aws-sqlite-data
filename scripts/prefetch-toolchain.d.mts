// Types of scripts/prefetch-toolchain.mjs for the TypeScript tests (the script
// itself stays plain .mjs: it runs under the executor's system node at synth).
export interface PinnedAsset {
  name: string;
  url: string;
  pinKey: string;
}
export interface MirrorLocation {
  bucket: string;
  prefix: string;
  region: string;
}
export interface MirrorStore {
  get(bucket: string, key: string): Promise<Buffer | null>;
  has(bucket: string, key: string): Promise<boolean>;
  put(bucket: string, key: string, body: Buffer): Promise<void>;
}
export interface PrefetchRow {
  name: string;
  source: "cache" | "mirror" | "public" | null;
  mirrored: boolean;
}
export const DEFAULT_ROOT: string;
export const RETRY_DELAYS_MS: number[];
export const DEFAULT_MIRROR_PREFIX: string;
export function pinnedAssets(root?: string): PinnedAsset[];
export function readPins(root?: string): Record<string, string>;
export function mirrorLocation(env?: Record<string, string | undefined>): MirrorLocation | null;
export function fetchWithRetry(
  url: string,
  opts?: {
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    delays?: number[];
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  },
): Promise<Buffer>;
export function prefetchToolchain(opts?: {
  root?: string;
  env?: Record<string, string | undefined>;
  store?: MirrorStore;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<PrefetchRow[]>;

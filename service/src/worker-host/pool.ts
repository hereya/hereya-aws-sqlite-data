import { ServiceError } from "../errors.ts";
import { AppWorker, type AppWorkerCallbacks } from "./app-worker.ts";

export interface WorkerPoolOptions {
  maxLiveWorkers: number;
  workerPath: string;
  callbacks: AppWorkerCallbacks;
  /** Eviction guard: an executor with an open explicit tx must not be evicted. */
  canEvict: (appKey: string) => boolean;
  /** How long a NEW app may wait for a worker to become evictable. Default 10 s. */
  waitForRoomMs?: number;
}

/**
 * At most `maxLiveWorkers` child processes, least recently used evicted first.
 *
 * A worker is only ever handed out under a LEASE (`run`), and a leased worker
 * is never evicted. The pool used to return the worker and let the caller use
 * it: a newcomer arriving while every other worker was busy was then the only
 * "idle" one in the map, so the pool closed the worker it had just created and
 * the caller was answered 503 "app is shutting down" (t_worker_evict_inflight_503
 * — 100 parallel reads on 100 apps, ~9 of them). When nobody can be evicted the
 * newcomer WAITS for a lease to end; past `waitForRoomMs` it is refused with
 * UNAVAILABLE, which is true ("nothing ran") and which clients replay.
 */
export class WorkerPool {
  private readonly workers = new Map<string, AppWorker>();
  private readonly leases = new Map<AppWorker, number>();
  private waiters: Array<() => void> = [];
  private readonly opts: WorkerPoolOptions;

  constructor(opts: WorkerPoolOptions) {
    this.opts = opts;
  }

  async run<T>(appKey: string, dbPath: string, fn: (worker: AppWorker) => Promise<T>): Promise<T> {
    const worker = await this.lease(appKey, dbPath);
    try {
      return await fn(worker);
    } finally {
      this.unlease(worker);
    }
  }

  async remove(appKey: string): Promise<void> {
    const worker = this.workers.get(appKey);
    if (!worker) return;
    this.workers.delete(appKey);
    this.wake();
    await worker.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.workers.values()];
    this.workers.clear();
    this.wake();
    await Promise.all(all.map((w) => w.close()));
  }

  get size(): number {
    return this.workers.size;
  }

  private async lease(appKey: string, dbPath: string): Promise<AppWorker> {
    const deadline = Date.now() + (this.opts.waitForRoomMs ?? 10_000);
    for (;;) {
      let worker = this.workers.get(appKey);
      if (worker) {
        // refresh LRU position
        this.workers.delete(appKey);
        this.workers.set(appKey, worker);
      } else if (this.workers.size < this.opts.maxLiveWorkers || this.evictOne()) {
        worker = new AppWorker(appKey, dbPath, this.opts.workerPath, this.opts.callbacks);
        this.workers.set(appKey, worker);
      }
      if (worker) {
        this.leases.set(worker, (this.leases.get(worker) ?? 0) + 1);
        return worker;
      }
      await this.waitForRoom(deadline);
    }
  }

  private unlease(worker: AppWorker): void {
    const left = (this.leases.get(worker) ?? 1) - 1;
    if (left > 0) {
      this.leases.set(worker, left);
      return;
    }
    this.leases.delete(worker);
    this.wake();
  }

  private evictOne(): boolean {
    for (const [appKey, worker] of this.workers) {
      if (this.leases.has(worker) || worker.busy || !this.opts.canEvict(appKey)) continue;
      this.workers.delete(appKey);
      void worker.close();
      return true;
    }
    return false;
  }

  private waitForRoom(deadline: number): Promise<void> {
    const leftMs = deadline - Date.now();
    if (leftMs <= 0) {
      return Promise.reject(new ServiceError("UNAVAILABLE", "no sql executor became free in time"));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, leftMs);
      timer.unref();
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private wake(): void {
    const woken = this.waiters;
    this.waiters = [];
    for (const resolve of woken) resolve();
  }
}

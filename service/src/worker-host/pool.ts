import { AppWorker, type AppWorkerCallbacks } from "./app-worker.ts";

export interface WorkerPoolOptions {
  maxLiveWorkers: number;
  workerPath: string;
  callbacks: AppWorkerCallbacks;
  /** Eviction guard: an executor with an open explicit tx must not be evicted. */
  canEvict: (appKey: string) => boolean;
}

export class WorkerPool {
  private readonly workers = new Map<string, AppWorker>();
  private readonly opts: WorkerPoolOptions;

  constructor(opts: WorkerPoolOptions) {
    this.opts = opts;
  }

  get(appKey: string, dbPath: string): AppWorker {
    const existing = this.workers.get(appKey);
    if (existing) {
      // refresh LRU position
      this.workers.delete(appKey);
      this.workers.set(appKey, existing);
      return existing;
    }
    const worker = new AppWorker(appKey, dbPath, this.opts.workerPath, this.opts.callbacks);
    this.workers.set(appKey, worker);
    this.evictIfNeeded();
    return worker;
  }

  async remove(appKey: string): Promise<void> {
    const worker = this.workers.get(appKey);
    if (!worker) return;
    this.workers.delete(appKey);
    await worker.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(all.map((w) => w.close()));
  }

  get size(): number {
    return this.workers.size;
  }

  private evictIfNeeded(): void {
    if (this.workers.size <= this.opts.maxLiveWorkers) return;
    for (const [appKey, worker] of this.workers) {
      if (this.workers.size <= this.opts.maxLiveWorkers) break;
      if (!worker.busy && this.opts.canEvict(appKey)) {
        this.workers.delete(appKey);
        void worker.close();
      }
    }
  }
}

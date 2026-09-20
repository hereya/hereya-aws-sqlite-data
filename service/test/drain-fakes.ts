// A cell with apps on it, a mover that can be told how each move ends, and a
// Cloud Map presence — shared by the drainer tests (220-line split).
import { Drainer } from "../src/drain/drainer.ts";
import type { DrainOrder, DrainProgress } from "../src/drain/store.ts";
import type { MoveRequest, MoveResult } from "../src/move/mover.ts";

export const ORDER: DrainOrder = { cellId: "0", toCell: "1", big: "skip", leave: true, orderedAtMs: 1 };

export function world(apps: string[], opts: { sizes?: Record<string, number>; concurrency?: number } = {}) {
  const state = {
    order: { ...ORDER } as DrainOrder | null,
    orderReadFails: false,
    held: new Set(apps),
    targetUp: true,
    inCloudMap: true,
    calls: [] as string[],
    running: 0,
    maxRunning: 0,
    progress: null as DrainProgress | null,
    outcome: (_req: MoveRequest): "moved" | "resumed" | Error => "moved",
  };
  const drainer = new Drainer({
    cellId: "0",
    instanceId: () => "i-self",
    store: {
      readOrder: async () => {
        if (state.orderReadFails) throw new Error("ddb is down");
        return state.order;
      },
      putOrder: async () => {},
      deleteOrder: async () => {},
      readProgress: async () => state.progress,
      putProgress: async (p) => void (state.progress = p),
    },
    listHeld: async () => [...state.held].map((appId) => ({ orgId: "o", appId })),
    sizeOf: (_o, appId) => opts.sizes?.[appId] ?? 1,
    isMoving: () => false,
    moveOut: async (req): Promise<MoveResult> => {
      state.calls.push(req.appId);
      state.running += 1;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      await new Promise((r) => setTimeout(r, 5));
      state.running -= 1;
      const outcome = state.outcome(req);
      if (outcome instanceof Error) throw outcome;
      if (outcome === "moved") state.held.delete(req.appId);
      return { status: outcome, fromCell: "0", toCell: req.toCell, version: 1, pauseMs: 5, ...(outcome === "resumed" ? { reason: "the target did not claim the app" } : {}) };
    },
    targetReachable: async () => state.targetUp,
    presence: () => ({
      get inCloudMap() {
        return state.inCloudMap;
      },
      leave: async () => void (state.inCloudMap = false),
      enter: async () => void (state.inCloudMap = true),
    }),
    isShuttingDown: () => false,
    gatewayQuietMs: () => 1234,
    concurrency: opts.concurrency ?? 8,
    maxBytes: 100,
  });
  return { state, drainer };
}

export const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `app${i}`);

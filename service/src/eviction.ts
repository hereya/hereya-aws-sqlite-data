// Which replicated apps should STOP being replicated?
//
// The design — why eviction is safe, what "idle" means, and why it had to stop
// meaning "unwritten" — lives with the planner it justifies, in `eviction/plan.ts`.
// This file is the public surface those pieces are imported through.

export type {
  EvictionPlan,
  EvictionProbe,
  EvictionSkip,
  InjectedEvictionProbe,
} from "./eviction/types.ts";
export { planEviction } from "./eviction/plan.ts";
export { EVICT_TOUCH_GRACE_MS, daysToMs } from "./eviction/grace.ts";

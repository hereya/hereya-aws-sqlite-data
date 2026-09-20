// Dying ON PURPOSE at a named step of a move — how "a crash at every step" is
// tried for real on a throwaway stack (scripts/acceptance/move-trial.mjs).
//
// Inert unless the process was started with MOVE_CRASH_POINTS=on, which no
// stack sets: the trial adds it by hand on its own instances. SIGKILL, not
// exit(): no handler runs, no drain, no report — what a real crash leaves.
export const OUT_POINTS = ["after-begin", "after-detach", "after-a-stopped", "after-ask"] as const;
export const IN_POINTS = ["in-after-clear", "in-after-claim", "in-after-restore"] as const;

export function crashPoint(requested: string | undefined, here: string): void {
  if (requested !== here || process.env.MOVE_CRASH_POINTS !== "on") return;
  console.error(JSON.stringify({ type: "move", event: "crash-point", at: here }));
  process.kill(process.pid, "SIGKILL");
}

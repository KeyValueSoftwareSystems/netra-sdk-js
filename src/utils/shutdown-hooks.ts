/**
 * Shared shutdown-hook registry — avoids multiple independent
 * process.once('SIGINT', ...) listeners racing each other to exit first.
 * Installs the SDK's one real signal listener lazily, on first registration,
 * so it works even for a standalone RedTeam instance with no Netra.init().
 */

export const SHUTDOWN_HOOK_TIMEOUT_MS = 5000;

type ShutdownHook = () => void | Promise<void>;

const hooks = new Set<ShutdownHook>();
let installed = false;
let fired = false;
let running = false;

/** @internal Not a stable public API. Returns an unregister function. */
export function registerShutdownHook(hook: ShutdownHook): () => void {
  hooks.add(hook);

  if (!installed) {
    installed = true;
    const proc = typeof process !== "undefined" ? process : undefined;
    const onSignal = (signal: NodeJS.Signals) => {
      if (fired) return;
      fired = true;
      void runShutdownHooks().finally(() => {
        if (proc && typeof proc.kill === "function" && proc.pid !== undefined) {
          proc.kill(proc.pid, signal);
        }
      });
    };
    if (proc && typeof proc.once === "function") {
      proc.once("SIGINT", () => onSignal("SIGINT"));
      proc.once("SIGTERM", () => onSignal("SIGTERM"));
    }
  }

  return () => {
    hooks.delete(hook);
  };
}

/**
 * @internal Runs every hook concurrently, bounded by SHUTDOWN_HOOK_TIMEOUT_MS.
 * Guarded against re-entrancy: Netra.shutdown() is itself a registered hook
 * and also calls this function, which would otherwise recurse forever.
 */
export async function runShutdownHooks(): Promise<void> {
  if (running) return;
  running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settle = Promise.allSettled([...hooks].map((hook) => hook()));
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_HOOK_TIMEOUT_MS);
    });
    await Promise.race([settle, timeout]);
  } finally {
    // Otherwise a hook that finishes well within the timeout still leaves this timer
    // pending, holding the event loop open for the remainder of SHUTDOWN_HOOK_TIMEOUT_MS.
    clearTimeout(timer);
    running = false;
  }
}

/** @internal Test-only — the real SIGINT/SIGTERM listener is a singleton, so listenerCount() can't tell runs apart. */
export function _hookCountForTests(): number {
  return hooks.size;
}

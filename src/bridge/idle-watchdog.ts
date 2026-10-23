export interface IdleWatchdogOptions {
  timeoutMs: number;
  getExternalActivityAt?: () => number | undefined;
  onIdle: () => void;
}

export interface IdleWatchdog {
  markActivity(): void;
  stop(): void;
}

/**
 * Abort only after both the translated stream and the underlying engine have
 * been silent for the full timeout. Some engines emit valid process activity
 * that their message translator intentionally does not surface to the UI.
 */
export function startIdleWatchdog(options: IdleWatchdogOptions): IdleWatchdog {
  let lastStreamActivityAt = Date.now();
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const latestActivityAt = (): number => Math.max(
    lastStreamActivityAt,
    options.getExternalActivityAt?.() ?? 0,
  );

  const schedule = (): void => {
    if (stopped) return;
    if (timerId) clearTimeout(timerId);
    const idleForMs = Math.max(0, Date.now() - latestActivityAt());
    const remainingMs = Math.max(1, options.timeoutMs - idleForMs);
    timerId = setTimeout(check, remainingMs);
  };

  const check = (): void => {
    timerId = undefined;
    if (stopped) return;
    if (Date.now() - latestActivityAt() >= options.timeoutMs) {
      stopped = true;
      options.onIdle();
      return;
    }
    schedule();
  };

  schedule();

  return {
    markActivity: () => {
      if (stopped) return;
      lastStreamActivityAt = Date.now();
      schedule();
    },
    stop: () => {
      stopped = true;
      if (timerId) clearTimeout(timerId);
      timerId = undefined;
    },
  };
}

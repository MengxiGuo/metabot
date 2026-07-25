import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startIdleWatchdog } from '../src/bridge/idle-watchdog.js';

describe('idle watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires after a full timeout with no activity', () => {
    const onIdle = vi.fn();
    startIdleWatchdog({ timeoutMs: 60_000, onIdle });

    vi.advanceTimersByTime(59_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('uses low-level engine activity even when no stream message is emitted', () => {
    const onIdle = vi.fn();
    let engineActivityAt = Date.now();
    startIdleWatchdog({
      timeoutMs: 60_000,
      getExternalActivityAt: () => engineActivityAt,
      onIdle,
    });

    vi.advanceTimersByTime(50_000);
    engineActivityAt = Date.now();
    vi.advanceTimersByTime(59_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('resets on translated stream activity and can be stopped', () => {
    const onIdle = vi.fn();
    const watchdog = startIdleWatchdog({ timeoutMs: 60_000, onIdle });

    vi.advanceTimersByTime(50_000);
    watchdog.markActivity();
    vi.advanceTimersByTime(50_000);
    expect(onIdle).not.toHaveBeenCalled();

    watchdog.stop();
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

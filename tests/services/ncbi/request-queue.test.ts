/**
 * @fileoverview Tests for the NCBI rate-limited request queue.
 * @module tests/services/ncbi/request-queue.test
 */

import { describe, expect, it, vi } from 'vitest';
import { NcbiRequestQueue } from '@/services/ncbi/request-queue.js';

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
  requestContextService: {
    createRequestContext: vi.fn(() => ({ requestId: 'test' })),
  },
}));

describe('NcbiRequestQueue', () => {
  it('executes a single enqueued task', async () => {
    const queue = new NcbiRequestQueue(0);
    const result = await queue.enqueue(() => Promise.resolve('done'), 'test', { db: 'pubmed' });
    expect(result).toBe('done');
  });

  it('dispatches multiple tasks in FIFO order', async () => {
    const queue = new NcbiRequestQueue(0);
    const dispatched: number[] = [];

    const t1 = queue.enqueue(
      async () => {
        dispatched.push(1);
        return 1;
      },
      'e1',
      {},
    );
    const t2 = queue.enqueue(
      async () => {
        dispatched.push(2);
        return 2;
      },
      'e2',
      {},
    );
    const t3 = queue.enqueue(
      async () => {
        dispatched.push(3);
        return 3;
      },
      'e3',
      {},
    );

    const results = await Promise.all([t1, t2, t3]);
    expect(results).toEqual([1, 2, 3]);
    expect(dispatched).toEqual([1, 2, 3]);
  });

  it('runs tasks concurrently up to maxConcurrent', async () => {
    const queue = new NcbiRequestQueue(0, 3);
    let inFlight = 0;
    let peak = 0;

    const task = () => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => setTimeout(r, 30));
      inFlight -= 1;
    };

    await Promise.all([
      queue.enqueue(task(), 'a', {}),
      queue.enqueue(task(), 'b', {}),
      queue.enqueue(task(), 'c', {}),
    ]);

    expect(peak).toBe(3);
  });

  it('caps in-flight tasks at maxConcurrent', async () => {
    const queue = new NcbiRequestQueue(0, 2);
    let inFlight = 0;
    let peak = 0;

    const task = () => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => setTimeout(r, 30));
      inFlight -= 1;
    };

    await Promise.all([
      queue.enqueue(task(), 'a', {}),
      queue.enqueue(task(), 'b', {}),
      queue.enqueue(task(), 'c', {}),
      queue.enqueue(task(), 'd', {}),
    ]);

    expect(peak).toBe(2);
  });

  it('rejects a queued task when its abort signal fires before dispatch', async () => {
    const queue = new NcbiRequestQueue(0, 1);

    // Block the only in-flight slot.
    const blockerTask = vi.fn(() => new Promise<void>((r) => setTimeout(r, 100)));
    const blocker = queue.enqueue(blockerTask, 'blocker', {});

    const controller = new AbortController();
    const queuedTask = vi.fn(() => Promise.resolve('done'));
    const queued = queue.enqueue(queuedTask, 'queued', {}, controller.signal);

    controller.abort(new Error('queue wait cancelled'));

    await expect(queued).rejects.toThrow(/queue wait cancelled/);
    expect(queuedTask).not.toHaveBeenCalled();

    await blocker;
    expect(blockerTask).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately when the abort signal is already aborted', async () => {
    const queue = new NcbiRequestQueue(0, 4);
    const controller = new AbortController();
    controller.abort(new Error('already aborted'));

    const task = vi.fn(() => Promise.resolve());
    await expect(queue.enqueue(task, 'ep', {}, controller.signal)).rejects.toThrow(
      /already aborted/,
    );
    expect(task).not.toHaveBeenCalled();
  });

  it('rejects when queue is full', async () => {
    // maxConcurrent=1 → only one task can be in flight; maxQueueSize=1 → one
    // task can wait. A third request overflows.
    const queue = new NcbiRequestQueue(0, 1, 1);
    const blocking = new Promise<void>((resolve) => setTimeout(resolve, 100));
    queue.enqueue(() => blocking, 'blocking', {}); // takes the in-flight slot
    const waiting = queue.enqueue(() => Promise.resolve(), 'waiting', {}); // fills the queue

    await expect(queue.enqueue(() => Promise.resolve(), 'overflow', {})).rejects.toThrow(
      /queue is full/,
    );

    await waiting;
  });

  it('queue-full rejection carries reason and recovery hint on the wire', async () => {
    const queue = new NcbiRequestQueue(0, 1, 1);
    const blocking = new Promise<void>((resolve) => setTimeout(resolve, 100));
    queue.enqueue(() => blocking, 'blocking', {});
    const waiting = queue.enqueue(() => Promise.resolve(), 'waiting', {});

    await expect(queue.enqueue(() => Promise.resolve(), 'overflow', {})).rejects.toMatchObject({
      data: {
        reason: 'queue_full',
        endpoint: 'overflow',
        recovery: { hint: expect.stringContaining('Retry after') },
      },
    });

    await waiting;
  });

  it('propagates task errors to the caller', async () => {
    const queue = new NcbiRequestQueue(0);
    await expect(
      queue.enqueue(() => Promise.reject(new Error('task failed')), 'fail', {}),
    ).rejects.toThrow('task failed');
  });

  it('continues processing after a failed task', async () => {
    const queue = new NcbiRequestQueue(0);
    const p1 = queue
      .enqueue(() => Promise.reject(new Error('fail')), 'e1', {})
      .catch(() => 'caught');
    const p2 = queue.enqueue(() => Promise.resolve('ok'), 'e2', {});

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('caught');
    expect(r2).toBe('ok');
  });

  it('does not block a fast task behind a slow one when concurrency > 1', async () => {
    const queue = new NcbiRequestQueue(0, 2);
    const completions: string[] = [];

    const slow = queue.enqueue(
      async () => {
        await new Promise<void>((r) => setTimeout(r, 100));
        completions.push('slow');
      },
      'slow',
      {},
    );
    const fast = queue.enqueue(
      async () => {
        await new Promise<void>((r) => setTimeout(r, 10));
        completions.push('fast');
      },
      'fast',
      {},
    );

    await Promise.all([slow, fast]);
    expect(completions).toEqual(['fast', 'slow']);
  }, 1000);

  it('serializes execution when maxConcurrent=1', async () => {
    const queue = new NcbiRequestQueue(0, 1);
    let inFlight = 0;
    let peak = 0;

    const task = () => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => setTimeout(r, 20));
      inFlight -= 1;
    };

    await Promise.all([
      queue.enqueue(task(), 'a', {}),
      queue.enqueue(task(), 'b', {}),
      queue.enqueue(task(), 'c', {}),
    ]);

    expect(peak).toBe(1);
  }, 1000);

  it('handles a burst of 50 tasks without losing any', async () => {
    const queue = new NcbiRequestQueue(0, 4);

    const tasks = Array.from({ length: 50 }, (_, i) =>
      queue.enqueue(
        async () => {
          await new Promise<void>((r) => setTimeout(r, 5));
          return i;
        },
        `ep-${i}`,
        {},
      ),
    );

    const finished = await Promise.all(tasks);
    expect(finished).toHaveLength(50);
    expect(new Set(finished).size).toBe(50);
    expect(finished).toEqual([...Array(50).keys()]);
  }, 2000);

  it('respects min-start-gap between consecutive starts with concurrency > 1', async () => {
    const queue = new NcbiRequestQueue(50, 3);
    const startTimes: number[] = [];
    const begin = Date.now();

    const tasks = [0, 1, 2].map((i) =>
      queue.enqueue(
        async () => {
          startTimes.push(Date.now() - begin);
          return i;
        },
        `e${i}`,
        {},
      ),
    );

    await Promise.all(tasks);

    // Starts should land near 0, 50, 100 with generous CI tolerance.
    expect(startTimes[0]).toBeLessThan(30);
    expect(startTimes[1] as number).toBeGreaterThanOrEqual(40);
    expect(startTimes[1] as number).toBeLessThan(110);
    expect(startTimes[2] as number).toBeGreaterThanOrEqual(90);
    expect(startTimes[2] as number).toBeLessThan(180);
  }, 2000);

  it('decrements inFlight when a task rejects, freeing the slot', async () => {
    const queue = new NcbiRequestQueue(0, 1);

    await expect(
      queue.enqueue(() => Promise.reject(new Error('boom')), 'fail', {}),
    ).rejects.toThrow('boom');

    // If inFlight didn't decrement, the next task would hang on the in-flight cap.
    const result = await queue.enqueue(() => Promise.resolve('ok'), 'next', {});
    expect(result).toBe('ok');
  }, 1000);

  it('decrements inFlight when a task throws synchronously', async () => {
    const queue = new NcbiRequestQueue(0, 1);

    await expect(
      queue.enqueue(
        (() => {
          throw new Error('sync boom');
        }) as () => Promise<unknown>,
        'sync-fail',
        {},
      ),
    ).rejects.toThrow('sync boom');

    const result = await queue.enqueue(() => Promise.resolve('ok'), 'next', {});
    expect(result).toBe('ok');
  }, 1000);

  it('does not reject a completed task when its signal aborts later', async () => {
    const queue = new NcbiRequestQueue(0, 1);
    const controller = new AbortController();
    let lateRejection: unknown;

    const promise = queue.enqueue(() => Promise.resolve('ok'), 'ep', {}, controller.signal);
    promise.catch((e) => {
      lateRejection = e;
    });

    const result = await promise;
    expect(result).toBe('ok');

    controller.abort(new Error('late'));
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(lateRejection).toBeUndefined();
  }, 1000);

  it('tolerates a pending dispatch timer after its waiter is cancelled', async () => {
    // Set lastStartTime by dispatching once, then enqueue a task that triggers
    // a gap-wait timer, then abort that task. The timer eventually fires and
    // must not throw despite having no waiters to dispatch.
    const queue = new NcbiRequestQueue(60, 2);

    await queue.enqueue(() => Promise.resolve(), 'priming', {});

    const controller = new AbortController();
    const queued = queue.enqueue(
      () => Promise.resolve('should-not-run'),
      'queued',
      {},
      controller.signal,
    );
    controller.abort(new Error('cancelled before gap elapsed'));
    await expect(queued).rejects.toThrow(/cancelled/);

    // Let the original gap timer fire and observe no errors / leftover state.
    await new Promise<void>((r) => setTimeout(r, 100));

    const fresh = await queue.enqueue(() => Promise.resolve('fresh'), 'fresh', {});
    expect(fresh).toBe('fresh');
  }, 2000);

  it('allows mixed signal / no-signal waiters in the same queue', async () => {
    const queue = new NcbiRequestQueue(0, 1);
    const blocker = queue.enqueue(() => new Promise<void>((r) => setTimeout(r, 50)), 'blocker', {});

    const controller = new AbortController();
    const withSignal = queue.enqueue(
      () => Promise.resolve('with-signal'),
      'with-signal',
      {},
      controller.signal,
    );
    const withoutSignal = queue.enqueue(
      () => Promise.resolve('without-signal'),
      'without-signal',
      {},
    );

    controller.abort(new Error('cancelled'));

    await expect(withSignal).rejects.toThrow(/cancelled/);
    const both = await Promise.all([blocker, withoutSignal]);
    expect(both[1]).toBe('without-signal');
  }, 2000);

  it('delays the next dispatch when requests arrive inside the rate-limit window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    try {
      const queue = new NcbiRequestQueue(1000);
      const firstTask = vi.fn(async () => 'first');
      const secondTask = vi.fn(async () => 'second');

      const first = queue.enqueue(firstTask, 'first', {});
      await vi.runAllTimersAsync();
      await expect(first).resolves.toBe('first');

      const second = queue.enqueue(secondTask, 'second', {});
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(999);
      expect(secondTask).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toBe('second');
      expect(secondTask).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

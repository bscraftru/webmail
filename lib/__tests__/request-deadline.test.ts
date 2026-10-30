import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withRequestDeadline } from '../request-deadline';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('aborts a request that does not settle even when the transport ignores cancellation', async () => {
  let signal: AbortSignal | undefined;
  const pending = withRequestDeadline(100, async value => {
    signal = value;
    return new Promise(() => {});
  });
  const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the deadline active while a response body is being read', async () => {
  let requestSignal: AbortSignal | undefined;
  const pending = withRequestDeadline(100, async signal => {
    requestSignal = signal;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }));
    return response.json();
  });
  const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  expect(requestSignal?.aborted).toBe(true);
});

it('propagates caller cancellation and removes its listener and timer', async () => {
  const external = new AbortController();
  const remove = vi.spyOn(external.signal, 'removeEventListener');
  const pending = withRequestDeadline(100, async () => new Promise(() => {}), external.signal);
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  external.abort();
  await assertion;
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the deadline after successful completion', async () => {
  let requestSignal: AbortSignal | undefined;
  await expect(withRequestDeadline(100, async signal => {
    requestSignal = signal;
    return 42;
  })).resolves.toBe(42);
  await vi.advanceTimersByTimeAsync(200);
  expect(requestSignal?.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

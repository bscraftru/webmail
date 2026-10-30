/** Bound a finite request, including the response body read inside `run`. */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  external?: AbortSignal | null,
): Promise<T> {
  external?.throwIfAborted();
  const controller = new AbortController();
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const cancel = (reason: unknown) => {
    controller.abort(reason);
    rejectCancellation(controller.signal.reason);
  };
  const onAbort = () => cancel(external?.reason);
  external?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => cancel(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError')), timeoutMs);
  try {
    return await Promise.race([run(controller.signal), cancellation]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }
}

export function isRequestDeadline(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

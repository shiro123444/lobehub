import { setTimeout } from 'node:timers/promises';

/** One bounded retry for a broken connection before a response; never retry user cancellation. */
export const createPresentationChatFetch =
  (fetcher: typeof fetch): typeof fetch =>
  async (input, init) => {
    const timeout = AbortSignal.timeout(90_000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetcher(input, { ...init, signal });
      } catch (error) {
        if (attempt >= 1 || signal.aborted || !(error instanceof TypeError)) throw error;
        await setTimeout(500, undefined, { signal });
      }
    }
  };

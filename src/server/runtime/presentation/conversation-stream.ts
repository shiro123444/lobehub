import type { PresentationActivity } from '@/types/presentationActivity';

import type { PresentationConversationResult } from './conversation-capability';

export const conversationStream = (
  execute: (
    onActivity: (activity: PresentationActivity) => void,
    signal: AbortSignal,
  ) => Promise<PresentationConversationResult>,
  dispose: () => Promise<void>,
  requestSignal: AbortSignal,
): Response => {
  const abort = new AbortController();
  const signal = AbortSignal.any([requestSignal, abort.signal]);
  const encoder = new TextEncoder();
  let closed = false;
  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (value: unknown) => {
          if (!closed && !signal.aborted)
            controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        };
        try {
          const result = await execute((activity) => send({ type: 'activity', activity }), signal);
          send({ type: 'result', result });
        } catch (error) {
          send({ type: 'error', message: error instanceof Error ? error.message : '创作暂时中断' });
        } finally {
          try {
            await dispose();
          } finally {
            if (!closed) {
              closed = true;
              controller.close();
            }
          }
        }
      },
      cancel() {
        closed = true;
        abort.abort();
      },
    }),
    {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    },
  );
};

import { describe, expect, it } from 'vitest';

import { createGLMMultimodalChatPort, type GLMChatFetcher } from './multimodal-chat-provider-glm';

const liveApiKey = process.env.BAI_API_KEY?.trim();

describe.skipIf(!liveApiKey)('GLMMultimodalChatAdapter Live Probe Smoke (optional)', () => {
  it('executes a live probe against https://api.b.ai with masked output', async () => {
    const liveFetcher: GLMChatFetcher = async (endpoint, init) => {
      const res = await fetch(endpoint, init);
      return {
        json: async () => res.json(),
        ok: res.ok,
        status: res.status,
        text: async () => res.text(),
      };
    };

    const port = createGLMMultimodalChatPort({
      apiKey: liveApiKey!,
      endpoint: 'https://api.b.ai/v1/chat/completions',
      fetcher: liveFetcher,
      model: 'glm-5.3-flash',
    });

    const result = await port.chat(
      {
        max_tokens: 20,
        messages: [{ content: 'Reply with "PONG"', role: 'user' }],
      },
      {
        scope: { sessionId: 'live-probe-session', userId: 'live-probe-user' },
      },
    );

    expect(result.id).toBeDefined();
    expect(result.choices.length).toBeGreaterThan(0);
    expect(result.choices[0].message.content).toBeDefined();
    // Verify that the secret key is never in result
    expect(JSON.stringify(result)).not.toContain(liveApiKey);
  });
});

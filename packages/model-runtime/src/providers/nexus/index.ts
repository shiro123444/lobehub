import { ModelProvider } from 'model-bank';

import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { createNexusImage } from './createImage';

export const LobeNexusAI = createOpenAICompatibleRuntime({
  baseURL: 'https://app.soruxgpt.com/api/codex/v1',
  createImage: createNexusImage,
  debug: {
    chatCompletion: () => process.env.DEBUG_NEXUS_CHAT_COMPLETION === '1',
    responses: () => process.env.DEBUG_NEXUS_RESPONSES === '1',
  },
  provider: ModelProvider.Nexus,
});

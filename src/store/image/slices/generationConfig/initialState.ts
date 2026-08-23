import { type ModelParamsSchema, type RuntimeImageGenParams } from 'model-bank';
import { extractDefaultValues, ModelProvider, nexusGptImage2Schema } from 'model-bank';

import { DEFAULT_IMAGE_CONFIG } from '@/const/settings';

export const DEFAULT_AI_IMAGE_PROVIDER = ModelProvider.Nexus;
export const DEFAULT_AI_IMAGE_MODEL = 'gpt-image-2';
export const NEXUS_IMAGE_PROVIDER = ModelProvider.Nexus;
export const NEXUS_IMAGE_MODEL = 'gpt-image-2';

export interface GenerationConfigState {
  parameters: RuntimeImageGenParams;
  parametersSchema: ModelParamsSchema;

  provider: string;
  model: string;
  imageNum: number;

  isAspectRatioLocked: boolean;
  activeAspectRatio: string | null; // string - virtual ratio; null - native ratio

  /**
   * Marks whether the configuration has been initialized (including restoration from memory)
   */
  isInit: boolean;
}

export const DEFAULT_IMAGE_GENERATION_PARAMETERS: RuntimeImageGenParams =
  extractDefaultValues(nexusGptImage2Schema);

export const initialGenerationConfigState: GenerationConfigState = {
  model: DEFAULT_AI_IMAGE_MODEL,
  provider: DEFAULT_AI_IMAGE_PROVIDER,
  imageNum: DEFAULT_IMAGE_CONFIG.defaultImageNum,
  parameters: DEFAULT_IMAGE_GENERATION_PARAMETERS,
  parametersSchema: nexusGptImage2Schema,
  isAspectRatioLocked: false,
  activeAspectRatio: null,
  isInit: false,
};

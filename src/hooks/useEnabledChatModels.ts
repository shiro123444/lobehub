import { JUMI_CHAT_MODELS } from '@/const/jumi';
import { type EnabledProviderWithModels } from '@/types/aiProvider';

export const useEnabledChatModels = (): EnabledProviderWithModels[] => {
  return JUMI_CHAT_MODELS;
};

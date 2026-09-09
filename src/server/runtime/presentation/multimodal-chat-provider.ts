/**
 * Provider-neutral presentation chat port.
 *
 * The implementation lives in the legacy module for source compatibility with
 * existing deployments. New code must import this module; it deliberately
 * exposes no GLM provider name or registration.
 */
export {
  assertSafeImageUrl,
  createMultimodalChatPort,
  DEFAULT_MULTIMODAL_CHAT_MODEL,
  MultimodalChatProviderError,
  type MultimodalChatChoice,
  type MultimodalChatContentPart,
  type MultimodalChatContext,
  type MultimodalChatFetcher,
  type MultimodalChatFetchResponse,
  type MultimodalChatMessage,
  type MultimodalChatPort,
  type MultimodalChatProviderErrorCode,
  type MultimodalChatProviderManifest,
  type MultimodalChatProviderOptions,
  type MultimodalChatRequest,
  type MultimodalChatResult,
  type MultimodalChatUsage,
  type MultimodalImageContentPart,
  type MultimodalTextContentPart,
} from './multimodal-chat-provider-glm';

import type { MultimodalChatMessage, MultimodalChatPort } from './multimodal-chat-provider';

export interface PresentationConversationReference {
  readonly kind: 'image' | 'pptx' | 'pdf' | 'docx' | 'xlsx' | 'text';
  readonly name: string;
  readonly status?: 'uploading' | 'ready' | 'failed';
}

export type PresentationConversationPhase = 'intake' | 'outline' | 'complete';

export interface PresentationConversationMessage {
  readonly content: string;
  readonly role: 'assistant' | 'user';
}

export interface PresentationConversationBrief {
  readonly aspectRatio?: '16:9' | '4:3';
  readonly audience?: string;
  readonly language?: string;
  readonly slideCount?: number;
  readonly style?: string;
  readonly topic?: string;
}

export interface PresentationConversationCommand {
  readonly brief?: PresentationConversationBrief;
  readonly messages: readonly PresentationConversationMessage[];
  readonly operation: 'turn';
  readonly references?: readonly PresentationConversationReference[];
  readonly threadId: string;
}

export interface PresentationConversationResult {
  readonly brief: PresentationConversationBrief;
  readonly message: string;
  readonly phase: PresentationConversationPhase;
  readonly questionId?: string;
}

export interface PresentationConversationContext {
  readonly scope: { readonly sessionId: string; readonly userId: string };
}

export interface PresentationConversationCapability {
  readonly id: 'presentation.conversation';
  execute(
    command: PresentationConversationCommand,
    context: PresentationConversationContext,
  ): Promise<PresentationConversationResult>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const parseJson = (value: string): Record<string, unknown> => {
  const normalized = value.startsWith('```')
    ? value.slice(value.indexOf('\n') + 1, value.lastIndexOf('```')).trim()
    : value.trim();
  const parsed: unknown = JSON.parse(normalized);
  if (!isRecord(parsed)) throw new Error('Conversation provider returned a non-object response');
  return parsed;
};

const briefFrom = (value: unknown): PresentationConversationBrief => {
  if (!isRecord(value)) return {};
  const slideCount =
    typeof value.slideCount === 'number' &&
    Number.isInteger(value.slideCount) &&
    value.slideCount > 0
      ? value.slideCount
      : undefined;
  return {
    ...(nonEmpty(value.topic) ? { topic: value.topic.trim() } : {}),
    ...(nonEmpty(value.audience) ? { audience: value.audience.trim() } : {}),
    ...(nonEmpty(value.style) ? { style: value.style.trim() } : {}),
    ...(nonEmpty(value.language) ? { language: value.language.trim() } : {}),
    ...(slideCount !== undefined ? { slideCount } : {}),
    ...(value.aspectRatio === '16:9' || value.aspectRatio === '4:3'
      ? { aspectRatio: value.aspectRatio }
      : {}),
  };
};

const asMessages = (
  messages: readonly PresentationConversationMessage[],
): MultimodalChatMessage[] =>
  messages.map((message) => ({ content: message.content, role: message.role }));

/**
 * Cordis capability for the intake conversation. It owns agent reasoning and
 * brief extraction; React only renders the returned event-shaped result.
 */
export const createPresentationConversationCapability = (options: {
  readonly chat: MultimodalChatPort;
}): PresentationConversationCapability => {
  if (!options?.chat || typeof options.chat.chat !== 'function') {
    throw new TypeError('A multimodal chat port is required');
  }
  return {
    id: 'presentation.conversation',
    async execute(command, context) {
      if (!nonEmpty(command?.threadId) || command.operation !== 'turn') {
        throw Object.assign(new Error('threadId and operation=turn are required'), {
          code: 'PRESENTATION_INVALID',
        });
      }
      if (!context?.scope?.userId || !context.scope.sessionId) {
        throw Object.assign(new Error('authenticated conversation scope is required'), {
          code: 'PRESENTATION_INVALID',
        });
      }
      const references = (command.references ?? []).map((reference) => ({
        content: `[${reference.kind}] ${reference.name}`,
        role: 'user' as const,
      }));
      const response = await options.chat.chat(
        {
          max_tokens: 1800,
          messages: [
            {
              content:
                '你是 PPT 需求访谈 Agent。根据已有对话和 brief 判断当前缺失的最高价值信息，每次只问一个问题。不要按固定顺序提问。信息足够时返回 phase=outline。严格输出 JSON：{phase:"intake"|"outline",message:string,questionId?:string,brief:{topic?,audience?,slideCount?,style?,language?,aspectRatio?}}。不要输出 Markdown。',
              role: 'system',
            },
            {
              content: JSON.stringify({ brief: briefFrom(command.brief) }),
              role: 'user',
            },
            ...asMessages(command.messages),
            ...references,
          ],
          model: options.chat.manifest.model,
          response_format: { type: 'json_object' },
          temperature: 0.2,
        },
        { scope: context.scope },
      );
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error('Conversation provider returned an empty response');
      const parsed = parseJson(content);
      if (!nonEmpty(parsed.message)) throw new Error('Conversation response message is required');
      const phase = parsed.phase === 'outline' ? 'outline' : 'intake';
      return {
        brief: { ...briefFrom(command.brief), ...briefFrom(parsed.brief) },
        message: parsed.message.trim(),
        phase,
        ...(nonEmpty(parsed.questionId) ? { questionId: parsed.questionId.trim() } : {}),
      };
    },
  };
};

import type { PresentationConversationBrief } from './conversation-capability';
import type { MultimodalChatPort } from './multimodal-chat-provider';

export interface PresentationOutlineSlide {
  readonly id: string;
  readonly keyPoints: string[];
  readonly objective?: string;
  readonly speakerNotes?: string;
  readonly title: string;
  readonly visualSuggestion?: string;
}

export interface PresentationOutlineCommand {
  readonly brief: PresentationConversationBrief;
  readonly currentSlides?: readonly PresentationOutlineSlide[];
  readonly operation: 'propose' | 'rewrite';
}

export interface PresentationOutlineCapability {
  readonly id: 'presentation.outline';
  execute(
    command: PresentationOutlineCommand,
    context: { readonly scope: { readonly sessionId: string; readonly userId: string } },
  ): Promise<{ slides: PresentationOutlineSlide[] }>;
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
  if (!isRecord(parsed)) throw new Error('Outline provider returned a non-object response');
  return parsed;
};

const normalizeSlides = (value: unknown): PresentationOutlineSlide[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Outline slides are required');
  return value.map((slide, index) => {
    if (!isRecord(slide) || !nonEmpty(slide.title) || !Array.isArray(slide.keyPoints)) {
      throw new Error(`Invalid outline slide at index ${index}`);
    }
    return {
      id: nonEmpty(slide.id) ? slide.id.trim() : `slide-${index + 1}`,
      keyPoints: slide.keyPoints.filter(nonEmpty).map((point) => point.trim()),
      ...(nonEmpty(slide.objective) ? { objective: slide.objective.trim() } : {}),
      ...(nonEmpty(slide.speakerNotes) ? { speakerNotes: slide.speakerNotes.trim() } : {}),
      title: slide.title.trim(),
      ...(nonEmpty(slide.visualSuggestion)
        ? { visualSuggestion: slide.visualSuggestion.trim() }
        : {}),
    };
  });
};

export const createPresentationOutlineCapability = (options: {
  readonly chat: MultimodalChatPort;
}): PresentationOutlineCapability => {
  if (!options?.chat || typeof options.chat.chat !== 'function') {
    throw new TypeError('A multimodal chat port is required');
  }
  return {
    id: 'presentation.outline',
    async execute(command, context) {
      const brief = command?.brief;
      if (!brief || !nonEmpty(brief.topic) || command.operation === undefined) {
        throw Object.assign(new Error('brief.topic and operation are required'), {
          code: 'PRESENTATION_INVALID',
        });
      }
      const current = command.currentSlides ?? [];
      const response = await options.chat.chat(
        {
          max_tokens: 8000,
          messages: [
            {
              content:
                '你是 PPT 结构规划 Agent。将需求 brief 转成可编辑逐页大纲。只输出 JSON：{slides:[{id,title,objective,keyPoints:string[],visualSuggestion,speakerNotes}]}。保持内容真实，不生成 SVG，不添加 Markdown。',
              role: 'system',
            },
            {
              content: JSON.stringify({
                brief,
                currentSlides: current,
                operation: command.operation,
              }),
              role: 'user',
            },
          ],
          model: options.chat.manifest.model,
          response_format: { type: 'json_object' },
          temperature: 0.2,
        },
        { scope: context.scope },
      );
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error('Outline provider returned an empty response');
      const parsed = parseJson(content);
      return { slides: normalizeSlides(parsed.slides) };
    },
  };
};

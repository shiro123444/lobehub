import type { PresentationReferenceInput } from './types';
import type { OutlineSlide } from './OutlineWorkspace';

export interface PresentationAgentMessage {
  readonly content: string;
  readonly role: 'assistant' | 'user';
}

export interface PresentationAgentBrief {
  aspectRatio?: '16:9' | '4:3';
  audience?: string;
  language?: string;
  slideCount?: number;
  style?: string;
  topic?: string;
}

export interface PresentationAgentTurnInput {
  brief?: PresentationAgentBrief;
  messages: PresentationAgentMessage[];
  references: PresentationReferenceInput[];
  threadId: string;
}

export interface PresentationAgentTurnResult {
  brief: PresentationAgentBrief;
  message: string;
  phase: 'intake' | 'outline' | 'complete';
  questionId?: string;
}

export interface PresentationAgentClient {
  outline: (input: {
    brief: PresentationAgentBrief;
    currentSlides?: OutlineSlide[];
  }) => Promise<{ slides: OutlineSlide[] }>;
  turn: (input: PresentationAgentTurnInput) => Promise<PresentationAgentTurnResult>;
}

const jsonRequest = async <T>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) throw new Error(`Presentation agent unavailable (${response.status})`);
  return (await response.json()) as T;
};

export const createPresentationAgentClient = (): PresentationAgentClient => ({
  outline: (input) =>
    jsonRequest('/api/runtime/presentation/outline?mode=propose', {
      ...input,
      operation: 'propose',
    }),
  turn: (input) =>
    jsonRequest('/api/runtime/presentation/conversation', { ...input, operation: 'turn' }),
});

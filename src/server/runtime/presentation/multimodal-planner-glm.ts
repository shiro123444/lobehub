/**
 * Multimodal Presentation Planner & Outline Generator.
 *
 * Uses the provider-neutral multimodal chat port to generate structured plans and outlines.
 */

import type {
  PlannerContext,
  PresentationJobInput,
  PresentationPlan,
  PresentationPlanner,
  PresentationSlidePlan,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { GLMChatContentPart, GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import { PresentationPlanError, validatePresentationPlan } from './planner';

export interface GLMPresentationPlannerOptions {
  readonly chatPort: GLMMultimodalChatPort;
  readonly defaultSlideCount?: number;
  readonly systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are an expert AI presentation designer and slide architect.
Generate high quality, visually balanced SVG slides for the presentation.
Each slide must be returned with a valid <svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg">...</svg>.
Return clean JSON matching the PresentationPlan schema:
{
  "planId": string,
  "title": string,
  "aspectRatio": "16:9",
  "sourceVersionIds": string[],
  "slides": [
    {
      "slideId": string,
      "order": number (starting at 1),
      "svg": string (valid SVG),
      "notes": string (optional)
    }
  ]
}`;

const normalizeSvg = (value: unknown, slideId: string, aspectRatio: string): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  const start = raw.indexOf('<svg');
  const end = raw.lastIndexOf('</svg>');
  const extracted = start >= 0 && end > start ? raw.slice(start, end + 6) : raw;
  if (
    extracted &&
    !/<\s*(?:script|html|body)\b/i.test(extracted) &&
    !/<!DOCTYPE/i.test(extracted)
  ) {
    try {
      validatePresentationPlan({
        aspectRatio,
        planId: 'svg-probe',
        slides: [{ order: 1, slideId: 'svg-probe-slide', svg: extracted }],
        sourceVersionIds: [],
        title: 'svg-probe',
      });
      return extracted;
    } catch {
      // Fall through to the stable plan error below.
    }
  }
  throw new PresentationPlanError(`slide ${slideId} returned an invalid SVG`);
};

const assetHref = (ref: string): string =>
  /^https?:\/\//iu.test(ref)
    ? ref
    : `/api/runtime/presentation/artifacts/${encodeURIComponent(ref)}`;

const attachGeneratedAssets = (svg: string, refs: readonly string[]): string => {
  const uniqueRefs = [...new Set(refs.filter(Boolean))];
  if (uniqueRefs.length === 0 || /<image\b/iu.test(svg)) return svg;
  const images = uniqueRefs
    .map(
      (ref, index) =>
        `<image href="${assetHref(ref)}" x="${58 + index * 3}%" y="18%" width="${Math.max(28, 36 - index * 4)}%" height="64%" preserveAspectRatio="xMidYMid slice" opacity="0.96"/>`,
    )
    .join('');
  // Put generated visuals before the first text element so headings and body
  // copy remain readable when the model returned a simple left-text layout.
  const firstText = svg.search(/<text\b/iu);
  if (firstText >= 0) return `${svg.slice(0, firstText)}${images}${svg.slice(firstText)}`;
  const closingTag = svg.lastIndexOf('</svg>');
  return closingTag >= 0 ? `${svg.slice(0, closingTag)}${images}${svg.slice(closingTag)}` : svg;
};

export class GLMPresentationPlanner implements PresentationPlanner {
  private readonly chatPort: GLMMultimodalChatPort;
  private readonly defaultSlideCount: number;
  private readonly systemPrompt: string;

  constructor(options: GLMPresentationPlannerOptions) {
    if (!options || typeof options !== 'object' || !options.chatPort) {
      throw new Error('PresentationPlanner requires chatPort');
    }
    this.chatPort = options.chatPort;
    this.defaultSlideCount = options.defaultSlideCount ?? 8;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  async plan(input: PresentationJobInput, context: PlannerContext): Promise<PresentationPlan> {
    const candidateScope = context?.scope as Partial<RuntimeScope> | undefined;
    if (
      !candidateScope ||
      typeof candidateScope.userId !== 'string' ||
      !candidateScope.userId.trim() ||
      typeof candidateScope.sessionId !== 'string' ||
      !candidateScope.sessionId.trim()
    ) {
      throw new PresentationPlanError('authenticated planner scope is required');
    }
    const scope: RuntimeScope = {
      sessionId: candidateScope.sessionId.trim(),
      userId: candidateScope.userId.trim(),
    };

    const slideCount = input.slideCount || this.defaultSlideCount;
    const title = input.title || '智能演示文稿';
    const aspectRatio = input.aspectRatio || '16:9';
    const inputOptions = (input.options ?? {}) as Record<string, unknown>;
    const requestedStyle = typeof inputOptions.style === 'string' ? inputOptions.style.trim() : '';

    let userPrompt = [
      `主题：${title}`,
      input.prompt ? `详细需求：${input.prompt}` : '',
      `目标页数：${slideCount}`,
      `画幅比例：${aspectRatio}`,
      input.language ? `主语言：${input.language}` : '主语言：zh-CN',
    ]
      .filter(Boolean)
      .join('\n');

    const generatedSlots = (input.options as { generatedImageSlots?: unknown[] } | undefined)
      ?.generatedImageSlots;
    const generatedAssetUrls: string[] = [];
    const generatedAssetRefsBySlide = new Map<string, string[]>();
    if (Array.isArray(generatedSlots) && generatedSlots.length > 0) {
      const slotDescriptions = generatedSlots
        .map((slot: unknown) => {
          const record = slot && typeof slot === 'object' ? (slot as Record<string, unknown>) : {};
          const refs = Array.isArray(record.assetRefs)
            ? record.assetRefs
                .map((ref) =>
                  ref &&
                  typeof ref === 'object' &&
                  typeof (ref as { ref?: unknown }).ref === 'string'
                    ? (ref as { ref: string }).ref.trim()
                    : '',
                )
                .filter(Boolean)
            : [];
          for (const ref of refs) {
            if (/^https:\/\//iu.test(ref) && !generatedAssetUrls.includes(ref)) {
              generatedAssetUrls.push(ref);
            }
          }
          const slideId = typeof record.slideId === 'string' ? record.slideId : 'unknown';
          generatedAssetRefsBySlide.set(slideId, [
            ...(generatedAssetRefsBySlide.get(slideId) ?? []),
            ...refs,
          ]);
          const slotId = typeof record.slotId === 'string' ? record.slotId : 'unknown';
          const state = typeof record.state === 'string' ? record.state : 'unknown';
          return `页面: ${slideId}, 槽位: ${slotId}, 素材状态: ${state}${refs.length > 0 ? `, 素材引用: ${refs.join('、')}` : ''}`;
        })
        .join('\n');
      userPrompt += `\n\n已生成的视觉素材清单：\n${slotDescriptions}\n保持素材所属页面的 slideId 不变。对 HTTPS 素材，请在对应 SVG 中使用 <image href="素材引用">；其他素材引用则保留明确的图片占位区域。`;
    }

    const contentParts: GLMChatContentPart[] = [{ text: userPrompt, type: 'text' }];

    // If options include resolved reference images, attach them safely
    if (Array.isArray((input.options as any)?.references)) {
      for (const ref of (input.options as any).references) {
        if (ref?.url && typeof ref.url === 'string' && ref.url.startsWith('https://')) {
          contentParts.push({
            image_url: { url: ref.url },
            type: 'image_url',
          });
        }
      }
    }
    for (const url of generatedAssetUrls) {
      contentParts.push({ image_url: { url }, type: 'image_url' });
    }

    const response = await this.chatPort.chat(
      {
        max_tokens: Math.min(16_000, Math.max(4_000, slideCount * 1_200)),
        messages: [
          { content: this.systemPrompt, role: 'system' },
          { content: contentParts, role: 'user' },
        ],
        model: this.chatPort.manifest.model,
        response_format: { type: 'json_object' },
        temperature: 0.3,
      },
      {
        idempotencyKey: (context?.idempotencyKey as string) || undefined,
        scope,
        signal: context?.signal as AbortSignal | undefined,
      },
    );

    const firstChoice = response.choices[0];
    if (!firstChoice?.message?.content) {
      throw new Error('Multimodal planner returned empty response');
    }

    const rawContent = firstChoice.message.content.trim();
    let parsedPlan: any;
    try {
      parsedPlan = JSON.parse(rawContent);
    } catch {
      // In case the model returned a markdown code block ```json ... ```
      const startIdx = rawContent.indexOf('```');
      if (startIdx !== -1) {
        const nextNewline = rawContent.indexOf('\n', startIdx);
        const endIdx = rawContent.lastIndexOf('```');
        if (nextNewline !== -1 && endIdx > nextNewline) {
          const jsonStr = rawContent.slice(nextNewline + 1, endIdx).trim();
          parsedPlan = JSON.parse(jsonStr);
        } else {
          throw new Error('Failed to parse multimodal planner JSON response');
        }
      } else {
        throw new Error('Failed to parse multimodal planner JSON response');
      }
    }

    const rawSlides = Array.isArray(parsedPlan.slides) ? parsedPlan.slides : [];
    if (rawSlides.length !== slideCount) {
      throw new PresentationPlanError(
        `planner returned ${rawSlides.length} slides, expected ${slideCount}`,
      );
    }
    const plannedSlides = rawSlides;
    const usedSlideIds = new Set<string>();

    // Normalize unreliable model fields at the provider boundary. The model is
    // allowed to be creative about content, not about contract validity.
    const fallbackPlan: PresentationPlan = {
      aspectRatio,
      planId: parsedPlan.planId || `plan-${Date.now()}`,
      slides: plannedSlides.map((s: any, idx: number): PresentationSlidePlan => {
        const requestedId =
          typeof s?.slideId === 'string' && s.slideId.trim()
            ? s.slideId.trim()
            : `slide-${idx + 1}`;
        const slideId = usedSlideIds.has(requestedId) ? `slide-${idx + 1}` : requestedId;
        usedSlideIds.add(slideId);
        const slideTitle =
          typeof s?.title === 'string' && s.title.trim()
            ? s.title.trim()
            : idx === 0
              ? title
              : `第 ${idx + 1} 页`;
        const slideRefs =
          generatedAssetRefsBySlide.get(slideId) ??
          generatedAssetRefsBySlide.get(`slide-${idx + 1}`) ??
          [];
        return {
          metadata: {
            ...s?.metadata,
            ...(slideRefs.length > 0 ? { generatedAssetRefs: slideRefs } : {}),
            ...(requestedStyle ? { style: requestedStyle } : {}),
            title: slideTitle,
          },
          notes: typeof s?.notes === 'string' ? s.notes : undefined,
          order: idx + 1,
          slideId,
          svg: attachGeneratedAssets(normalizeSvg(s?.svg, slideId, aspectRatio), slideRefs),
        };
      }),
      sourceVersionIds: input.sourceVersionIds || [],
      title,
    };

    return validatePresentationPlan(fallbackPlan);
  }
}

export const createGLMPresentationPlanner = (
  options: GLMPresentationPlannerOptions,
): PresentationPlanner => new GLMPresentationPlanner(options);

/** Provider-neutral production alias; the GLM-named export is legacy only. */
export const createMultimodalPresentationPlanner = createGLMPresentationPlanner;

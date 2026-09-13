/**
 * Multimodal Presentation Planner & Outline Generator.
 *
 * Uses the provider-neutral multimodal chat port to generate structured plans and outlines.
 */

import type {
  PlannerContext,
  PresentationJobInput,
  PresentationMessageInput,
  PresentationPlan,
  PresentationPlanner,
  PresentationSlidePlan,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import { reviseAnnotation } from './annotation';
import {
  createTrustedChatImages,
  type GLMChatContentPart,
  type GLMMultimodalChatPort,
  type GLMServerImageInput,
} from './multimodal-chat-provider-glm';
import { PresentationPlanError, validatePresentationPlan } from './planner';
import {
  boundPresentationPromptText,
  presentationAssetHref,
  type PresentationAssetPlacement,
  presentationImageRefs,
  type RevisionAssetIntent,
  validateAssetPlacement,
} from './revision-assets';
import { type TemplateApplication, templatePlannerInstructions } from './templates';

export interface GLMPresentationPlannerOptions {
  readonly chatPort: GLMMultimodalChatPort;
  readonly defaultSlideCount?: number;
  readonly systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are an expert AI presentation designer and slide architect.
Generate high quality, visually balanced SVG slides for the presentation.
Use PPT-compatible inline SVG attributes: no <g opacity>, <style>, class, foreignObject, mask, textPath, script, or external assets. Apply opacity on individual shapes. Use <text>/<tspan> for text and Arial or Microsoft YaHei as the final font fallback.
If a requested raster asset has not been provided yet, reserve a plain shape region and describe the needed asset in slide metadata for the asset preparation step. Do not invent image URLs or pretend a vector drawing is the requested photograph.
Each slide must be returned with a valid <svg viewBox="..." xmlns="http://www.w3.org/2000/svg">...</svg> matching the required canvas below.
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

interface PlannedVisualAsset {
  readonly layout?: PresentationAssetPlacement;
  readonly ref: string;
}

const svgViewBox = (svg: string): number[] => {
  const viewBox = /<svg\b[^>]*\sviewBox=["']([^"']+)["']/iu.exec(svg)?.[1];
  const values = viewBox
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (!values || values.length !== 4 || values.some((value) => !Number.isFinite(value)))
    throw new PresentationPlanError('Image layout requires a finite SVG viewBox');
  return values;
};

/** Fill only a region explicitly designed for this asset; never guess fixed coordinates. */
const attachGeneratedAssets = (svg: string, assets: readonly PlannedVisualAsset[]): string => {
  let result = svg;
  for (const asset of assets) {
    const href = presentationAssetHref(asset.ref);
    if (presentationImageRefs(result).includes(href)) continue;
    if (!asset.layout)
      throw new PresentationPlanError('The planner did not place a required image in its slide');
    const [minX, minY, width, height] = svgViewBox(result);
    const layout = validateAssetPlacement(asset.layout);
    const escapedHref = href
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;');
    const image = `<image href="${escapedHref}" x="${minX + layout.x * width}" y="${minY + layout.y * height}" width="${layout.width * width}" height="${layout.height * height}" preserveAspectRatio="xMidYMid ${layout.fit === 'cover' ? 'slice' : 'meet'}"/>`;
    const firstText = result.search(/<text\b/iu);
    const insertion = firstText >= 0 ? firstText : result.lastIndexOf('</svg>');
    result = `${result.slice(0, insertion)}${image}${result.slice(insertion)}`;
  }
  return result;
};

const validatePlacedAssets = (
  svg: string,
  required: readonly PlannedVisualAsset[],
  permittedRefs: readonly string[],
): void => {
  const refs = presentationImageRefs(svg);
  for (const ref of refs) {
    if (!permittedRefs.includes(ref))
      throw new PresentationPlanError('The planner referenced an image that was not provided');
  }
  const [minX, minY, width, height] = svgViewBox(svg);
  for (const asset of required) {
    const href = presentationAssetHref(asset.ref);
    const tag = [...svg.matchAll(/<image\b[^>]*>/giu)].find((match) =>
      presentationImageRefs(match[0]).includes(href),
    )?.[0];
    if (!tag) throw new PresentationPlanError('A required generated image is missing');
    const dimension = (attribute: string, basis: number, fallback?: number): number => {
      const raw = new RegExp(`\\s${attribute}=["']([^"']+)["']`, 'iu').exec(tag)?.[1];
      if (raw === undefined) return fallback ?? Number.NaN;
      if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:%|px)?$/u.test(raw)) return Number.NaN;
      return Number.parseFloat(raw) * (raw.endsWith('%') ? basis / 100 : 1);
    };
    const x = dimension('x', width, 0);
    const y = dimension('y', height, 0);
    const imageWidth = dimension('width', width);
    const imageHeight = dimension('height', height);
    if (
      ![x, y, imageWidth, imageHeight].every(Number.isFinite) ||
      x < minX ||
      y < minY ||
      imageWidth <= 0 ||
      imageHeight <= 0 ||
      x + imageWidth > minX + width + 0.01 ||
      y + imageHeight > minY + height + 0.01
    )
      throw new PresentationPlanError('Generated image placement extends outside the slide');
  }
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

    const outline = input.options?.outline;
    if (
      !context.basePlan &&
      !context.pagePass &&
      Array.isArray(outline) &&
      outline.length > 0 &&
      outline.length === input.slideCount
    ) {
      const composed: PresentationSlidePlan[] = [];
      for (const [pageIndex, page] of outline.entries()) {
        const pageId = `slide-${pageIndex + 1}`;
        if (typeof context.onSlideStart === 'function') await context.onSlideStart(pageIndex + 1);
        const result = await this.plan(
          {
            ...input,
            slideCount: 1,
            prompt: `${input.prompt ?? ''}\n当前仅制作第 ${pageIndex + 1} 页：${JSON.stringify(page)}。只返回这一页，保持 slideId=${pageId}，不要重写其他页面。`,
            options: {
              ...input.options,
              generatedImageSlots: Array.isArray(input.options?.generatedImageSlots)
                ? input.options.generatedImageSlots.filter((slot: any) => slot.slideId === pageId)
                : undefined,
            },
          },
          { ...context, pagePass: true, pageIndex, pageSlideId: pageId },
        );
        const slide = { ...result.slides[0], slideId: pageId, order: pageIndex + 1 };
        composed.push(slide);
        if (typeof context.onSlideDraft === 'function') await context.onSlideDraft(slide);
      }
      return {
        planId: `plan-${Date.now()}`,
        title: input.title,
        aspectRatio: input.aspectRatio ?? '16:9',
        sourceVersionIds: [...input.sourceVersionIds],
        slides: composed,
      };
    }
    const basePlan = context.basePlan as PresentationPlan | undefined;
    const revision = context.revision as PresentationMessageInput | undefined;
    if (basePlan) validatePresentationPlan(basePlan);
    if (basePlan && revision?.annotation)
      return reviseAnnotation(
        basePlan,
        revision,
        this.chatPort,
        scope,
        (context.abortSignal ?? context.signal) as AbortSignal | undefined,
      );
    const selectedSlides =
      basePlan && revision
        ? basePlan.slides.filter(
            (_, index) =>
              revision.target.type === 'deck' || index + 1 === revision.target.slideNumber,
          )
        : undefined;
    if (selectedSlides?.length === 0)
      throw new PresentationPlanError('The selected slide does not exist');
    const slideCount = selectedSlides?.length ?? (input.slideCount || this.defaultSlideCount);
    const title = input.title || '智能演示文稿';
    const aspectRatio = input.aspectRatio || '16:9';
    const [ratioWidth, ratioHeight] = aspectRatio.split(':').map(Number);
    const canvasHeight = ratioWidth > 0 && ratioHeight > 0 ? (960 * ratioHeight) / ratioWidth : 540;
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
    if (selectedSlides && revision) {
      userPrompt = `请修改以下原稿页面，保留没有要求修改的内容、图片和布局。只返回这些页面，不添加其他页面。保持 slideId。\n修改要求：${revision.content}\n画幅：${aspectRatio}\n原稿：${JSON.stringify(selectedSlides)}\n返回 ${selectedSlides.length} 页完整 SVG 的 JSON PresentationPlan。`;
    }
    if (context.template) {
      userPrompt += `\n\n${templatePlannerInstructions(context.template as TemplateApplication)}`;
    }
    const revisionAssetIntents = (input.options?.revisionAssetIntents ??
      []) as RevisionAssetIntent[];
    if (revisionAssetIntents.length) {
      userPrompt += `\n\n已批准的资产操作：${JSON.stringify(revisionAssetIntents)}\n只执行这些图片增删替换；其他原有图片保留。根据新图片的比例和预留区域重新排布文字。remove/replace 操作的原图片引用必须从目标页移除；新图片必须使用下面提供的真实 href。`;
    }

    const generatedSlots = (input.options as { generatedImageSlots?: unknown[] } | undefined)
      ?.generatedImageSlots;
    const generatedAssetUrls: string[] = [];
    const generatedAssetsBySlide = new Map<string, PlannedVisualAsset[]>();
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
          const layout =
            record.layout === undefined ? undefined : validateAssetPlacement(record.layout);
          generatedAssetsBySlide.set(slideId, [
            ...(generatedAssetsBySlide.get(slideId) ?? []),
            ...refs.map((ref) => ({ layout, ref })),
          ]);
          const slotId = typeof record.slotId === 'string' ? record.slotId : 'unknown';
          const state = typeof record.state === 'string' ? record.state : 'unknown';
          return `页面: ${slideId}, 槽位: ${slotId}, 素材状态: ${state}${refs.length > 0 ? `, 素材引用: ${refs.map(presentationAssetHref).join('、')}` : ''}${record.size ? `, 原图尺寸: ${record.size}` : ''}${layout ? `, 图片区域(相对画幅0..1): ${JSON.stringify(layout)}` : ''}`;
        })
        .join('\n');
      userPrompt += `\n\n已生成的视觉素材清单：\n${slotDescriptions}\n保持素材所属页面的 slideId 不变。每张素材都必须在对应页面使用 <image href="素材引用">，包括 /api/ 开头的真实资产引用，不可画占位图代替。使用与viewBox相同的数值坐标和正数width/height，图片须在画幅内。不要在图片或图片父组使用transform。已指定图片区域时围绕该区域排布文字，避免遮挡，并以preserveAspectRatio保留主体比例。没有指定区域时根据实际内容设计布局。`;
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
    const relevantImageHrefs = new Set([
      ...((context.template as TemplateApplication | undefined)?.visual?.pages.map((page) =>
        presentationAssetHref(page.ref),
      ) ?? []),
      ...[...generatedAssetsBySlide.values()].flatMap((assets) =>
        assets.map((asset) => presentationAssetHref(asset.ref)),
      ),
      ...(selectedSlides ?? []).flatMap((slide) => presentationImageRefs(slide.svg)),
    ]);
    const trustedInputs = Array.isArray(context.trustedImages)
      ? (context.trustedImages as (GLMServerImageInput & { ref: string })[]).filter(
          (image) =>
            typeof image?.ref === 'string' &&
            relevantImageHrefs.has(presentationAssetHref(image.ref)),
        )
      : [];
    const trustedImages = trustedInputs.length
      ? createTrustedChatImages(trustedInputs, scope)
      : undefined;
    trustedImages?.urls.forEach((url, index) => {
      contentParts.push({
        text: `以下图片是已验证的真实资产 ${presentationAssetHref(trustedInputs[index].ref)}，请观察主体、色彩、留白与比例后排版。`,
        type: 'text',
      });
      contentParts.push({ image_url: { url }, type: 'image_url' });
    });

    const response = await this.chatPort.chat(
      {
        max_tokens: Math.min(16_000, Math.max(4_000, slideCount * 1_200)),
        messages: [
          {
            content: boundPresentationPromptText(
              `${this.systemPrompt}\nRequired canvas: viewBox="0 0 960 ${canvasHeight}" for aspect ratio ${aspectRatio}.`,
            ),
            role: 'system',
          },
          {
            content: contentParts.map((part) =>
              part.type === 'text'
                ? { ...part, text: boundPresentationPromptText(part.text) }
                : part,
            ),
            role: 'user',
          },
        ],
        model: this.chatPort.manifest.model,
        response_format: { type: 'json_object' },
        temperature: 0.3,
      },
      {
        idempotencyKey: (context?.idempotencyKey as string) || undefined,
        scope,
        signal: (context?.abortSignal ?? context?.signal) as AbortSignal | undefined,
        ...(trustedImages ? { trustedImages } : {}),
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
    const plannedSlides = selectedSlides
      ? selectedSlides.map((slide) => {
          const matches = rawSlides.filter(
            (candidate: { slideId?: unknown }) => candidate?.slideId === slide.slideId,
          );
          if (matches.length !== 1)
            throw new PresentationPlanError(
              'A revision must retain each selected slide id exactly once',
            );
          return matches[0];
        })
      : rawSlides;
    const usedSlideIds = new Set<string>();

    // Normalize unreliable model fields at the provider boundary. The model is
    // allowed to be creative about content, not about contract validity.
    const fallbackPlan: PresentationPlan = {
      aspectRatio,
      planId: parsedPlan.planId || `plan-${Date.now()}`,
      slides: plannedSlides.map((s: any, idx: number): PresentationSlidePlan => {
        const originalSlide = selectedSlides?.[idx];
        const requestedId =
          (context.pageSlideId as string | undefined) ??
          originalSlide?.slideId ??
          (typeof s?.slideId === 'string' && s.slideId.trim()
            ? s.slideId.trim()
            : `slide-${idx + 1}`);
        const slideId = usedSlideIds.has(requestedId) ? `slide-${idx + 1}` : requestedId;
        usedSlideIds.add(slideId);
        const outlinePage = Array.isArray(input.options?.outline)
          ? input.options.outline[(context.pageIndex as number | undefined) ?? idx]
          : undefined;
        const slideTitle =
          (typeof outlinePage?.title === 'string' ? outlinePage.title : undefined) ??
          (typeof s?.title === 'string' && s.title.trim()
            ? s.title.trim()
            : typeof originalSlide?.metadata?.title === 'string' &&
                originalSlide.metadata.title.trim()
              ? originalSlide.metadata.title.trim()
              : idx === 0
                ? title
                : `第 ${idx + 1} 页`);
        const slideAssets =
          generatedAssetsBySlide.get(slideId) ??
          (!selectedSlides ? generatedAssetsBySlide.get(`slide-${idx + 1}`) : undefined) ??
          [];
        const slideRefs = slideAssets.map((asset) => asset.ref);
        const originalRefs = selectedSlides?.[idx]
          ? presentationImageRefs(selectedSlides[idx].svg)
          : [];
        const removedRefs = revisionAssetIntents
          .filter(
            (intent) =>
              intent.slideId === slideId &&
              (intent.action === 'remove' || intent.action === 'replace'),
          )
          .map((intent) => intent.ref!);
        const preservedRefs = originalRefs.filter((ref) => !removedRefs.includes(ref));
        const referenceUrls = Array.isArray(input.options?.references)
          ? (input.options.references as { url?: string }[]).flatMap((ref) =>
              typeof ref?.url === 'string' ? [ref.url] : [],
            )
          : [];
        const svg = attachGeneratedAssets(normalizeSvg(s?.svg, slideId, aspectRatio), slideAssets);
        validatePlacedAssets(svg, slideAssets, [
          ...preservedRefs,
          ...slideRefs.map(presentationAssetHref),
          ...referenceUrls,
        ]);
        const resultingRefs = presentationImageRefs(svg);
        if (preservedRefs.some((ref) => !resultingRefs.includes(ref)))
          throw new PresentationPlanError('The revision removed an image that should be preserved');
        const previousAssetRefs = Array.isArray(originalSlide?.metadata?.generatedAssetRefs)
          ? originalSlide.metadata.generatedAssetRefs.filter(
              (ref): ref is string => typeof ref === 'string',
            )
          : [];
        const generatedAssetRefs = [...new Set([...previousAssetRefs, ...slideRefs])].filter(
          (ref) => {
            const href = presentationAssetHref(ref);
            return resultingRefs.includes(href) || resultingRefs.includes(`${href}?raw=true`);
          },
        );
        return {
          metadata: {
            ...originalSlide?.metadata,
            ...s?.metadata,
            generatedAssetRefs,
            ...(requestedStyle ? { style: requestedStyle } : {}),
            title: slideTitle,
            ...(outlinePage
              ? {
                  outline: outlinePage.keyPoints,
                  objective: outlinePage.objective,
                  visualSuggestion: outlinePage.visualSuggestion,
                }
              : {}),
          },
          notes: typeof s?.notes === 'string' ? s.notes : originalSlide?.notes,
          order: idx + 1,
          slideId,
          svg,
        };
      }),
      sourceVersionIds: input.sourceVersionIds || [],
      title,
    };

    if (basePlan && selectedSlides) {
      const replacements = new Map(
        selectedSlides.map((slide, index) => [
          slide.slideId,
          {
            ...fallbackPlan.slides[index],
            slideId: slide.slideId,
            order: slide.order,
          },
        ]),
      );
      return validatePresentationPlan({
        ...basePlan,
        planId: fallbackPlan.planId,
        slides: basePlan.slides.map((slide) => replacements.get(slide.slideId) ?? slide),
      });
    }
    return validatePresentationPlan(fallbackPlan);
  }
}

export const createGLMPresentationPlanner = (
  options: GLMPresentationPlannerOptions,
): PresentationPlanner => new GLMPresentationPlanner(options);

/** Provider-neutral production alias; the GLM-named export is legacy only. */
export const createMultimodalPresentationPlanner = createGLMPresentationPlanner;

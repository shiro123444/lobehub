import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import {
  IMAGE_GENERATION_EVENT_TYPES,
  type ImageGenerationEvent,
  type ImageGenerationEventPublishInput,
  type ImageGenerationEventPublisherPort,
} from './asset-events';
import type { PresentationJobEventPublisherPort } from './publisher';

const IMAGE_READY_EVENT = 'presentation.job.artifact.ready';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const safeString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const statusFor = (type: string): 'queued' | 'generating' | 'ready' | 'failed' | 'cancelled' => {
  if (type === IMAGE_GENERATION_EVENT_TYPES.accepted) return 'queued';
  if (
    type === IMAGE_GENERATION_EVENT_TYPES.started ||
    type === IMAGE_GENERATION_EVENT_TYPES.progress
  )
    return 'generating';
  if (type === IMAGE_GENERATION_EVENT_TYPES.assetReady) return 'ready';
  if (type === IMAGE_GENERATION_EVENT_TYPES.cancelled) return 'cancelled';
  return 'failed';
};

const activityFor = (status: ReturnType<typeof statusFor>, slideId?: string): string => {
  if (status === 'queued') return '正在准备视觉素材';
  if (status === 'generating')
    return slideId ? `正在生成 ${slideId} 的视觉素材` : '正在生成视觉素材';
  if (status === 'ready') return slideId ? `${slideId} 的视觉素材已就绪` : '视觉素材已就绪';
  if (status === 'cancelled') return '视觉素材生成已取消';
  return '视觉素材生成失败';
};

const assetRefFrom = (data: Record<string, unknown>): string | undefined => {
  const asset = data.asset;
  return isRecord(asset) ? safeString(asset.ref) : safeString(data.assetId);
};

export interface PresentationImageEventBridgeOptions {
  readonly publisher: PresentationJobEventPublisherPort;
  readonly scope: RuntimeScope;
}

/**
 * Projects private image-generation lifecycle events into the job's existing
 * SSE journal. Slot state stays under `image.generation.*`; ready assets also
 * emit a normal presentation artifact event so the preview can hydrate while
 * the deck is still being assembled.
 */
export const createPresentationImageGenerationEventPublisher = (
  options: PresentationImageEventBridgeOptions,
): ImageGenerationEventPublisherPort => {
  const { publisher, scope } = options;
  let disposed = false;

  const assertOpen = () => {
    if (disposed) throw new Error('image event bridge is disposed');
  };

  return {
    assertScope: (received) => {
      assertOpen();
      publisher.assertScope(received);
    },
    dispose: () => {
      disposed = true;
    },
    publish: (input: ImageGenerationEventPublishInput): ImageGenerationEvent => {
      assertOpen();
      publisher.assertScope(input.scope ?? scope);
      const data = isRecord(input.data) ? input.data : {};
      const slideId = safeString(data.slideId);
      const slotId = safeString(data.slotId);
      const status = statusFor(input.type);
      const artifactId = status === 'ready' ? assetRefFrom(data) : undefined;
      const projected = {
        ...(artifactId ? { artifactId } : {}),
        activity: activityFor(status, slideId),
        ...(typeof data.code === 'string' ? { errorCode: data.code } : {}),
        ...(slideId ? { slideId } : {}),
        ...(slotId ? { slotId } : {}),
        status,
      };
      const event = publisher.publish({
        data: projected,
        idempotencyKey: input.idempotencyKey,
        jobId: input.jobId,
        scope: input.scope ?? scope,
        type: input.type,
      });

      if (status === 'ready' && artifactId) {
        const metadata = isRecord(data.metadata) ? data.metadata : {};
        const mimeType = safeString(metadata.mimeType) ?? 'image/png';
        const slideOrderMatch = slideId ? /^slide-(\d+)$/iu.exec(slideId) : null;
        const order = slideOrderMatch ? Number.parseInt(slideOrderMatch[1], 10) : undefined;
        const uri =
          /^https:\/\//iu.test(artifactId) || artifactId.startsWith('data:image/')
            ? artifactId
            : `/api/runtime/presentation/artifacts/${encodeURIComponent(artifactId)}`;
        publisher.publish({
          data: {
            activity: activityFor(status, slideId),
            artifact: {
              artifactId,
              createdAt: safeString(metadata.createdAt) ?? new Date().toISOString(),
              metadata: {
                ...(order ? { order } : {}),
                ...(slideId ? { slideId } : {}),
                ...(slotId ? { slotId } : {}),
              },
              mimeType,
              name: `${slotId ?? 'visual'}.${mimeType.split('/')[1] ?? 'png'}`,
              status: 'ready',
              type: 'image',
              uri,
            },
            artifactIds: [artifactId],
            ...(slideId ? { slideId } : {}),
            ...(slotId ? { slotId } : {}),
          },
          idempotencyKey: `image-artifact:${input.idempotencyKey ?? artifactId}`,
          jobId: input.jobId,
          scope: input.scope ?? scope,
          type: IMAGE_READY_EVENT,
        });
      }

      return {
        data: projected,
        idempotencyKey: input.idempotencyKey ?? `${input.jobId}:${input.type}`,
        jobId: input.jobId,
        protocol_version: 'runtime.v1',
        scope: input.scope ?? scope,
        seq: event.seq,
        type: input.type as ImageGenerationEvent['type'],
      };
    },
    scope,
  };
};

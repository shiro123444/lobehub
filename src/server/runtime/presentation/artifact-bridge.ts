import type { ArtifactSnapshot, RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { ArtifactInput, PresentationArtifactStore } from './artifact-store';
import type { PresentationWorkerResult } from './worker';

const clone = <T>(value: T): T => {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>))
      out[key] = clone(nested);
    return out as T;
  }
  return value;
};

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export const persistPresentationWorkerArtifacts = async (
  scope: RuntimeScope,
  result: PresentationWorkerResult,
  store: PresentationArtifactStore,
): Promise<readonly ArtifactSnapshot[]> => {
  if (!nonEmpty(result?.jobId) || !nonEmpty(result?.planId))
    throw Object.assign(new Error('jobId and planId must be non-empty'), {
      code: 'ARTIFACT_INVALID',
    });
  if (!Array.isArray(result.artifacts) || result.artifacts.length === 0)
    throw Object.assign(new Error('artifacts must not be empty'), { code: 'ARTIFACT_INVALID' });
  const seen = new Set<string>();
  const snapshots: ArtifactSnapshot[] = [];
  for (const [index, artifact] of (result.artifacts ?? []).entries()) {
    const artifactId = artifact.artifactId ?? `${result.jobId}:${index}`;
    if (seen.has(artifactId))
      throw Object.assign(new Error(`Duplicate artifactId: ${artifactId}`), {
        code: 'ARTIFACT_DUPLICATE',
      });
    seen.add(artifactId);
    if (
      !(artifact.bytes instanceof Uint8Array) ||
      artifact.bytes.byteLength === 0 ||
      !nonEmpty(artifact.mimeType) ||
      !nonEmpty(artifact.type) ||
      !nonEmpty(artifact.name)
    ) {
      throw Object.assign(new Error(`Invalid artifact: ${artifactId}`), {
        code: 'ARTIFACT_INVALID',
      });
    }

    const slideId =
      typeof artifact.metadata?.slideId === 'string' && artifact.metadata.slideId.trim().length > 0
        ? artifact.metadata.slideId
        : undefined;

    const uri =
      typeof artifact.metadata?.uri === 'string' && artifact.metadata.uri.trim().length > 0
        ? artifact.metadata.uri
        : `/api/runtime/presentation/artifacts/${encodeURIComponent(artifactId)}?raw=true`;

    const metadata = clone({
      ...artifact.metadata,
      jobId: result.jobId,
      mimeType: artifact.mimeType,
      planId: result.planId,
      quality: result.qualityReport,
      status: 'ready' as const,
      type: artifact.type,
      uri,
      ...(slideId ? { slideId } : {}),
    });

    try {
      const existing = await store.get(scope, artifactId);
      if (existing) {
        if (existing.bytes && !bytesEqual(existing.bytes, artifact.bytes))
          throw Object.assign(new Error(`Artifact bytes conflict: ${artifactId}`), {
            code: 'ARTIFACT_CONFLICT',
          });
        snapshots.push({
          ...existing,
          metadata: existing.metadata ? clone(existing.metadata) : metadata,
          status: 'ready',
          uri,
        });
        continue;
      }
      snapshots.push(
        await store.put(scope, {
          artifactId,
          bytes: new Uint8Array(artifact.bytes),
          metadata,
          mimeType: artifact.mimeType,
          name: artifact.name,
          status: 'ready',
          type: artifact.type,
          uri,
        } as ArtifactInput),
      );
    } catch (error) {
      const errorCode = (error as { code?: string })?.code;
      if (errorCode === 'ARTIFACT_CONFLICT' || errorCode === 'ARTIFACT_SCOPE_MISMATCH') {
        throw error;
      }
      // An isolated storage/read error on a single artifact marks only that artifact as failed
      snapshots.push({
        artifactId,
        createdAt: new Date().toISOString(),
        metadata: {
          ...metadata,
          error: error instanceof Error ? error.message : String(error),
          status: 'failed' as const,
        },
        mimeType: artifact.mimeType,
        name: artifact.name,
        sizeBytes: artifact.bytes.byteLength,
        status: 'failed',
        type: artifact.type,
        updatedAt: new Date().toISOString(),
        uri,
      });
    }
  }
  return clone(snapshots);
};

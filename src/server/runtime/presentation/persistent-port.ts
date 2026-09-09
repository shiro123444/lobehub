import type {
  ArtifactSnapshot,
  PresentationExportFormat,
  PresentationJob,
  PresentationJobInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type {
  PresentationBinaryPort,
  PresentationPort,
} from '../../../../packages/cordis-kernel/src/presentation';
import {
  PresentationArtifactStoreError,
  type ArtifactInput,
  type PresentationArtifactStore,
  type StoredArtifact,
} from './artifact-store';

export class PersistentPresentationPortError extends Error {
  constructor(
    public readonly code:
      | 'ARTIFACT_BYTES_UNAVAILABLE'
      | 'ARTIFACT_CONFLICT'
      | 'ARTIFACT_STORE_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'PersistentPresentationPortError';
  }
}

const isBinaryPort = (port: PresentationPort): port is PresentationBinaryPort =>
  typeof (port as Partial<PresentationBinaryPort>).readArtifactBytes === 'function';

const withoutBytes = (artifact: StoredArtifact): ArtifactSnapshot => {
  const { bytes: _bytes, ...snapshot } = artifact;
  return snapshot;
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

/** Mirrors ready artifacts from an inner binary port into an injected store. */
export class PersistentPresentationPort implements PresentationBinaryPort {
  readonly inner: PresentationBinaryPort;
  readonly scope: RuntimeScope;
  readonly store: PresentationArtifactStore;

  constructor(options: {
    inner: PresentationBinaryPort;
    scope: RuntimeScope;
    store?: PresentationArtifactStore;
  }) {
    if (!options || !isBinaryPort(options.inner)) {
      throw new PersistentPresentationPortError(
        'ARTIFACT_BYTES_UNAVAILABLE',
        'Persistent presentation port requires readArtifactBytes()',
      );
    }
    if (!options.store) {
      throw new PersistentPresentationPortError(
        'ARTIFACT_STORE_UNAVAILABLE',
        'Persistent presentation port requires an artifact store',
      );
    }
    this.inner = options.inner;
    this.scope = options.scope;
    this.store = options.store;
  }

  async createJob(input: PresentationJobInput): Promise<PresentationJob> {
    const job = await this.inner.createJob(input);
    await this.mirrorJob(job);
    return job;
  }

  async retryJob(jobId: string): Promise<PresentationJob> {
    const job = await this.inner.retryJob(jobId);
    await this.mirrorJob(job);
    return job;
  }

  async exportArtifact(artifactId: string, format: PresentationExportFormat) {
    const result = await this.inner.exportArtifact(artifactId, format);
    await this.mirrorArtifact(result.artifactId);
    return result;
  }

  async getArtifact(artifactId: string): Promise<ArtifactSnapshot | null> {
    const stored = await this.store.get(this.scope, artifactId);
    if (stored) return withoutBytes(stored);
    return this.inner.getArtifact(artifactId);
  }

  async readArtifactBytes(artifactId: string): Promise<Uint8Array | null> {
    const stored = await this.store.get(this.scope, artifactId);
    if (stored?.bytes) return new Uint8Array(stored.bytes);
    return this.inner.readArtifactBytes(artifactId);
  }

  getJob(jobId: string): Promise<PresentationJob | null> {
    return this.inner.getJob(jobId);
  }

  cancelJob(jobId: string): Promise<PresentationJob> {
    return this.inner.cancelJob(jobId);
  }

  private async mirrorJob(job: PresentationJob): Promise<void> {
    if (job.state !== 'completed') return;
    for (const artifactId of job.artifactIds ?? []) await this.mirrorArtifact(artifactId);
  }

  private async mirrorArtifact(artifactId: string): Promise<void> {
    const snapshot = await this.inner.getArtifact(artifactId);
    if (!snapshot || snapshot.status !== 'ready') return;
    const bytes = await this.inner.readArtifactBytes(artifactId);
    if (!bytes || bytes.byteLength === 0) {
      throw new PersistentPresentationPortError(
        'ARTIFACT_BYTES_UNAVAILABLE',
        `Ready artifact bytes are unavailable: ${artifactId}`,
      );
    }
    const existing = await this.store.get(this.scope, artifactId);
    if (existing?.bytes) {
      if (bytesEqual(existing.bytes, bytes)) return;
      throw new PersistentPresentationPortError(
        'ARTIFACT_CONFLICT',
        `Artifact bytes conflict: ${artifactId}`,
      );
    }
    const input: ArtifactInput = {
      artifactId,
      bytes: new Uint8Array(bytes),
      metadata: snapshot.metadata,
      mimeType: snapshot.mimeType ?? 'application/octet-stream',
      name: snapshot.name ?? artifactId,
      type: snapshot.type,
    };
    try {
      await this.store.put(this.scope, input);
    } catch (error) {
      if (error instanceof PresentationArtifactStoreError && error.code === 'ARTIFACT_DUPLICATE') {
        const raced = await this.store.get(this.scope, artifactId);
        if (raced?.bytes && bytesEqual(raced.bytes, bytes)) return;
        throw new PersistentPresentationPortError(
          'ARTIFACT_CONFLICT',
          `Artifact bytes conflict: ${artifactId}`,
        );
      }
      throw error;
    }
  }
}

export const createPersistentPresentationPort = (options: {
  inner: PresentationBinaryPort;
  scope: RuntimeScope;
  store: PresentationArtifactStore;
}): PersistentPresentationPort => new PersistentPresentationPort(options);

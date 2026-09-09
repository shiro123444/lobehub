import { describe, expect, it, vi } from 'vitest';

import {
  ImageGenerationPersistenceError,
  ImageGenerationPersistencePort,
  InMemoryImageGenerationPlanRepository,
  toImageGenerationJobWireSnapshot,
} from './image-generation-persistence';

const scope = { sessionId: 'session-1', userId: 'user-1' } as const;
const otherScope = { sessionId: 'session-2', userId: 'user-2' } as const;

const assetSnapshot = {
  asset: { ref: 'asset://generated-1' },
  metadata: {
    assetId: 'generated-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    mimeType: 'image/png',
  },
} as const;

const slots = [
  {
    count: 1,
    idempotencyKey: 'slot-1-key',
    prompt: 'private prompt that must remain server-only',
    quality: 'high',
    size: '1024x1024',
    slideId: 'slide-1',
    slotId: 'hero',
  },
] as const;

const createPersistence = (repository = new InMemoryImageGenerationPlanRepository()) =>
  new ImageGenerationPersistencePort({
    now: () => '2026-09-01T00:00:00.000Z',
    repository,
  });

const createInput = (jobId = 'job-1') => ({
  artifactSnapshots: [assetSnapshot],
  idempotencyKey: 'job-key',
  jobId,
  slots,
});

const expectCode = async (operation: Promise<unknown>, code: string) => {
  await expect(operation).rejects.toMatchObject({
    code,
    name: 'ImageGenerationPersistenceError',
  });
};

describe('C-102 image-generation persistence seam', () => {
  it('creates a scoped plan and restores it from a recreated adapter', async () => {
    const repository = new InMemoryImageGenerationPlanRepository();
    const first = createPersistence(repository);
    const created = await first.create(scope, createInput());
    const restarted = createPersistence(repository);

    await expect(restarted.resume(scope, 'job-1')).resolves.toEqual(created);
    expect(created.slots[0]?.prompt).toContain('private prompt');
    expect(created.artifactSnapshots).toEqual([assetSnapshot]);
  });

  it('makes repeated create calls idempotent for the same job and slot plan', async () => {
    const persistence = createPersistence();
    const first = await persistence.create(scope, createInput());
    const second = await persistence.create(scope, createInput());

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('rejects a reused job id when the prompt-bearing plan changes', async () => {
    const persistence = createPersistence();
    await persistence.create(scope, createInput());

    await expectCode(
      persistence.create(scope, {
        ...createInput(),
        slots: [{ ...slots[0], prompt: 'a different private prompt' }],
      }),
      'IMAGE_PLAN_IDEMPOTENCY_CONFLICT',
    );
  });

  it('rejects cross-scope reads, updates, and removes', async () => {
    const persistence = createPersistence();
    await persistence.create(scope, createInput());

    await expectCode(persistence.get(otherScope, 'job-1'), 'IMAGE_PLAN_SCOPE_MISMATCH');
    await expectCode(
      persistence.update(otherScope, 'job-1', { state: 'failed' }),
      'IMAGE_PLAN_SCOPE_MISMATCH',
    );
    await expectCode(persistence.remove(otherScope, 'job-1'), 'IMAGE_PLAN_SCOPE_MISMATCH');
  });

  it('persists failed and cancelled state for recovery without changing the slot plan', async () => {
    const persistence = createPersistence();
    await persistence.create(scope, createInput());
    const failed = await persistence.update(scope, 'job-1', {
      error: { code: 'IMAGE_UNAVAILABLE', message: 'provider unavailable' },
      state: 'failed',
      slots: [
        {
          ...slots[0],
          error: { code: 'IMAGE_UNAVAILABLE', message: 'provider unavailable' },
          state: 'failed',
        },
      ],
    });
    const cancelled = await persistence.update(scope, 'job-1', {
      error: { code: 'IMAGE_CANCELLED', message: 'generation cancelled' },
      state: 'cancelled',
    });

    expect(failed.state).toBe('failed');
    expect(cancelled.state).toBe('cancelled');
    expect((await persistence.resume(scope, 'job-1')).slots[0]?.prompt).toContain('private prompt');
  });

  it('projects a wire snapshot without prompt, bytes, path, or workspace fields', async () => {
    const persistence = createPersistence();
    const job = await persistence.create(scope, createInput());
    const wire = persistence.toWire(job);
    const serialized = JSON.stringify(wire);

    expect(wire.slots[0]).not.toHaveProperty('prompt');
    expect(serialized).not.toContain('private prompt');
    expect(serialized).not.toContain('bytes');
    expect(serialized).not.toContain('workspace');
    expect(serialized).not.toContain('path');
    expect(toImageGenerationJobWireSnapshot(job)).toEqual(wire);
  });

  it('keeps artifact snapshots and asset refs available after a restart', async () => {
    const repository = new InMemoryImageGenerationPlanRepository();
    const first = createPersistence(repository);
    await first.create(scope, createInput());
    await first.update(scope, 'job-1', {
      slots: [{ ...slots[0], assetRefs: [assetSnapshot.asset], state: 'ready' }],
    });
    const restarted = createPersistence(repository);

    await expect(restarted.get(scope, 'job-1')).resolves.toMatchObject({
      artifactSnapshots: [assetSnapshot],
      slots: [{ assetRefs: [assetSnapshot.asset], state: 'ready' }],
    });
  });

  it('returns a stable not-found error and supports idempotent removal', async () => {
    const persistence = createPersistence();

    await expectCode(persistence.resume(scope, 'missing-job'), 'IMAGE_PLAN_NOT_FOUND');
    await expect(persistence.remove(scope, 'missing-job')).resolves.toBeUndefined();
    await persistence.create(scope, createInput());
    await expect(persistence.remove(scope, 'job-1')).resolves.toBeUndefined();
    await expect(persistence.remove(scope, 'job-1')).resolves.toBeUndefined();
  });

  it('uses an asynchronous repository without exposing its internal record identity', async () => {
    const repository = new InMemoryImageGenerationPlanRepository();
    const get = vi.spyOn(repository, 'get');
    const persistence = createPersistence(repository);
    const created = await persistence.create(scope, createInput());
    const loaded = await persistence.get(scope, 'job-1');

    expect(get).toHaveBeenCalled();
    expect(loaded).toEqual(created);
    expect(loaded).not.toBe(created);
  });

  it('rejects invalid scope, plan, state, and use after dispose', async () => {
    const persistence = createPersistence();

    await expectCode(
      persistence.create({ userId: 'missing-session' } as never, createInput()),
      'IMAGE_PLAN_SCOPE_MISMATCH',
    );
    await expectCode(
      persistence.create(scope, { ...createInput(), slots: [] }),
      'IMAGE_PLAN_INVALID',
    );
    await expectCode(
      persistence.create(scope, { ...createInput(), state: 'unknown' as never }),
      'IMAGE_PLAN_STATE_INVALID',
    );
    persistence.dispose();
    persistence.dispose();
    await expectCode(persistence.get(scope, 'job-1'), 'IMAGE_PLAN_PERSISTENCE_DISPOSED');
    expect(ImageGenerationPersistenceError).toBeDefined();
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  createPresentationStudioStore,
  type PresentationSlotState,
  type PresentationStreamClient,
} from './presentationStore';

const baseClient = (): PresentationStreamClient => ({
  cancelPresentationJob: vi.fn(),
  createPresentationJob: vi.fn(),
  exportArtifact: vi.fn(),
  getArtifact: vi.fn(),
  getPresentationJob: vi.fn(async () => null),
  retryPresentationJob: vi.fn(),
});

const readySlot = (overrides: Partial<PresentationSlotState> = {}): PresentationSlotState => ({
  artifactIds: [],
  errorCode: null,
  label: 'Chart 2',
  lastSeq: 1,
  slotId: 'chart-2',
  slideId: 'slide-1',
  status: 'ready',
  ...overrides,
});

describe('PresentationStudio material slot state (C-87)', () => {
  it('projects slot events with per-slot seq idempotency and no fabricated ready', () => {
    const store = createPresentationStudioStore(baseClient());

    store.getState().applySlotEvent('job-1', {
      data: { slideId: 'slide-1', slotId: 'chart-1', status: 'generating' },
      seq: 1,
      type: 'asset_progress',
    });
    store.getState().applySlotEvent('job-1', {
      data: {
        artifactId: 'art-1',
        slideId: 'slide-1',
        slotId: 'chart-1',
        status: 'ready',
      },
      seq: 2,
      type: 'asset_progress',
    });

    let state = store.getState();
    const slot = state.slots['job-1:slide-1:chart-1'];
    expect(slot.status).toBe('ready');
    expect(slot.artifactIds).toEqual(['art-1']);
    expect(slot.lastSeq).toBe(2);

    // Replay of seq 2 is a no-op (per-slot idempotency).
    store.getState().applySlotEvent('job-1', {
      data: {
        slideId: 'slide-1',
        slotId: 'chart-1',
        status: 'failed',
      },
      seq: 2,
      type: 'asset_progress',
    });
    expect(store.getState().slots['job-1:slide-1:chart-1'].status).toBe('ready');

    // Ready without any artifact id is not trusted — no fabricated ready.
    store.getState().applySlotEvent('job-1', {
      data: { slideId: 's', slotId: 'x', status: 'ready' },
      seq: 1,
      type: 'asset_progress',
    });
    state = store.getState();
    expect(state.slots['job-1:s:x']).toBeUndefined();
    expect(state.ignoredEvents).toBe(1);
  });

  it('strips prompts and unknown payload fields from slot state', () => {
    const store = createPresentationStudioStore(baseClient());

    store.getState().applySlotEvent('job-1', {
      data: {
        label: 'Diagram 1',
        prompt: 'SECRET user prompt text',
        slideId: 'slide-2',
        slotId: 'diagram-1',
        status: 'queued',
        vendorSecret: 'sk-123',
      },
      seq: 1,
      type: 'asset_accepted',
    });

    const serialized = JSON.stringify(store.getState().slots);
    expect(serialized).not.toContain('SECRET user prompt text');
    expect(serialized).not.toContain('sk-123');
    expect(store.getState().slots['job-1:slide-2:diagram-1'].label).toBe('Diagram 1');
  });

  it('isolates slot events per slot and records malformed payloads observably', () => {
    const store = createPresentationStudioStore(baseClient());
    store.setState({ slots: { 'job-1:slide-1:keep': readySlot() } });

    store
      .getState()
      .applySlotEvent('job-1', { data: { slotId: 'x' }, seq: 9, type: 'asset_progress' });
    // Missing slideId → ignored observably.
    expect(store.getState().ignoredEvents).toBe(1);

    // A different slot's event never touches the existing one.
    store.getState().applySlotEvent('job-1', {
      data: { slideId: 'slide-9', slotId: 'other', status: 'failed' },
      seq: 3,
      type: 'asset_progress',
    });
    expect(store.getState().slots['job-1:slide-1:keep'].status).toBe('ready');
    expect(store.getState().slots['job-1:slide-9:other'].status).toBe('failed');
  });
});

describe('PresentationStudio single-slot retry (C-87)', () => {
  it('retries only the requested slot through the injected adapter', async () => {
    const retrySlotAdapter = vi
      .fn()
      .mockResolvedValueOnce({ status: 'ready' })
      .mockResolvedValueOnce({ status: 'generating' });
    const store = createPresentationStudioStore(baseClient(), { retrySlotAdapter });
    store.setState({
      slots: {
        'job-1:slide-1:a': readySlot({
          slotId: 'a',
          status: 'failed',
          errorCode: 'IMAGE_UNAVAILABLE',
        }),
        'job-1:slide-1:b': readySlot({ slotId: 'b', status: 'ready' }),
      },
    });

    const ok = await store.getState().retrySlot('job-1', 'slide-1', 'a');
    expect(ok).toBe(true);
    expect(retrySlotAdapter).toHaveBeenCalledWith({
      jobId: 'job-1',
      scopeKey: 'job-1:slide-1:a',
      slideId: 'slide-1',
      slotId: 'a',
    });

    const state = store.getState();
    // The retried slot is ready; the sibling slot is untouched.
    expect(state.slots['job-1:slide-1:a'].status).toBe('ready');
    expect(state.slots['job-1:slide-1:a'].errorCode).toBeNull();
    expect(state.slots['job-1:slide-1:b'].status).toBe('ready');
    // Selection and draft fields untouched.
    expect(state.selectedJobId).toBeNull();
    expect(state.lastCreateInput).toBeNull();
  });

  it('guards re-entrancy and preserves the failure honestly', async () => {
    let resolveRetry: (v: { status: 'ready' }) => void = () => undefined;
    const retrySlotAdapter = vi.fn(
      () =>
        new Promise<{ status: 'ready' }>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const store = createPresentationStudioStore(baseClient(), { retrySlotAdapter });
    store.setState({
      slots: { 'job-1:slide-1:a': readySlot({ status: 'failed', errorCode: 'X' }) },
    });

    const first = store.getState().retrySlot('job-1', 'slide-1', 'a');
    await vi.waitFor(() => {
      expect(store.getState().slotRetryPending['job-1:slide-1:a']).toBe(true);
      // In-flight status is visible for aria-busy.
      expect(store.getState().slots['job-1:slide-1:a'].status).toBe('generating');
    });

    // Second call while in flight resolves false without a new request.
    await expect(store.getState().retrySlot('job-1', 'slide-1', 'a')).resolves.toBe(false);
    expect(retrySlotAdapter).toHaveBeenCalledTimes(1);

    resolveRetry({ status: 'ready' });
    await expect(first).resolves.toBe(true);
    expect(store.getState().slotRetryPending['job-1:slide-1:a']).toBe(false);
  });

  it('maps adapter failures to a stable prompt-free slot error', async () => {
    const retrySlotAdapter = vi
      .fn()
      .mockRejectedValue(new Error('HTTP 503 IMAGE_UNAVAILABLE: down'));
    const store = createPresentationStudioStore(baseClient(), { retrySlotAdapter });
    store.setState({ slots: { 'job-1:slide-1:a': readySlot() } });

    const ok = await store.getState().retrySlot('job-1', 'slide-1', 'a');
    expect(ok).toBe(false);
    const slot = store.getState().slots['job-1:slide-1:a'];
    expect(slot.status).toBe('failed');
    expect(slot.errorCode).toBe('IMAGE_UNAVAILABLE');
    expect(JSON.stringify(store.getState().slots)).not.toContain('HTTP 503');
    // The pending flag is released for another attempt.
    expect(store.getState().slotRetryPending['job-1:slide-1:a']).toBe(false);
  });

  it('is a no-op without an injected adapter', async () => {
    const store = createPresentationStudioStore(baseClient());
    await expect(store.getState().retrySlot('job-1', 'slide-1', 'a')).resolves.toBe(false);
  });
});

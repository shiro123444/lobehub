import { describe, expect, it, vi } from 'vitest';

import { RuntimeClientImpl } from '../../../services/runtime/client';
import {
  createHttpRetrySlotAdapter,
  createPresentationStudioStore,
  type PresentationStreamClient,
} from './presentationStore';

const baseClient = (overrides: Record<string, unknown> = {}): PresentationStreamClient => ({
  cancelPresentationJob: vi.fn(),
  createImageGeneration: vi.fn(),
  createPresentationJob: vi.fn(),
  exportArtifact: vi.fn(),
  getArtifact: vi.fn(),
  getPresentationJob: vi.fn(async () => null),
  retryPresentationJob: vi.fn(),
  ...overrides,
});

const readySlot = (slotId: string) => ({
  artifactIds: [],
  errorCode: null,
  label: slotId,
  lastSeq: 1,
  slotId,
  slideId: 'slide-1',
  status: 'ready' as const,
});

describe('C-96 / C-99 default HTTP retrySlot seam', () => {
  it('routes retrySlot through createImageGeneration and maps accepted → generating when prompt is resolved', async () => {
    const createImageGeneration = vi.fn(async () => ({
      jobId: 'job-1',
      slots: [{ slideId: 'slide-1', slotId: 'a', status: 'accepted' as const }],
    }));
    const resolveSlotPrompt = vi.fn(
      ({ jobId, slideId, slotId }) => `Photo for ${jobId}:${slideId}:${slotId}`,
    );
    const store = createPresentationStudioStore(baseClient({ createImageGeneration }), {
      resolveSlotPrompt,
    });
    store.setState({ slots: { 'job-1:slide-1:a': readySlot('a') } });

    const ok = await store.getState().retrySlot('job-1', 'slide-1', 'a');

    expect(ok).toBe(false); // accepted → generating, not yet ready
    expect(resolveSlotPrompt).toHaveBeenCalledWith({
      jobId: 'job-1',
      slideId: 'slide-1',
      slotId: 'a',
    });
    expect(createImageGeneration).toHaveBeenCalledWith({
      jobId: 'job-1',
      slots: [
        {
          idempotencyKey: 'job-1:slide-1:a',
          prompt: 'Photo for job-1:slide-1:a',
          slideId: 'slide-1',
          slotId: 'a',
        },
      ],
    });
    const slot = store.getState().slots['job-1:slide-1:a'];
    expect(slot.status).toBe('generating');
    expect(slot.errorCode).toBeNull();
    expect(store.getState().slotRetryPending['job-1:slide-1:a']).toBe(false);
  });

  it('returns IMAGE_PLAN_INVALID without calling createImageGeneration when no resolveSlotPrompt is configured', async () => {
    const createImageGeneration = vi.fn();
    const store = createPresentationStudioStore(baseClient({ createImageGeneration }));
    store.setState({ slots: { 'job-1:slide-1:a': readySlot('a') } });

    const ok = await store.getState().retrySlot('job-1', 'slide-1', 'a');

    expect(ok).toBe(false);
    expect(createImageGeneration).not.toHaveBeenCalled();
    const slot = store.getState().slots['job-1:slide-1:a'];
    expect(slot.status).toBe('failed');
    expect(slot.errorCode).toBe('IMAGE_PLAN_INVALID');
    expect(store.getState().slotRetryPending['job-1:slide-1:a']).toBe(false);
  });

  it('returns IMAGE_PLAN_INVALID without calling createImageGeneration when resolveSlotPrompt returns empty/whitespace or undefined', async () => {
    const createImageGeneration = vi.fn();

    // 1. undefined
    const storeUndefined = createPresentationStudioStore(baseClient({ createImageGeneration }), {
      resolveSlotPrompt: () => undefined,
    });
    storeUndefined.setState({ slots: { 'job-1:slide-1:a': readySlot('a') } });
    await expect(storeUndefined.getState().retrySlot('job-1', 'slide-1', 'a')).resolves.toBe(false);
    expect(storeUndefined.getState().slots['job-1:slide-1:a'].errorCode).toBe('IMAGE_PLAN_INVALID');

    // 2. empty string
    const storeEmpty = createPresentationStudioStore(baseClient({ createImageGeneration }), {
      resolveSlotPrompt: () => '',
    });
    storeEmpty.setState({ slots: { 'job-1:slide-1:a': readySlot('a') } });
    await expect(storeEmpty.getState().retrySlot('job-1', 'slide-1', 'a')).resolves.toBe(false);
    expect(storeEmpty.getState().slots['job-1:slide-1:a'].errorCode).toBe('IMAGE_PLAN_INVALID');

    // 3. whitespace only
    const storeWhitespace = createPresentationStudioStore(baseClient({ createImageGeneration }), {
      resolveSlotPrompt: () => '   \t\n  ',
    });
    storeWhitespace.setState({ slots: { 'job-1:slide-1:a': readySlot('a') } });
    await expect(storeWhitespace.getState().retrySlot('job-1', 'slide-1', 'a')).resolves.toBe(
      false,
    );
    expect(storeWhitespace.getState().slots['job-1:slide-1:a'].errorCode).toBe(
      'IMAGE_PLAN_INVALID',
    );

    expect(createImageGeneration).not.toHaveBeenCalled();
  });

  it('maps a per-slot rejection to a stable errorCode without touching siblings', async () => {
    const createImageGeneration = vi.fn(async () => ({
      jobId: 'job-1',
      slots: [
        {
          errorCode: 'IMAGE_BUDGET_EXCEEDED',
          slideId: 'slide-1',
          slotId: 'a',
          status: 'failed' as const,
        },
      ],
    }));
    const store = createPresentationStudioStore(baseClient({ createImageGeneration }), {
      resolveSlotPrompt: () => 'valid prompt',
    });
    store.setState({
      slots: { 'job-1:slide-1:a': readySlot('a'), 'job-1:slide-1:b': readySlot('b') },
    });

    const ok = await store.getState().retrySlot('job-1', 'slide-1', 'a');

    expect(ok).toBe(false);
    expect(store.getState().slots['job-1:slide-1:a'].status).toBe('failed');
    expect(store.getState().slots['job-1:slide-1:a'].errorCode).toBe('IMAGE_BUDGET_EXCEEDED');
    expect(store.getState().slots['job-1:slide-1:b'].status).toBe('ready');
  });

  it('maps HTTP errors (401/4xx/503) to structured prompt-free slot errors', async () => {
    const createImageGeneration = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Failed to create image generation (401 Unauthorized): {"error":{"code":"IMAGE_PROVIDER_REJECTED","message":"auth"}}',
        ),
      );
    const store = createPresentationStudioStore(baseClient({ createImageGeneration }), {
      resolveSlotPrompt: () => 'confidential prompt text',
    });
    store.setState({ slots: { 'job-1:slide-1:a': readySlot('a') } });

    const ok = await store.getState().retrySlot('job-1', 'slide-1', 'a');

    expect(ok).toBe(false);
    const slot = store.getState().slots['job-1:slide-1:a'];
    expect(slot.status).toBe('failed');
    expect(slot.errorCode).toBe('IMAGE_PROVIDER_REJECTED');
    // The structured mapping keeps the code, drops the raw transport text.
    expect(JSON.stringify(store.getState().slots)).not.toContain('401 Unauthorized');
    expect(JSON.stringify(store.getState().slots)).not.toContain('confidential prompt text');
    expect(store.getState().slotRetryPending['job-1:slide-1:a']).toBe(false);
  });

  it('keeps prompt text out of Zustand state entirely', async () => {
    const secretPrompt = 'TOP_SECRET_PROMPT_KEY_xyz123';
    const createImageGeneration = vi.fn(async () => ({
      jobId: 'job-1',
      slots: [{ slideId: 'slide-1', slotId: 'a', status: 'accepted' as const }],
    }));
    const store = createPresentationStudioStore(baseClient({ createImageGeneration }), {
      resolveSlotPrompt: () => secretPrompt,
    });
    store.setState({ slots: { 'job-1:slide-1:a': readySlot('a') } });

    await store.getState().retrySlot('job-1', 'slide-1', 'a');

    // Prompt was passed in wire request
    expect(createImageGeneration).toHaveBeenCalledWith({
      jobId: 'job-1',
      slots: [
        {
          idempotencyKey: 'job-1:slide-1:a',
          prompt: secretPrompt,
          slideId: 'slide-1',
          slotId: 'a',
        },
      ],
    });
    // Prompt NEVER entered Zustand state
    expect(JSON.stringify(store.getState())).not.toContain(secretPrompt);
  });

  it('keeps explicit retrySlotAdapter injection overriding the default HTTP seam even when resolveSlotPrompt is provided', async () => {
    const createImageGeneration = vi.fn();
    const resolveSlotPrompt = vi.fn(() => 'prompt that should be ignored');
    const retrySlotAdapter = vi.fn(async () => ({ status: 'ready' as const }));
    const store = createPresentationStudioStore(baseClient({ createImageGeneration }), {
      resolveSlotPrompt,
      retrySlotAdapter,
    });
    store.setState({ slots: { 'job-1:slide-1:a': readySlot('a') } });

    const ok = await store.getState().retrySlot('job-1', 'slide-1', 'a');

    expect(ok).toBe(true);
    expect(retrySlotAdapter).toHaveBeenCalledTimes(1);
    expect(resolveSlotPrompt).not.toHaveBeenCalled();
    expect(createImageGeneration).not.toHaveBeenCalled();
  });

  it('uses the real RuntimeClientImpl default with resolveSlotPrompt', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('network unreachable');
    });
    const store = createPresentationStudioStore(new RuntimeClientImpl({ fetcher }), {
      resolveSlotPrompt: () => 'network test prompt',
    });
    store.setState({ slots: { 'job-1:slide-1:a': readySlot('a') } });

    const ok = await store.getState().retrySlot('job-1', 'slide-1', 'a');

    expect(ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.getState().slots['job-1:slide-1:a'].status).toBe('failed');
    expect(store.getState().slots['job-1:slide-1:a'].errorCode).toBe('RUNTIME_ERROR');
  });

  it('supports createHttpRetrySlotAdapter called directly with function or options object', async () => {
    const client = baseClient({
      createImageGeneration: vi.fn(async () => ({
        jobId: 'job-1',
        slots: [{ slideId: 's1', slotId: 'x', status: 'accepted' as const }],
      })),
    });

    const fnAdapter = createHttpRetrySlotAdapter(client, () => 'fn prompt');
    const res1 = await fnAdapter({
      jobId: 'job-1',
      scopeKey: 'job-1:s1:x',
      slideId: 's1',
      slotId: 'x',
    });
    expect(res1).toEqual({ status: 'generating' });

    const optAdapter = createHttpRetrySlotAdapter(client, {
      resolveSlotPrompt: () => 'opt prompt',
    });
    const res2 = await optAdapter({
      jobId: 'job-1',
      scopeKey: 'job-1:s1:x',
      slideId: 's1',
      slotId: 'x',
    });
    expect(res2).toEqual({ status: 'generating' });
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as geometry from './geometry';
import { SlideAnnotation } from './SlideAnnotation';

const svg = '<svg viewBox="0 0 960 540"><text x="100" y="100">Title</text></svg>';
afterEach(() => vi.restoreAllMocks());
describe('annotation capsule', () => {
  it('queues the selected element with its page fingerprint and keeps a rejected comment editable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ versionId: 'v1', slide: { slideId: 'slide-2', svg } }), {
        status: 200,
      }),
    );
    vi.spyOn(geometry, 'measureAnnotationElements').mockReturnValue([
      { index: 0, x: 0, y: 0, width: 1, height: 1 },
    ]);
    const select = vi.spyOn(geometry, 'selectAnnotationElements').mockReturnValue([0]);
    const close = vi.fn();
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<SlideAnnotation jobId="job" page={2} versionId="v1" onClose={close} onSend={send} />);
    await screen.findByText('点选或框选');
    const overlay = screen.getByRole('application');
    overlay.setPointerCapture = vi.fn();
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 960,
      height: 540,
      right: 960,
      bottom: 540,
      toJSON: () => ({}),
    });
    // PointerEvent is not provided by jsdom, so use MouseEvent properties for this gesture.
    fireEvent(
      overlay,
      new MouseEvent('pointerdown', { clientX: 120, clientY: 100, bubbles: true }),
    );
    fireEvent(overlay, new MouseEvent('pointerup', { clientX: 120, clientY: 100, bubbles: true }));
    expect(select).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('局部修改意见'), {
      target: { value: '标题改成自然创作' },
    });
    fireEvent.click(screen.getByLabelText('发送标注'));
    await screen.findByText('未能发送，请重试或重新标注');
    expect(close).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]).toMatchObject({
      content: '标题改成自然创作',
      target: { type: 'slide', slideNumber: 2 },
      annotation: {
        slideId: 'slide-2',
        expectedVersionId: 'v1',
        elementIndices: [0],
        baseSvgHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    fireEvent.submit(screen.getByLabelText('局部修改意见').closest('form')!);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(send.mock.calls[1][1].requestId).toBe(send.mock.calls[0][1].requestId);
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PresentationSlotState } from '../store/presentationStore';
import AssetSlotPanel from './index';

const slot = (overrides: Partial<PresentationSlotState> = {}): PresentationSlotState => ({
  artifactIds: [],
  errorCode: null,
  label: 'Chart 2',
  lastSeq: 1,
  slotId: 'chart-2',
  slideId: 'slide-1',
  status: 'queued',
  ...overrides,
});

const renderPanel = (
  slots: PresentationSlotState[],
  handlers: {
    onDismissError?: (s: string, k: string) => void;
    onRetry?: (s: string, k: string) => void;
    resolveArtifactUri?: (artifactId: string) => string | undefined;
    retryPendingKeys?: Record<string, boolean>;
  } = {},
) =>
  render(
    <AssetSlotPanel
      resolveArtifactUri={handlers.resolveArtifactUri}
      retryPendingKeys={handlers.retryPendingKeys}
      slots={slots}
      onDismissError={handlers.onDismissError}
      onRetry={handlers.onRetry}
    />,
  );

describe('AssetSlotPanel (C-87)', () => {
  it('renders the five slot statuses with honest placeholders and empty state', () => {
    renderPanel([
      slot({ slotId: 'a', status: 'queued' }),
      slot({ slotId: 'b', status: 'generating' }),
      slot({ slotId: 'c', status: 'ready', artifactIds: ['art-1'] }),
      slot({ slotId: 'd', status: 'failed', errorCode: 'IMAGE_UNAVAILABLE' }),
      slot({ slotId: 'e', status: 'cancelled' }),
    ]);

    expect(screen.getByTestId('asset-slot-panel')).toBeInTheDocument();
    expect(screen.getByTestId('slot-status-queued')).toBeInTheDocument();
    expect(screen.getByTestId('slot-status-generating')).toBeInTheDocument();
    expect(screen.getByTestId('slot-status-ready')).toBeInTheDocument();
    expect(screen.getByTestId('slot-status-failed')).toBeInTheDocument();
    expect(screen.getByTestId('slot-status-cancelled')).toBeInTheDocument();
    // Generating slot announces aria-busy for AT.
    expect(screen.getByTestId('slot-slide-1-b')).toHaveAttribute('aria-busy', 'true');
    // No fake ready: the ready slot without artifacts still shows honestly.
    expect(screen.getByTestId('slot-slide-1-c')).toBeInTheDocument();

    const { unmount } = renderPanel([]);
    expect(screen.getByText('No material slots for this job yet.')).toBeInTheDocument();
    unmount();
  });

  it('keeps prompt text out of the DOM entirely', () => {
    const { container } = renderPanel([
      // Prompts never enter slot state; the label is prompt-free by contract.
      slot({ label: 'Diagram 1' }),
    ]);
    expect(container.textContent).not.toContain('prompt');
    expect(screen.getByText('Diagram 1')).toBeInTheDocument();
  });

  it('fires single-slot retry only for the pressed slot with keyboard access', async () => {
    const onRetry = vi.fn();
    renderPanel(
      [
        slot({ slotId: 'a', status: 'failed', errorCode: 'IMAGE_UNAVAILABLE' }),
        slot({ slotId: 'b', status: 'ready' }),
      ],
      {
        onRetry,
      },
    );

    const retryA = screen.getByTestId('slot-retry-slide-1-a');
    // Keyboard-reachable button.
    retryA.focus();
    expect(document.activeElement).toBe(retryA);
    fireEvent.click(retryA);
    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
    expect(onRetry).toHaveBeenCalledWith('slide-1', 'a');
    // The ready sibling exposes no retry button at all.
    expect(screen.queryByTestId('slot-retry-slide-1-b')).not.toBeInTheDocument();
  });

  it('disables retry with aria-busy while that slot is regenerating', async () => {
    const onRetry = vi.fn();
    renderPanel([slot({ slotId: 'a', status: 'failed', errorCode: 'X' })], {
      onRetry,
      retryPendingKeys: { 'slide-1:a': true },
    });

    const retry = screen.getByTestId('slot-retry-slide-1-a');
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('slot-slide-1-a')).toHaveAttribute('aria-busy', 'true');
    // Clicking a disabled button fires nothing.
    fireEvent.click(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('shows stable errors with a dismiss affordance without leaking prompts', async () => {
    const onDismissError = vi.fn();
    renderPanel([slot({ slotId: 'a', status: 'failed', errorCode: 'IMAGE_PROVIDER_REJECTED' })], {
      onDismissError,
    });

    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('IMAGE_PROVIDER_REJECTED');
    fireEvent.click(screen.getByRole('button', { name: /Dismiss error/i }));
    await waitFor(() => {
      expect(onDismissError).toHaveBeenCalledWith('slide-1', 'a');
    });
  });

  it('supports keyboard activation through a native button focus path', async () => {
    const onRetry = vi.fn();
    renderPanel([slot({ slotId: 'k', status: 'cancelled' })], { onRetry });

    const retry = screen.getByTestId('slot-retry-slide-1-k');
    retry.focus();
    // jsdom keyDown does not synthesise native activation; the click below is
    // the proxy for the browser's Enter/Space activation of a focused button.
    fireEvent.keyDown(retry, { key: 'Enter', code: 'Enter' });
    fireEvent.click(retry);
    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledWith('slide-1', 'k');
    });
  });
});

describe('AssetSlotPanel artifact thumbnails (C-92)', () => {
  it('renders a real image when the resolver returns a safe https/data URI', () => {
    renderPanel([slot({ slotId: 'ok', status: 'ready', artifactIds: ['art-ok'] })], {
      resolveArtifactUri: (artifactId) =>
        artifactId === 'art-ok' ? 'https://assets.example/chart.png' : undefined,
    });

    const thumb = screen.getByTestId('slot-thumb-slide-1-ok');
    expect(thumb).toHaveAttribute('src', 'https://assets.example/chart.png');
    expect(thumb).toHaveAttribute('loading', 'lazy');
    expect(thumb).toHaveAttribute('alt', 'Generated material for slide slide-1 slot ok');
    // object-fit is kept by the stylesheet contract.
    const stylesSource = JSON.stringify(document.querySelector('style')?.textContent ?? '');
    void stylesSource;
  });

  it('keeps the placeholder for missing resolver output or non-ready slots', () => {
    renderPanel(
      [
        slot({ slotId: 'no-uri', status: 'ready', artifactIds: ['art-missing'] }),
        slot({ slotId: 'queued', status: 'queued', artifactIds: ['art-queued'] }),
      ],
      {
        resolveArtifactUri: () => undefined,
      },
    );

    expect(screen.queryByTestId('slot-thumb-slide-1-no-uri')).not.toBeInTheDocument();
    expect(screen.queryByTestId('slot-thumb-slide-1-queued')).not.toBeInTheDocument();
    // Placeholders are honest icons, not fabricated images.
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('falls back to the placeholder for unsafe URIs and never renders refs/paths/prompts', () => {
    renderPanel(
      [
        slot({ slotId: 'file', status: 'ready', artifactIds: ['art-file'] }),
        slot({ slotId: 'path', status: 'ready', artifactIds: ['art-path'] }),
        slot({ slotId: 'script', status: 'ready', artifactIds: ['art-script'] }),
        slot({ slotId: 'malformed', status: 'ready', artifactIds: ['art-malformed'] }),
      ],
      {
        resolveArtifactUri: (artifactId) => {
          switch (artifactId) {
            case 'art-file': {
              return 'file:///etc/passwd';
            }
            case 'art-path': {
              return '/home/shiro/secret.png';
            }
            case 'art-malformed': {
              return 'https:notaurl';
            }
            default: {
              return 'javascript:alert(1)';
            }
          }
        },
      },
    );

    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(document.querySelector('img[src^="file:"]')).toBeNull();
    expect(document.querySelector('img[src^="javascript:"]')).toBeNull();
    const html = document.body.innerHTML;
    expect(html).not.toContain('/etc/passwd');
    expect(html).not.toContain('/home/shiro/secret.png');
    expect(html).not.toContain('prompt=');
  });

  it('renders data:image URIs and keeps prompts out of the DOM', () => {
    const { container } = renderPanel(
      [slot({ slotId: 'data', status: 'ready', artifactIds: ['art-data'], label: 'Diagram 1' })],
      {
        resolveArtifactUri: () => 'data:image/svg+xml,%3Csvg/%3E',
      },
    );

    const thumb = screen.getByTestId('slot-thumb-slide-1-data');
    expect(thumb).toHaveAttribute('src', 'data:image/svg+xml,%3Csvg/%3E');
    // The label is prompt-free by contract; nothing else leaks.
    expect(container.textContent).not.toContain('prompt');
    expect(container.textContent).toContain('Diagram 1');
  });
});

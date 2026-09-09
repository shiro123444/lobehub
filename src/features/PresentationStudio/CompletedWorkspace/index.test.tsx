import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  PresentationJob,
} from '../../../../packages/runtime-contracts/src/index';
import type { PresentationSlotState } from '../store/presentationStore';
import CompletedWorkspace from './index';

const t0 = '2026-09-04T12:00:00.000Z';

const mockJob: PresentationJob = {
  artifactIds: ['slide-1', 'slide-2', 'slide-3'],
  createdAt: t0,
  jobId: 'job-done',
  state: 'completed',
  updatedAt: t0,
};

const mockSlides: ArtifactSnapshot[] = [
  {
    artifactId: 'slide-1',
    createdAt: t0,
    metadata: {
      notes: '欢迎大家参加本次关于人工智能在产品设计中应用的分享。',
      outline: ['引言与背景', '核心议题阐述', '预期产出目标'],
      slideId: 'slide-1',
      slideNumber: 1,
      title: 'AI 驱动的产品设计创新',
    },
    mimeType: 'image/svg+xml',
    name: 'Slide 1.svg',
    sizeBytes: 1024,
    status: 'ready',
    type: 'svg',
    updatedAt: t0,
    uri: 'data:image/svg+xml,mock-svg-1',
  },
  {
    artifactId: 'slide-2',
    createdAt: t0,
    metadata: {
      slideId: 'slide-2',
      slideNumber: 2,
      title: '市场趋势与技术洞察',
    },
    mimeType: 'image/svg+xml',
    name: 'Slide 2.svg',
    sizeBytes: 2048,
    status: 'ready',
    type: 'svg',
    updatedAt: t0,
    uri: 'data:image/svg+xml,mock-svg-2',
  },
  {
    artifactId: 'slide-3',
    createdAt: t0,
    metadata: {
      slideId: 'slide-3',
      slideNumber: 3,
      title: '未来落地与生态规划',
    },
    mimeType: 'image/svg+xml',
    name: 'Slide 3.svg',
    sizeBytes: 1536,
    status: 'ready',
    type: 'svg',
    updatedAt: t0,
    uri: 'data:image/svg+xml,mock-svg-3',
  },
];

const mockSlots: PresentationSlotState[] = [
  {
    artifactIds: ['art-chart-1'],
    errorCode: null,
    label: '市场增长图表',
    lastSeq: 1,
    slideId: 'slide-1',
    slotId: 'slot-1',
    status: 'ready',
  },
];

describe('CompletedWorkspace', () => {
  it('enters Slide Focus Mode by default with 16:9 preview and bottom paginator', () => {
    const onSelectArtifact = vi.fn();
    const onExport = vi.fn();

    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        resolveArtifactUri={() => 'https://example.com/asset.png'}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={mockJob}
        selectedJobArtifacts={mockSlides}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        onAiModify={vi.fn()}
        onExport={onExport}
        onRetryJob={vi.fn()}
        onSelectArtifact={onSelectArtifact}
      />,
    );

    // Top capsule floating bar
    expect(screen.getByTestId('presentation-editor-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent('已完成 · 共 3 页');
    expect(screen.getByText('AI 演示文稿')).toBeInTheDocument();
    expect(screen.getByText('商务科技')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全景网格' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Quick export presentation/i })).toBeInTheDocument();

    // Central 16:9 preview
    expect(screen.getByTestId('slide-preview-image')).toHaveAttribute(
      'src',
      'data:image/svg+xml,mock-svg-1',
    );

    // Bottom paginator: 01 / 03, previous disabled, next enabled
    expect(screen.getByTestId('slide-page-counter')).toHaveTextContent('01 / 03');
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled();

    // Navigate to next slide
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(onSelectArtifact).toHaveBeenCalledWith('slide-2');
  });

  it('toggles Panorama Lightbox Mode with Bento grid and returns to Focus Mode on card click', () => {
    const onSelectArtifact = vi.fn();

    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={mockJob}
        selectedJobArtifacts={mockSlides}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        onAiModify={vi.fn()}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={onSelectArtifact}
      />,
    );

    // Toggle to Panorama Bento Grid
    fireEvent.click(screen.getByRole('button', { name: '全景网格' }));
    expect(screen.getByTestId('presentation-bento-grid')).toBeInTheDocument();
    expect(screen.getByTestId('bento-card-slide-1')).toBeInTheDocument();
    expect(screen.getByTestId('bento-card-slide-2')).toBeInTheDocument();
    expect(screen.getByTestId('bento-card-slide-3')).toBeInTheDocument();

    // Click slide-2 card: should select slide-2 and switch back to Focus Mode
    fireEvent.click(screen.getByTestId('bento-card-slide-2'));
    expect(onSelectArtifact).toHaveBeenCalledWith('slide-2');
    expect(screen.queryByTestId('presentation-bento-grid')).not.toBeInTheDocument();
    expect(screen.getByTestId('slide-preview')).toBeInTheDocument();
  });

  it('opens Architecture and Assets drawer showing 3 sections strictly for current slide', () => {
    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        resolveArtifactUri={() => 'https://example.com/asset.png'}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={mockJob}
        selectedJobArtifacts={mockSlides}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        onAiModify={vi.fn()}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={vi.fn()}
      />,
    );

    const drawer = screen.getByTestId('presentation-architecture-drawer');
    expect(drawer).toHaveAttribute('data-open', 'false');

    // Click "架构与资产" button in header
    fireEvent.click(screen.getByRole('button', { name: '查看架构与资产' }));
    expect(drawer).toHaveAttribute('data-open', 'true');

    // 3 sections present
    expect(screen.getByTestId('drawer-outline-section')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-assets-section')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-notes-section')).toBeInTheDocument();

    // Outline content for slide 1
    expect(screen.getByText('引言与背景')).toBeInTheDocument();

    // Assets content for slide 1
    expect(screen.getAllByText('市场增长图表').length).toBeGreaterThanOrEqual(1);

    // Speaker notes content for slide 1
    expect(screen.getByText(/欢迎大家参加本次关于人工智能/)).toBeInTheDocument();

    // Close drawer
    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));
    expect(drawer).toHaveAttribute('data-open', 'false');
  });

  it('triggers quick export for PPTX format', () => {
    const onExport = vi.fn();

    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={mockJob}
        selectedJobArtifacts={mockSlides}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        onAiModify={vi.fn()}
        onExport={onExport}
        onRetryJob={vi.fn()}
        onSelectArtifact={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Quick export presentation/i }));
    expect(onExport).toHaveBeenCalledWith('slide-1', 'pptx');
  });

  it('supports toggling the collapsible slide filmstrip', () => {
    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={mockJob}
        selectedJobArtifacts={mockSlides}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        onAiModify={vi.fn()}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={vi.fn()}
      />,
    );

    const toggleBtn = screen.getByRole('button', { name: '展开胶卷' });
    expect(toggleBtn).toBeInTheDocument();

    fireEvent.click(toggleBtn);
    expect(screen.getByRole('button', { name: '收起胶卷' })).toBeInTheDocument();
    expect(screen.getByText('缩略胶卷')).toBeInTheDocument();
  });
});

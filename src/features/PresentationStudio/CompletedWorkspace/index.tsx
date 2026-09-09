import { Button, Flexbox, Icon } from '@lobehub/ui';
import { ChevronLeft, ChevronRight, Layers } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';

import SlideNavigator from '../SlideNavigator';
import ArchitectureDrawer from './ArchitectureDrawer';
import CapsuleHeader from './CapsuleHeader';
import PanoramaGrid from './PanoramaGrid';
import SlideFocusStage from './SlideFocusStage';
import { styles } from './style';
import type { CompletedViewMode, CompletedWorkspaceProps } from './types';

export const CompletedWorkspace = memo<CompletedWorkspaceProps>(
  ({
    canExport,
    creating = false,
    dismissSlotError,
    effectiveSelectedArtifactId,
    exported,
    exporting,
    jobTitles,
    onAiModify,
    onExport,
    onRetryJob,
    onSelectArtifact,
    resolveArtifactUri,
    retryPendingKeys,
    retrySlot,
    selectedJob,
    selectedJobArtifacts,
    selectedJobSlots,
    selectedSlide,
    showInspector = true,
    slideArtifacts,
  }) => {
    const [viewMode, setViewMode] = useState<CompletedViewMode>('focus');
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [filmstripOpen, setFilmstripOpen] = useState(false);

    const totalSlides = slideArtifacts.length;
    const currentIndex = useMemo(() => {
      if (!selectedSlide) return 0;
      const idx = slideArtifacts.findIndex((s) => s.artifactId === selectedSlide.artifactId);
      return idx >= 0 ? idx : 0;
    }, [selectedSlide, slideArtifacts]);

    const handlePrev = useCallback(() => {
      if (currentIndex > 0) {
        onSelectArtifact(slideArtifacts[currentIndex - 1].artifactId);
      }
    }, [currentIndex, onSelectArtifact, slideArtifacts]);

    const handleNext = useCallback(() => {
      if (currentIndex < totalSlides - 1) {
        onSelectArtifact(slideArtifacts[currentIndex + 1].artifactId);
      }
    }, [currentIndex, onSelectArtifact, slideArtifacts, totalSlides]);

    const handleBentoSelect = useCallback(
      (artifactId: string) => {
        onSelectArtifact(artifactId);
        setViewMode('focus');
      },
      [onSelectArtifact],
    );

    const handleQuickExport = useCallback(() => {
      if (selectedSlide && canExport) {
        onExport(selectedSlide.artifactId, 'pptx');
      }
    }, [canExport, onExport, selectedSlide]);

    const rawJobTitle = selectedJob ? jobTitles[selectedJob.jobId] : undefined;
    const jobTitle = rawJobTitle
      ? rawJobTitle
          .split(/\r?\n/u, 1)[0]
          ?.trim()
          .replace(/^(?:演示文稿主题|主题)[:：]\s*/u, '')
          .slice(0, 48)
      : undefined;
    const presentationStyle =
      typeof selectedSlide?.metadata?.style === 'string' ? selectedSlide.metadata.style : undefined;

    return (
      <div className={styles.workspaceRoot} data-testid="presentation-completed-workspace">
        {/* Top Capsule Floating Bar */}
        <CapsuleHeader
          canExport={canExport}
          creating={creating}
          currentIndex={currentIndex}
          drawerOpen={drawerOpen}
          exported={exported}
          exporting={exporting}
          job={selectedJob}
          jobTitle={jobTitle}
          presentationStyle={presentationStyle}
          slideCount={totalSlides}
          viewMode={viewMode}
          onAiModify={onAiModify}
          onExport={(format) => {
            if (selectedSlide) onExport(selectedSlide.artifactId, format);
          }}
          onQuickExport={handleQuickExport}
          onRetryJob={() => onRetryJob(selectedJob.jobId)}
          onToggleDrawer={() => setDrawerOpen((prev) => !prev)}
          onToggleViewMode={() => setViewMode((prev) => (prev === 'focus' ? 'lightbox' : 'focus'))}
        />

        {/* Main Body Layout: Collapsible Filmstrip + Stage + Architecture Drawer */}
        <div className={styles.mainLayout}>
          {/* Collapsible Slide Filmstrip Dock (defaults collapsed) */}
          <div
            className={styles.filmstripContainer}
            data-open={filmstripOpen ? 'true' : 'false'}
            style={{
              maxWidth: filmstripOpen ? 210 : 38,
              minWidth: filmstripOpen ? 210 : 38,
              width: filmstripOpen ? 210 : 38,
            }}
          >
            <div
              style={{
                alignItems: 'center',
                borderBottom: '1px solid var(--ant-color-border-secondary)',
                display: 'flex',
                justifyContent: filmstripOpen ? 'space-between' : 'center',
                padding: '8px 8px',
              }}
            >
              {filmstripOpen && (
                <Flexbox horizontal align="center" gap={6}>
                  <Icon icon={Layers} size={13} />
                  <span style={{ fontSize: 12, fontWeight: 600 }}>缩略胶卷</span>
                </Flexbox>
              )}
              <Button
                aria-label={filmstripOpen ? '收起胶卷' : '展开胶卷'}
                icon={<Icon icon={filmstripOpen ? ChevronLeft : ChevronRight} size={13} />}
                size="small"
                type="text"
                onClick={() => setFilmstripOpen((prev) => !prev)}
              />
            </div>

            <div
              style={{
                display: filmstripOpen ? 'block' : 'none',
                flex: 1,
                overflowY: 'auto',
                padding: 8,
              }}
            >
              <SlideNavigator
                hasSelection={Boolean(selectedJob)}
                selectedArtifactId={effectiveSelectedArtifactId}
                slides={slideArtifacts}
                onSelect={onSelectArtifact}
              />
            </div>
          </div>

          {/* Central Stage: Slide Focus Mode vs Panorama Lightbox Grid */}
          {viewMode === 'focus' ? (
            <SlideFocusStage
              currentIndex={currentIndex}
              selectedSlide={selectedSlide}
              totalSlides={totalSlides}
              onNext={handleNext}
              onOpenDrawer={() => setDrawerOpen(true)}
              onPrev={handlePrev}
            />
          ) : (
            <PanoramaGrid
              selectedArtifactId={effectiveSelectedArtifactId}
              slides={slideArtifacts}
              onSelectSlide={handleBentoSelect}
            />
          )}

          {/* Right Architecture & Assets Drawer */}
          <ArchitectureDrawer
            currentIndex={currentIndex}
            dismissSlotError={dismissSlotError}
            exporting={exporting}
            jobId={selectedJob.jobId}
            jobState={selectedJob.state}
            open={drawerOpen}
            resolveArtifactUri={resolveArtifactUri}
            retryPendingKeys={retryPendingKeys}
            retrySlot={retrySlot}
            selectedArtifactId={effectiveSelectedArtifactId}
            selectedJobArtifacts={selectedJobArtifacts}
            selectedJobSlots={selectedJobSlots}
            selectedSlide={selectedSlide}
            showInspector={showInspector}
            onClose={() => setDrawerOpen(false)}
            onExport={onExport}
            onSelectArtifact={onSelectArtifact}
          />
        </div>
      </div>
    );
  },
);

CompletedWorkspace.displayName = 'CompletedWorkspace';

export default CompletedWorkspace;

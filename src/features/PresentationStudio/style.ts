import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  banner: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block-end: 14px;
    margin-block-end: 14px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 768px) {
      flex-wrap: wrap;
    }
  `,
  bannerMeta: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  canvasBox: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;

    min-height: 380px;
    padding: 24px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorFillQuaternary};
    box-shadow: inset 0 1px 4px rgba(0, 0, 0, 0.05);

    @media (width <= 768px) {
      min-height: 240px;
      padding: 12px;
    }
  `,
  canvasWorkspace: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;

    min-width: 0;
    min-height: 0;
    height: 100%;
  `,
  columnLeft: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
    min-height: 0;
  `,
  columnMain: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 16px;

    min-width: 0;
    min-height: 0;
  `,
  columnRight: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
    min-height: 0;

    @media (width <= 1200px) {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      align-items: start;
    }
  `,
  demoBadge: css`
    display: inline-flex;
    gap: 6px;
    align-items: center;
  `,
  completedGrid: css`
    display: flex;
    gap: 16px;
    align-items: stretch;

    width: 100%;
    flex: 1;
    min-height: 0;
    height: 100%;
    overflow: hidden;

    @media (width <= 768px) {
      flex-direction: column;
    }
  `,
  completedMain: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: stretch;
    justify-content: center;

    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  `,
  editorContainer: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 14px;

    width: 100%;
    min-height: 0;
    height: 100%;
  `,
  editorGrid: css`
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr) 320px;
    gap: 16px;
    align-items: stretch;

    width: 100%;
    flex: 1;
    min-height: 0;

    @media (width <= 1200px) {
      grid-template-columns: 200px minmax(0, 1fr);
    }

    @media (width <= 768px) {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
  `,
  editorToolbar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding: 10px 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgContainer};
  `,
  editorToolbarActions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  editorToolbarTitle: css`
    display: flex;
    gap: 10px;
    align-items: center;
  `,
  generationCard: css`
    position: relative;
    position: absolute;
    top: 50%;
    left: 50%;

    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;

    width: clamp(640px, 64vw, 980px);
    aspect-ratio: 16 / 9;
    padding: 18px 20px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 22px;

    color: ${cssVar.colorTextDescription};
    background: linear-gradient(145deg, ${cssVar.colorFillSecondary}, ${cssVar.colorBgContainer});
    box-shadow: 0 30px 80px rgb(0 0 0 / 22%);
    opacity: var(--presentation-card-opacity, 0);
    cursor: pointer;
    transform: translate3d(calc(-50% + var(--presentation-card-x, 0%)), -50%, 0)
      scale(var(--presentation-card-scale, 1));
    transform-origin: center;

    transition:
      transform 680ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 460ms ease,
      box-shadow 280ms ease,
      border-color 280ms ease;
    will-change: transform, opacity;

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }

    &:hover {
      border-color: ${cssVar.colorBorder};
      box-shadow: 0 34px 96px rgb(0 0 0 / 28%);

      img {
        transform: scale(1.025);
      }

      [data-testid^='card-hover-preview-'] {
        opacity: 1;
      }
    }

    @media (width <= 768px) {
      width: min(82vw, 560px);
      padding: 14px;
      border-radius: 16px;
    }
  `,
  generationCardActive: css`
    opacity: 1;
  `,
  generationCardGenerating: css`
    border-color: rgb(255 255 255 / 44%);

    &::after {
      content: '';
      position: absolute;
      z-index: 4;
      inset: 0;
      padding: 1.5px;
      border-radius: inherit;
      background: linear-gradient(
        110deg,
        transparent 12%,
        rgb(255 255 255 / 10%) 35%,
        rgb(255 255 255 / 92%) 50%,
        rgb(255 255 255 / 12%) 65%,
        transparent 88%
      );
      background-size: 260% 100%;
      mask:
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
      mask-composite: exclude;
      pointer-events: none;
      animation: presentation-card-light-flow 2.8s linear infinite;
    }

    @keyframes presentation-card-light-flow {
      0% {
        background-position: 180% 0;
      }
      100% {
        background-position: -180% 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      &::after {
        animation: none !important;
        background: rgb(255 255 255 / 38%);
      }
    }
  `,
  generationCardAdjacent: css`
    filter: saturate(0.72) brightness(0.74);

    &:hover {
      filter: saturate(0.9) brightness(0.9);
    }
  `,
  generationCardWaiting: css`
    background: linear-gradient(145deg, ${cssVar.colorFillQuaternary}, ${cssVar.colorBgContainer});
  `,
  generationCardPreview: css`
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: ${cssVar.colorBgContainer};
    transition: transform 360ms cubic-bezier(0.16, 1, 0.3, 1);
  `,
  generationCardOverlay: css`
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    background: rgba(0, 0, 0, 0.72);
    color: #fff;
    opacity: 0;
    transition: opacity 200ms ease;
    backdrop-filter: blur(4px);
    text-align: center;
    font-size: 13px;
    pointer-events: none;
  `,
  generationCardChrome: css`
    position: absolute;
    inset: 8% 7% auto;
    height: 54%;
    border-radius: 14px;
    background: linear-gradient(120deg, ${cssVar.colorFillSecondary}, ${cssVar.colorFill});
  `,
  generationCardLine: css`
    width: 72%;
    height: 8px;
    margin-block-end: 8px;
    border-radius: 4px;
    background: ${cssVar.colorFillSecondary};
  `,
  generationCardLineShort: css`
    width: 46%;
    height: 6px;
    margin-block-end: 12px;
    border-radius: 3px;
    background: ${cssVar.colorFillTertiary};
  `,
  generationCards: css`
    position: relative;
    flex: 1;
    width: 100%;
    min-width: 0;
    height: min(70vh, 760px);
    min-height: 420px;

    @media (width <= 768px) {
      min-height: 280px;
    }
  `,
  generationCardSkeleton: css`
    position: absolute;
    inset: 0;
    overflow: hidden;

    &::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(
        100deg,
        transparent 22%,
        rgb(255 255 255 / 7%) 44%,
        rgb(255 255 255 / 16%) 50%,
        transparent 72%
      );
      transform: translate3d(-120%, 0, 0);
      animation: presentation-card-shimmer 2.4s ease-in-out infinite;
    }

    @keyframes presentation-card-shimmer {
      55%,
      100% {
        transform: translate3d(120%, 0, 0);
      }
    }
  `,
  generationCenter: css`
    position: relative;
    z-index: 1;

    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    width: min(100%, 720px);
    padding-block-end: clamp(10px, 2vh, 24px);
    text-align: center;

    h2 {
      margin: 0;
      font-size: clamp(21px, 2.4vw, 28px);
      font-weight: 650;
      color: ${cssVar.colorText};
    }
  `,
  generationGlow: css`
    position: absolute;
    top: 42%;
    left: 50%;
    width: min(70vw, 960px);
    height: min(48vh, 540px);
    border-radius: 50%;
    background: ${cssVar.colorPrimaryBg};
    filter: blur(110px);
    opacity: 0.46;
    pointer-events: none;
    transform: translate3d(-50%, -50%, 0);
  `,
  generationHeader: css`
    position: relative;
    z-index: 1;

    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: center;
  `,
  generationAction: css`
    min-height: 22px;
    font-size: 13px;
    font-weight: 400;
    line-height: 1.5;
    color: ${cssVar.colorTextSecondary};
  `,
  generationCancel: css`
    margin-block-start: 5px;
    color: ${cssVar.colorTextDescription};
    opacity: 0.62;

    &:hover {
      opacity: 1;
    }
  `,
  generationMeta: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  generationWaiting: css`
    font-size: 12px;
    color: ${cssVar.colorWarningText};
  `,
  generationHint: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  generationTitle: css`
    max-width: min(560px, 88vw);
    overflow: hidden;
    font-size: 14px;
    font-weight: 500;
    color: ${cssVar.colorTextDescription};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  generationIcon: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 42px;
    height: 42px;
    border-radius: 50%;
    color: ${cssVar.colorPrimary};
    background: ${cssVar.colorPrimaryBg};
    animation: presentation-generation-pulse 2.4s ease-in-out infinite;

    @keyframes presentation-generation-pulse {
      0%,
      100% {
        box-shadow: 0 0 0 0 ${cssVar.colorPrimaryBg};
      }
      50% {
        box-shadow: 0 0 0 10px transparent;
      }
    }
  `,
  generationProgress: css`
    width: min(380px, 84vw);
  `,
  generationRail: css`
    position: relative;
    z-index: 1;

    display: flex;
    flex: 1;
    gap: 12px;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 0;
    overflow: hidden;
    contain: layout style paint;
  `,
  generationRailButton: css`
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 50%;
    color: ${cssVar.colorTextSecondary};
    background: ${cssVar.colorFillQuaternary};
    cursor: pointer;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }

    @media (width <= 768px) {
      display: none;
    }
  `,
  generationWorkspace: css`
    position: relative;

    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0;
    align-items: center;
    justify-content: center;

    width: 100%;
    max-width: none;
    min-height: 0;
    height: 100%;
    margin-inline: auto;
    padding: 10px 16px;
    overflow: hidden;
    border-radius: 20px;
    background: ${cssVar.colorBgContainer};

    @media (width <= 768px) {
      min-height: 0;
      height: 100%;
      padding: 10px 8px;
      border-radius: 14px;
    }

    @media (prefers-reduced-motion: reduce) {
      &,
      & * {
        animation: none !important;
        transition: none !important;
      }
    }
  `,
  emptyArea: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;

    width: 100%;
    max-width: 860px;
    height: 100%;
    min-height: 0;
    margin-inline: auto;
    padding: 0;
    box-sizing: border-box;

    @media (width <= 768px) {
      max-width: 100%;
    }
  `,
  emptyShell: css`
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;

    width: 100%;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
  `,
  emptyDescription: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    font-size: 13px;
    line-height: 1.6;
    color: ${cssVar.colorTextDescription};
  `,
  emptyTitle: css`
    font-size: 15px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  errorBox: css`
    margin-block-end: 12px;
  `,
  exportNotice: css`
    margin-block-end: 12px;
  `,
  grid: css`
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr) 320px;
    gap: 16px;
    align-items: stretch;

    width: 100%;
    flex: 1;
    min-height: 0;

    overflow-y: auto;
    scrollbar-gutter: stable;

    @media (width <= 1200px) {
      grid-template-columns: 280px minmax(0, 1fr);
    }

    @media (width <= 768px) {
      display: flex;
      flex-direction: column;
      min-height: 0;

      overflow-y: visible;
    }
  `,
  header: css`
    display: flex;
    align-items: center;
  `,
  subtitle: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  srOnly: css`
    position: absolute;

    overflow: hidden;
    width: 1px;
    height: 1px;
    padding: 0;
    border: 0;
    margin: -1px;

    white-space: nowrap;
    clip: rect(0, 0, 0, 0);
  `,
  title: css`
    margin: 0;
    font-size: 18px;
    font-weight: 700;
  `,
  // Studio shell: responsive grid — three panes on desktop, stacked on mobile.
  studio: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;

    width: 100%;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;

    padding: 16px 24px;

    background: ${cssVar.colorBgLayout};

    @media (width <= 1200px) {
      padding: 14px 16px;
    }

    @media (width <= 768px) {
      overflow-x: hidden;
      overflow-y: hidden;

      height: 100%;
      min-height: 0;

      padding: 8px 12px;
    }

    @media (width <= 480px) {
      padding: 6px 8px;
    }

    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        transition-duration: 0.001ms !important;
        animation-duration: 0.001ms !important;
      }
    }
  `,
}));

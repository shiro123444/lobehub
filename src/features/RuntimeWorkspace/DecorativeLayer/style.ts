import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  accentGlow: css`
    pointer-events: none;

    position: absolute;
    inset-block-start: -100px;
    inset-inline-end: -100px;

    width: 300px;
    height: 300px;
    border-radius: 50%;

    background: radial-gradient(
      circle,
      color-mix(in srgb, ${cssVar.colorPrimary} 12%, transparent) 0%,
      transparent 70%
    );
    filter: blur(40px);

    transition: opacity 0.3s ease;

    @media (prefers-reduced-motion: reduce) {
      opacity: 0.05;
      filter: none;
      transition: none !important;
      animation: none !important;
    }
  `,
  container: css`
    pointer-events: none;

    position: absolute;
    z-index: 0;
    inset: 0;

    overflow: hidden;

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  customAsset: css`
    pointer-events: none;

    position: absolute;
    inset: 0;

    width: 100%;
    height: 100%;

    opacity: 0.08;
    object-fit: cover;

    @media (prefers-reduced-motion: reduce) {
      opacity: 0.04;
      transition: none !important;
      animation: none !important;
    }
  `,
  gridOverlay: css`
    pointer-events: none;

    position: absolute;
    inset: 0;

    opacity: 0.03;
    background-image:
      linear-gradient(to right, ${cssVar.colorText} 1px, transparent 1px),
      linear-gradient(to bottom, ${cssVar.colorText} 1px, transparent 1px);
    background-size: 24px 24px;

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
}));

import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  empty: css`
    padding-block: 24px;
    padding-inline: 16px;

    font-size: 13px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  header: css`
    padding-block: 12px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    font-size: 12px;
    font-weight: 600;
    color: ${cssVar.colorTextDescription};
    text-transform: uppercase;
    letter-spacing: 0.5px;

    @media (width <= 768px) {
      padding-block: 8px;
      padding-inline: 12px;
    }
  `,
  item: css`
    cursor: pointer;

    padding-block: 10px;
    padding-inline: 14px;
    border: 1px solid transparent;
    border-radius: ${cssVar.borderRadius};

    outline: none;

    transition: background 0.15s ease;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 1px;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  itemActive: css`
    border-color: ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFillSecondary};
  `,
  list: css`
    overflow-y: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;

    padding: 8px;

    @media (width <= 768px) {
      max-height: 120px;
      padding: 4px;
    }
  `,
  runId: css`
    font-family: monospace;
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  sidebar: css`
    position: relative;
    z-index: 1;

    display: flex;
    flex-direction: column;

    width: 260px;
    min-width: 240px;
    max-width: 320px;
    height: 100%;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgContainer};

    transition:
      width 0.2s cubic-bezier(0.4, 0, 0.2, 1),
      transform 0.2s cubic-bezier(0.4, 0, 0.2, 1),
      opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }

    @media (width <= 768px) {
      width: 100%;
      min-width: 0;
      max-width: 100%;
      height: auto;
      border-block-end: 1px solid ${cssVar.colorBorderSecondary};
      border-inline-end: none;
    }
  `,
  sidebarCollapsed: css`
    width: 52px !important;
    min-width: 52px !important;
    max-width: 52px !important;

    @media (width <= 768px) {
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100% !important;
      height: 52px !important;
    }
  `,
  collapsedBar: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding-block: 8px;
    opacity: 1;
    transform: scale(1);
    transition:
      opacity 0.2s ease,
      transform 0.2s ease;

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  collapseButton: css`
    cursor: pointer;

    display: flex;
    align-items: center;
    justify-content: center;

    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: ${cssVar.borderRadiusSM};

    background: transparent;
    color: ${cssVar.colorTextDescription};

    outline: none;

    transition:
      background 0.15s ease,
      color 0.15s ease;

    &:hover {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 1px;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  expandButton: css`
    cursor: pointer;

    display: flex;
    align-items: center;
    justify-content: center;

    width: 44px;
    height: 44px;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorTextDescription};

    outline: none;

    transition:
      opacity 0.2s ease,
      transform 0.2s ease,
      background 0.15s ease,
      color 0.15s ease;

    &:hover {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 1px;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  expandedContent: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
    opacity: 1;
    transform: translateX(0);
    transition:
      opacity 0.2s ease,
      transform 0.2s ease;

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  time: css`
    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
}));

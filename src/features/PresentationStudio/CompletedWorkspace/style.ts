import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  bentoCard: css`
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: ${cssVar.colorBgContainer};
    cursor: pointer;

    transition:
      transform 200ms ease,
      box-shadow 200ms ease,
      border-color 200ms ease;

    &:hover {
      border-color: ${cssVar.colorBorder};
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
      transform: translateY(-2px);
    }
  `,
  bentoCardSelected: css`
    border-color: ${cssVar.colorPrimary} !important;
    box-shadow:
      0 0 0 2px ${cssVar.colorPrimaryBg},
      0 8px 24px rgba(0, 0, 0, 0.12) !important;
  `,
  bentoFrame: css`
    position: relative;

    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;

    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 8px;

    background: #0d0f12;
  `,
  bentoGrid: css`
    align-content: start;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;

    width: 100%;
    height: 100%;
    padding: 8px 4px 16px;
    overflow-y: auto;

    animation: presentation-fade-in 220ms ease;

    @media (width <= 1200px) {
      grid-template-columns: repeat(3, 1fr);
    }

    @media (width <= 768px) {
      grid-template-columns: repeat(2, 1fr);
    }

    @media (width <= 480px) {
      grid-template-columns: 1fr;
    }
  `,
  bentoImage: css`
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  `,
  bentoMeta: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
  bentoTitle: css`
    overflow: hidden;
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  bottomPaginator: css`
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    align-items: center;
    justify-content: center;

    padding: 6px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 999px;

    background: ${cssVar.colorBgElevated};
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.05);
  `,
  capsuleGroupLeft: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    gap: 10px;
    align-items: center;
    min-width: 0;
  `,
  capsuleGroupRight: css`
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  capsuleHeader: css`
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding: 8px 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 999px;

    background: ${cssVar.colorBgElevated};
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05);

    @media (width <= 768px) {
      flex-direction: column;
      align-items: stretch;
      border-radius: ${cssVar.borderRadius};
    }
  `,
  capsuleTitle: css`
    overflow: hidden;
    max-width: 260px;
    font-size: 14px;
    font-weight: 600;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  drawerBody: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 18px;

    padding: 16px;
    overflow-y: auto;
  `,
  drawerEmptyState: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    justify-content: center;

    padding: 22px 12px;
    border-radius: 8px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    text-align: center;

    background: ${cssVar.colorFillQuaternary};
  `,
  drawerHeader: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    padding: 12px 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  drawerRoot: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;

    height: 100%;
    border-radius: 14px;

    background: ${cssVar.colorBgContainer};
    box-shadow: -4px 0 20px rgba(0, 0, 0, 0.06);

    transition:
      width 260ms cubic-bezier(0.16, 1, 0.3, 1),
      margin-left 260ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 200ms ease;
  `,
  drawerSection: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  drawerSectionContent: css`
    padding: 12px;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.6;
    color: ${cssVar.colorTextSecondary};
    background: ${cssVar.colorFillQuaternary};
  `,
  drawerSectionHeader: css`
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  exportStatusHint: css`
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  filmstripContainer: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex-direction: column;

    height: 100%;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: ${cssVar.colorBgContainer};

    transition:
      width 240ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 200ms ease;
  `,
  focusCanvas: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;

    width: 100%;
    min-height: 0;
    padding: 24px;

    @media (width <= 768px) {
      padding: 10px;
    }
  `,
  focusEmpty: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    justify-content: center;

    padding: 24px;

    font-size: 13px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  focusFrame169: css`
    position: relative;

    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;

    width: 100%;
    max-width: min(100%, calc((100vh - 110px) * (16 / 9)));
    max-height: 100%;
    aspect-ratio: 16 / 9;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;

    background: #0d0f12;
    box-shadow:
      0 24px 64px -12px rgba(0, 0, 0, 0.56),
      0 0 0 1px rgba(255, 255, 255, 0.04);
    cursor: pointer;

    transition:
      transform 200ms ease,
      box-shadow 200ms ease,
      border-color 200ms ease;

    &:hover {
      border-color: rgba(255, 255, 255, 0.24);
      box-shadow:
        0 28px 72px -10px rgba(0, 0, 0, 0.65),
        0 0 0 1px rgba(255, 255, 255, 0.08);

      [data-role='hover-cue'] {
        opacity: 1;
      }
    }
  `,
  focusImage: css`
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  `,
  hoverCue: css`
    position: absolute;
    inset-block-end: 14px;
    inset-inline-end: 16px;

    display: flex;
    gap: 6px;
    align-items: center;

    padding: 4px 10px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 999px;

    font-size: 11px;
    color: #fff;

    background: rgba(0, 0, 0, 0.68);
    backdrop-filter: blur(8px);
    opacity: 0;
    pointer-events: none;

    transition: opacity 180ms ease;
  `,
  mainLayout: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    gap: 12px;

    width: 100%;
    min-height: 0;
  `,
  pageCounter: css`
    min-width: 64px;
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorText};
    text-align: center;
  `,
  stageArea: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 10px;
    align-items: center;
    justify-content: center;

    min-width: 0;
    height: 100%;

    transition: width 240ms cubic-bezier(0.16, 1, 0.3, 1);
  `,
  workspaceRoot: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;

    width: 100%;
    height: 100%;
    min-height: 0;

    @keyframes presentation-fade-in {
      from {
        opacity: 0;
        transform: translateY(4px);
      }

      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `,
}));

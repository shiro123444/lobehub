import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  interactiveCardGroup: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
    width: 100%;
    margin-block-start: 6px;
  `,
  optionCard: css`
    cursor: pointer;

    display: flex;
    flex-direction: column;
    gap: 4px;

    padding: 12px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;

    background: ${cssVar.colorBgElevated};

    transition: all 0.2s ease-in-out;

    &:hover {
      border-color: ${cssVar.colorPrimary};
      background: ${cssVar.colorFillQuaternary};
      transform: translateY(-1px);
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
  `,
  optionCardActive: css`
    border-color: ${cssVar.colorPrimary} !important;
    background: ${cssVar.colorFillAlter} !important;
    box-shadow: 0 0 0 1px ${cssVar.colorPrimary};
  `,
  optionCardDesc: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  optionCardTitle: css`
    font-size: 14px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  outlineCard: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px 20px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: ${cssVar.colorBgContainer};
  `,
  outlineHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 8px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
  `,
  outlineIndex: css`
    font-size: 12px;
    font-weight: 700;
    color: ${cssVar.colorPrimary};
    background: ${cssVar.colorFillTertiary};
    padding: 2px 6px;
    border-radius: 4px;
  `,
  outlineItem: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
  `,
  outlineList: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  outlineOverview: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorFillQuaternary};
  `,
  outlineOverviewItem: css`
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 2px 8px;
    align-items: center;
    padding: 9px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    color: ${cssVar.colorText};
    text-align: start;
    background: ${cssVar.colorBgContainer};
    cursor: pointer;
    &:hover {
      border-color: ${cssVar.colorPrimary};
    }
  `,
  outlineOverviewIndex: css`
    grid-row: span 2;
    font-size: 12px;
    font-weight: 700;
    color: ${cssVar.colorPrimary};
  `,
  outlineOverviewTitle: css`
    overflow: hidden;
    font-size: 12px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  outlineOverviewMeta: css`
    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
  outlinePointItem: css`
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  `,
  outlineSlideCard: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px 18px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
    transition: all 0.2s ease-in-out;

    &:hover {
      border-color: ${cssVar.colorPrimaryBorder};
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.04);
    }
  `,
  outlineSlideCardBody: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-left: 36px;

    @media (max-width: 768px) {
      padding-left: 0;
    }
  `,
  outlineSlideCardHeader: css`
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    flex-wrap: wrap;
  `,
  outlineTitle: css`
    font-size: 13px;
    color: ${cssVar.colorText};
  `,
  outlineWorkspace: css`
    display: flex;
    flex-direction: column;
    gap: 20px;
    width: 100%;
    max-width: 1080px;
    margin: 0 auto;
    padding: 24px 20px 48px;
    box-sizing: border-box;
  `,
  outlineWorkspaceFooter: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 16px;
    border-top: 1px solid ${cssVar.colorBorderSecondary};
    flex-wrap: wrap;
    gap: 12px;
  `,
  outlineWorkspaceHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 16px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    flex-wrap: wrap;
    gap: 12px;
  `,
  summaryCard: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px 20px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: ${cssVar.colorFillQuaternary};
  `,
  summaryItem: css`
    display: flex;
    gap: 12px;
    align-items: center;
    font-size: 13px;
  `,
  summaryLabel: css`
    flex-shrink: 0;
    width: 76px;
    color: ${cssVar.colorTextSecondary};
  `,
  summaryValue: css`
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  thinkingBubble: css`
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 10px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 14px 14px 14px 4px;
    color: ${cssVar.colorTextSecondary};
    background: ${cssVar.colorFillQuaternary};
  `,
  thinkingDot: css`
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
    animation: presentation-thinking 1.1s infinite ease-in-out;

    &:nth-child(2) {
      animation-delay: 0.15s;
    }
    &:nth-child(3) {
      animation-delay: 0.3s;
    }

    @keyframes presentation-thinking {
      0%,
      60%,
      100% {
        opacity: 0.25;
        transform: translateY(0);
      }
      30% {
        opacity: 1;
        transform: translateY(-3px);
      }
    }
  `,
  realtimeTranscript: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: min(100%, 760px);
    margin: 0 auto;
    padding: 24px 20px;
  `,
  realtimeMessage: css`
    max-width: 86%;
    padding: 11px 14px;
    border-radius: 14px;
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
  `,
  realtimeMessageAgent: css`
    align-self: flex-start;
    border: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgContainer};
  `,
  realtimeMessageUser: css`
    align-self: flex-end;
    color: ${cssVar.colorTextLightSolid};
    background: ${cssVar.colorPrimary};
  `,
}));

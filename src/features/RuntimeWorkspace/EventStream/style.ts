import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    position: relative;
    z-index: 1;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;

    min-width: 0;
    height: 100%;

    background: ${cssVar.colorBgLayout};
  `,
  emptyState: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;

    padding: 32px;

    color: ${cssVar.colorTextDescription};
    text-align: center;

    @media (width <= 480px) {
      padding: 16px;
    }
  `,
  errorBox: css`
    margin: 16px;

    @media (width <= 480px) {
      margin: 8px;
    }
  `,
  eventContent: css`
    overflow-x: auto;

    padding-block: 8px;
    padding-inline: 10px;
    border-radius: ${cssVar.borderRadiusSM};

    font-family: monospace;
    font-size: 12px;
    color: ${cssVar.colorText};
    word-break: break-all;
    white-space: pre-wrap;

    background: ${cssVar.colorFillTertiary};
  `,
  eventHeader: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    justify-content: space-between;

    margin-block-end: 6px;
  `,
  eventItem: css`
    padding-block: 10px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgContainer};
  `,
  eventsList: css`
    overflow-y: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;

    padding: 16px;

    @media (width <= 480px) {
      padding: 8px;
    }
  `,
  eventTitle: css`
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  metaCard: css`
    margin-block: 16px 0;
    margin-inline: 16px;
    padding-block: 14px;
    padding-inline: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgContainer};

    @media (width <= 480px) {
      margin-block: 8px 0;
      margin-inline: 8px;
      padding-block: 10px;
      padding-inline: 12px;
    }
  `,
  seqBadge: css`
    padding-block: 2px;
    padding-inline: 6px;
    border-radius: 4px;

    font-family: monospace;
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillQuaternary};
  `,
}));

import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex-direction: column;

    width: 100%;
    min-height: 80px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgContainer};
  `,
  content: css`
    overflow: auto;
    flex: 1;
    padding: 12px;
  `,
  disabledState: css`
    display: flex;
    align-items: center;
    justify-content: center;

    padding-block: 20px;
    padding-inline: 16px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    text-align: center;

    background: ${cssVar.colorFillQuaternary};
  `,
  emptyState: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;

    padding-block: 24px;
    padding-inline: 16px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  errorFallback: css`
    padding: 12px;
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;

    padding-block: 8px;
    padding-inline: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    font-size: 12px;
    font-weight: 500;

    background: ${cssVar.colorFillTertiary};
  `,
  slotId: css`
    font-family: monospace;
    color: ${cssVar.colorText};
  `,
}));

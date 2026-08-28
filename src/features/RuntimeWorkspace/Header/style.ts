import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  header: css`
    position: relative;
    z-index: 1;

    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    padding-block: 12px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgContainer};

    @media (width <= 480px) {
      padding-block: 8px;
      padding-inline: 12px;
    }
  `,
  meta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  runId: css`
    font-family: monospace;
    font-size: 13px;
    color: ${cssVar.colorTextDescription};
  `,
  title: css`
    font-size: 15px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
}));

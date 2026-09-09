import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;

    margin-block-start: 4px;
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 768px) {
      justify-content: stretch;

      & > button {
        flex: 1;
      }
    }
  `,
  container: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgContainer};

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  errorBox: css`
    margin-block-end: 4px;
  `,
  header: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  `,
  jobId: css`
    font-family: monospace;
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  statusLine: css`
    display: flex;
    align-items: center;
    min-height: 24px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  title: css`
    font-size: 14px;
    font-weight: 600;
  `,
}));

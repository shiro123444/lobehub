import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  actions: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;

    margin-block-start: 8px;
  `,
  container: css`
    position: relative;
    z-index: 1;

    padding: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgContainer};
  `,
  errorBox: css`
    margin-block-end: 12px;
  `,
  field: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
  `,
  label: css`
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextDescription};
  `,
  row: css`
    display: flex;
    gap: 12px;
    margin-block-end: 10px;

    @media (width <= 600px) {
      flex-direction: column;
    }
  `,
}));

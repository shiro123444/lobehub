import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  actions: css`
    display: flex;
    justify-content: flex-end;
    margin-block-start: 4px;
  `,
  compactField: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
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
  field: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
  `,
  hint: css`
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: ${cssVar.colorTextDescription};
  `,
  label: css`
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextDescription};
  `,
  title: css`
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  `,
}));

import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: 10px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgContainer};

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  empty: css`
    padding-block: 16px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  metaList: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    margin: 0;
  `,
  metaRow: css`
    display: flex;
    gap: 12px;
    align-items: baseline;
    justify-content: space-between;

    font-size: 12px;

    & dt {
      color: ${cssVar.colorTextDescription};
    }

    & dd {
      overflow-wrap: anywhere;
      margin: 0;
      text-align: end;
    }
  `,
  phaseNote: css`
    margin: 0;
    padding-block-start: 8px;
    border-block-start: 1px dashed ${cssVar.colorBorderSecondary};

    font-size: 11px;
    font-style: italic;
    color: ${cssVar.colorTextDescription};
  `,
  title: css`
    font-size: 13px;
    font-weight: 600;
  `,
}));

import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  actions: css`
    display: flex;
    justify-content: flex-end;
  `,
  container: css`
    display: flex;
    flex-direction: column;
    gap: 10px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgContainer};
    opacity: 0.8;

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  phaseTag: css`
    padding: 1px 6px;
    border-radius: 999px;

    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;

    color: ${cssVar.colorTextDescription};
    background: ${cssVar.colorFillTertiary};
  `,
  title: css`
    font-size: 13px;
    font-weight: 600;
  `,
}));

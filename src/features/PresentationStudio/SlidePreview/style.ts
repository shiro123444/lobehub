import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  caption: css`
    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
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
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
    justify-content: center;

    padding: 24px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  frame: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;

    min-height: 180px;
    border-radius: ${cssVar.borderRadiusSM};

    background: repeating-conic-gradient(${cssVar.colorFillSecondary} 0% 25%, transparent 0% 50%)
      50% / 16px 16px;
  `,
  image: css`
    display: block;
    width: 100%;
    height: auto;
    max-height: 100%;
    object-fit: contain;
  `,
  meta: css`
    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
  title: css`
    font-size: 13px;
    font-weight: 600;
  `,
}));

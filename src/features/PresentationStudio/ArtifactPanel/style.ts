import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    cursor: pointer;

    display: flex;
    flex-direction: column;
    gap: 6px;

    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusSM};

    background: ${cssVar.colorFillTertiary};
    outline: none;

    transition:
      border-color 0.15s ease,
      background 0.15s ease,
      box-shadow 0.15s ease,
      opacity 0.15s ease;

    &:hover {
      border-color: ${cssVar.colorBorder};
      background: ${cssVar.colorFillSecondary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 1px;
    }

    &[data-selected='true'] {
      border-color: ${cssVar.colorPrimary};
      background: ${cssVar.colorFillSecondary};
      box-shadow: 0 0 0 1px ${cssVar.colorPrimary};
    }

    &[data-ready='false'] {
      cursor: not-allowed;
      opacity: 0.55;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  cardHeader: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
  cardMeta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 10px;

    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
  cardName: css`
    font-size: 13px;
    font-weight: 500;
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
    padding-block: 20px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  header: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  `,
  hint: css`
    margin: 0;

    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  title: css`
    font-size: 13px;
    font-weight: 600;
  `,
}));

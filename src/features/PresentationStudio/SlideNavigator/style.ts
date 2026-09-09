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
    padding-block: 24px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px;

    outline: none;

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 4px;
    }

    @media (width <= 768px) {
      display: flex;
      gap: 10px;
      overflow-x: auto;

      padding-block-end: 4px;

      scroll-snap-type: x proximity;

      & > * {
        min-width: 110px;
        scroll-snap-align: start;
      }
    }
  `,
  thumb: css`
    cursor: pointer;

    display: flex;
    flex-direction: column;
    gap: 6px;

    padding: 6px;
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
  thumbFallback: css`
    display: flex;
    align-items: center;
    justify-content: center;

    aspect-ratio: 16 / 9;

    font-size: 10px;
    color: ${cssVar.colorTextDescription};
    background: ${cssVar.colorFill};
  `,
  thumbFrame: css`
    overflow: hidden;
    aspect-ratio: 16 / 9;
    border-radius: ${cssVar.borderRadiusXS};

    background: ${cssVar.colorBgLayout};
  `,
  thumbImage: css`
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  `,
  thumbMeta: css`
    display: flex;
    gap: 6px;
    align-items: center;
    justify-content: space-between;

    padding-inline: 2px;
    padding-block-end: 2px;

    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
  thumbStatus: css`
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;

    color: ${cssVar.colorTextDescription};
  `,
  title: css`
    font-size: 13px;
    font-weight: 600;
  `,
}));

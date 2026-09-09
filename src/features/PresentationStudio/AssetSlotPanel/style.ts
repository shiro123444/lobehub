import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;

    @media (width <= 768px) {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 8px;
    }
  `,
  hint: css`
    margin: 0;
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  slot: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusSM};

    background: ${cssVar.colorBgContainer};

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
  `,
  slotError: css`
    border-color: ${cssVar.colorError};
  `,
  slotMeta: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
  `,
  slotName: css`
    overflow: hidden;

    font-size: 12px;
    font-weight: 600;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  thumbnail: css`
    display: flex;
    align-items: center;
    justify-content: center;

    aspect-ratio: 16 / 9;
    overflow: hidden;

    border-radius: ${cssVar.borderRadiusSM};

    background: ${cssVar.colorFillQuaternary};

    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  `,
  // Interactive surfaces honour prefers-reduced-motion (C-58 contract).
  thumbnailReady: css`
    transition: opacity 0.2s ${cssVar.motionEaseInOut};

    @media (prefers-reduced-motion: reduce) {
      transition-duration: 0.001ms !important;
    }
  `,
}));

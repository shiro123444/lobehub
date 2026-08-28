import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  empty: css`
    padding-block: 24px;
    padding-inline: 16px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  header: css`
    padding-block: 12px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    font-size: 12px;
    font-weight: 600;
    color: ${cssVar.colorTextDescription};
    text-transform: uppercase;
    letter-spacing: 0.5px;

    @media (width <= 768px) {
      padding-block: 8px;
      padding-inline: 12px;
    }
  `,
  list: css`
    overflow-y: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;

    padding: 8px;

    @media (width <= 768px) {
      max-height: 120px;
      padding: 4px;
    }
  `,
  panel: css`
    position: relative;
    z-index: 1;

    display: flex;
    flex-direction: column;

    width: 260px;
    min-width: 240px;
    max-width: 320px;
    height: 100%;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgContainer};

    @media (width <= 1024px) {
      width: 220px;
      min-width: 200px;
    }

    @media (width <= 768px) {
      width: 100%;
      min-width: 0;
      max-width: 100%;
      height: auto;
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
      border-inline-start: none;
    }
  `,
  pluginId: css`
    font-family: monospace;
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  pluginItem: css`
    display: flex;
    align-items: center;
    justify-content: space-between;

    padding-block: 8px;
    padding-inline: 12px;
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorFillTertiary};
  `,
}));

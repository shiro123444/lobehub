import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  body: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;

    height: 100%;
    min-height: 0;

    @media (width <= 768px) {
      overflow-y: auto;
      flex-direction: column;
    }
  `,
  mainContent: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;

    min-width: 0;
    height: 100%;

    @media (width <= 768px) {
      min-height: 320px;
    }
  `,
  workspace: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex-direction: column;

    width: 100%;
    max-width: 100vw;
    height: 100%;
    min-height: 0;

    background: ${cssVar.colorBgLayout};

    @media (prefers-reduced-motion: reduce) {
      * {
        transition-duration: 0.001ms !important;
        animation-duration: 0.001ms !important;
      }
    }
  `,
}));

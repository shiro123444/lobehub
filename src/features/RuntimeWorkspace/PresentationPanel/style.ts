import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  actionRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;

    margin-block-start: 16px;
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 768px) {
      justify-content: stretch;

      & > button {
        flex: 1;
      }
    }
  `,
  artifactCard: css`
    cursor: pointer;

    display: flex;
    flex-direction: column;
    gap: 6px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusSM};

    background: ${cssVar.colorFillTertiary};
    outline: none;

    transition:
      border-color 0.15s ease,
      background 0.15s ease,
      box-shadow 0.15s ease;

    &:hover {
      border-color: ${cssVar.colorBorder};
      background: ${cssVar.colorFillSecondary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 1px;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  artifactCardSelected: css`
    border-color: ${cssVar.colorPrimary};
    background: ${cssVar.colorFillSecondary};
    box-shadow: 0 0 0 1px ${cssVar.colorPrimary};
  `,
  artifactHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;

    font-size: 13px;
    font-weight: 500;
  `,
  artifactMeta: css`
    display: flex;
    gap: 12px;
    align-items: center;

    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
  artifactsGroup: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-block-start: 12px;
  `,
  container: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex-direction: column;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgContainer};

    @media (width <= 768px) {
      padding: 12px;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  emptyState: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;

    padding-block: 32px;
    padding-inline: 16px;

    font-size: 13px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  errorBox: css`
    margin-block-start: 12px;
  `,
  header: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block-end: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  jobId: css`
    font-family: monospace;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  metaRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: center;

    margin-block-start: 8px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  title: css`
    font-size: 14px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
}));

import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  workspace: css`
    width: 100%;
    padding-block: 16px 40px;
    padding-inline: clamp(16px, 3vw, 48px);
  `,
  header: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    margin-block-end: 28px;
  `,
  count: css`
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
    gap: clamp(16px, 2vw, 28px);
    align-items: start;
  `,
  rail: css`
    scroll-snap-type: x mandatory;

    overflow-x: auto;
    display: grid;
    grid-auto-columns: min(72vw, 480px);
    grid-auto-flow: column;
    gap: 28px;

    padding-block: 12px 28px;
    padding-inline: 4px;
  `,
  card: css`
    cursor: pointer;
    scroll-snap-align: center;

    position: relative;

    display: flex;
    flex-direction: column;
    gap: 14px;
    align-items: flex-start;
    justify-content: center;

    aspect-ratio: 16 / 9;
    width: 100%;
    min-height: 200px;
    padding-block: 36px 24px;
    padding-inline: 28px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 18px;

    color: ${cssVar.colorText};
    text-align: start;

    background: ${cssVar.colorBgContainer};

    transition:
      transform 180ms ease,
      border-color 180ms ease;

    &:hover {
      transform: translateY(-3px);
      border-color: ${cssVar.colorTextQuaternary};
    }

    &[aria-pressed='true'] {
      border-color: ${cssVar.colorPrimary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 4px;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;

      &:hover {
        transform: none;
      }
    }
  `,
  number: css`
    position: absolute;
    inset-block: 16px auto;
    inset-inline: 28px auto;

    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorTextTertiary};
  `,
  title: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;

    font-size: 21px;
    font-weight: 500;
    line-height: 1.45;
    letter-spacing: -0.5px;
  `,
  claim: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;

    font-size: 12px;
    line-height: 1.7;
    color: ${cssVar.colorTextSecondary};
  `,
  details: css`
    display: flex;
    flex-direction: column;
    gap: 24px;

    label,
    summary {
      font-size: 12px;
      color: ${cssVar.colorTextSecondary};
    }

    textarea {
      margin-block-start: 8px;
      color: ${cssVar.colorText};
    }

    summary {
      cursor: pointer;
      margin-block-end: 12px;
    }
  `,
  label: css`
    display: block;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

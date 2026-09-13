import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  banner: css`
    display: flex;
    flex-direction: column;
    gap: 24px;
    align-items: flex-start;

    padding-block: clamp(44px, 7vw, 92px);
    padding-inline: clamp(24px, 5vw, 64px);

    color: ${cssVar.colorText};
  `,
  tag: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    letter-spacing: 0.16em;
  `,
  title: css`
    min-height: 1.5em;
    margin: 0;

    font-size: clamp(26px, 3.4vw, 44px);
    font-weight: 500;
    line-height: 1.5;
    letter-spacing: 0.02em;
  `,
  subtitle: css`
    max-width: 420px;
    margin: 0;

    font-size: 14px;
    line-height: 1.9;
    color: ${cssVar.colorTextSecondary};
  `,
  cursor: css`
    font-weight: 300;
    color: ${cssVar.colorTextTertiary};
    animation: jumi-caret 1s step-end 5;

    @keyframes jumi-caret {
      50% {
        opacity: 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      display: none;
    }
  `,
  publish: css`
    margin-block-start: 12px;
    border-radius: 24px;
  `,
}));

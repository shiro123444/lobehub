import { createStaticStyles, keyframes, responsive } from 'antd-style';

const floatAnimation = keyframes`
  0% { transform: translateY(0px) scale(1); }
  50% { transform: translateY(-10px) scale(1.05); }
  100% { transform: translateY(0px) scale(1); }
`;

const pulseGlow = keyframes`
  0% { opacity: 0.5; }
  50% { opacity: 0.8; }
  100% { opacity: 0.5; }
`;

export const styles = createStaticStyles(({ css, cssVar }) => ({
  banner: css`
    position: relative;
    z-index: 1;

    width: 100%;
    min-height: 220px;
    padding: 32px 40px;
    border-radius: 16px;

    overflow: hidden;

    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 32px;

    transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);

    ${responsive.sm} {
      flex-direction: column;
      align-items: flex-start;
      gap: 24px;
      padding: 24px;
      min-height: auto;
    }
  `,

  bannerLight: css`
    background: linear-gradient(135deg, #fdfbf7 0%, #f6f3eb 100%);
    border: 1px solid rgba(220, 215, 200, 0.4);
    box-shadow: 
      0 2px 8px rgba(120, 110, 90, 0.05),
      0 8px 24px rgba(120, 110, 90, 0.03);
  `,

  bannerDark: css`
    background: linear-gradient(135deg, #0e0f12 0%, #16171b 100%);
    border: 1px solid rgba(255, 255, 255, 0.03);
    box-shadow: 
      0 4px 12px rgba(0, 0, 0, 0.2),
      inset 0 1px 1px rgba(255, 255, 255, 0.02);
  `,

  content: css`
    position: relative;
    z-index: 2;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,

  tag: css`
    align-self: flex-start;
    padding: 4px 12px;
    border-radius: 100px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    
    transition: all 0.3s ease;
  `,

  tagLight: css`
    background: rgba(139, 92, 26, 0.08);
    color: #8b5c1a;
  `,

  tagDark: css`
    background: rgba(224, 175, 104, 0.1);
    color: #e0af68;
  `,

  title: css`
    margin: 0;
    font-size: 32px;
    font-weight: 800;
    line-height: 1.25;
    letter-spacing: -0.02em;

    ${responsive.sm} {
      font-size: 24px;
    }
  `,

  titleLight: css`
    background: linear-gradient(135deg, #2d2a24 0%, #524b3e 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  `,

  titleDark: css`
    background: linear-gradient(135deg, #f6f3eb 0%, #c5bdae 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  `,

  subtitle: css`
    margin: 0;
    font-size: 15px;
    font-weight: 400;
    line-height: 1.6;
    max-width: 580px;

    ${responsive.sm} {
      font-size: 13px;
    }
  `,

  subtitleLight: css`
    color: #615a4e;
  `,

  subtitleDark: css`
    color: #9c978e;
  `,

  actionWrapper: css`
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 8px;

    ${responsive.xs} {
      flex-direction: column;
      align-items: stretch;
      width: 100%;
    }
  `,

  // Glowing background orbs for premium aesthetics
  orbsContainer: css`
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 1;
  `,

  orb1: css`
    position: absolute;
    top: -50px;
    right: 5%;
    width: 250px;
    height: 250px;
    border-radius: 50%;
    filter: blur(80px);
    opacity: 0.15;
    animation: 
      ${floatAnimation} 10s ease-in-out infinite,
      ${pulseGlow} 6s ease-in-out infinite;

    ${responsive.sm} {
      right: -50px;
      width: 180px;
      height: 180px;
      filter: blur(60px);
    }
  `,

  orb1Light: css`
    background: #e0af68;
  `,

  orb1Dark: css`
    background: #e0af68;
    opacity: 0.1;
  `,

  orb2: css`
    position: absolute;
    bottom: -60px;
    right: 25%;
    width: 180px;
    height: 180px;
    border-radius: 50%;
    filter: blur(70px);
    opacity: 0.12;
    animation: 
      ${floatAnimation} 8s ease-in-out infinite alternate,
      ${pulseGlow} 5s ease-in-out infinite alternate;

    ${responsive.sm} {
      display: none;
    }
  `,

  orb2Light: css`
    background: #8b5c1a;
  `,

  orb2Dark: css`
    background: #475877;
    opacity: 0.08;
  `,
}));

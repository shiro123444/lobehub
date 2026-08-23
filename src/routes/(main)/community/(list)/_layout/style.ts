import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  
  // Content container
  contentContainer: css`
    min-height: 100%;
  `,

  // Main container
  mainContainer: css`
    overflow-y: auto;

    // Zen Tech premium card visual style overrides
    [data-testid$="-item"] {
      transition: all 0.35s cubic-bezier(0.25, 0.8, 0.25, 1) !important;
      border: 1px solid color-mix(in srgb, ${cssVar.colorBorder} 40%, transparent) !important;
      border-radius: 12px !important;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.01) !important;
      
      &:hover {
        transform: translateY(-2px);
        box-shadow: 
          0 8px 24px color-mix(in srgb, ${cssVar.colorText} 5%, transparent),
          0 2px 6px color-mix(in srgb, ${cssVar.colorText} 2%, transparent) !important;
        border-color: color-mix(in srgb, ${cssVar.colorPrimary} 35%, transparent) !important;
      }
    }
  `,

  // Placeholder
  spacer: css`
    flex: 1;
  `,
}));

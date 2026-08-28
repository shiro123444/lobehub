export type DecorativeTheme = 'light' | 'dark' | 'auto';

export interface DecorativeAssetItem {
  alt: string;
  ariaHidden?: boolean;
  id: string;
  metadata?: Record<string, unknown>;
  reducedMotionFallback?: string | { alt?: string; src: string };
  src: string;
  theme?: DecorativeTheme;
}

export interface DecorativeAssetManifest {
  assets: Record<string, DecorativeAssetItem>;
  defaultAssetId?: string;
  version: string;
}

export const DEFAULT_DECORATIVE_ASSET: DecorativeAssetItem = {
  alt: 'Runtime Workspace Static Decorative Overlay',
  ariaHidden: true,
  id: 'default-static-overlay',
  src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  theme: 'auto',
};

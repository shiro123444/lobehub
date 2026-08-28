import {
  type DecorativeAssetItem,
  type DecorativeAssetManifest,
  DEFAULT_DECORATIVE_ASSET,
} from './types';
import { validateDecorativeAsset } from './validator';

export interface ResolveAssetOptions {
  assetId?: string;
  prefersReducedMotion?: boolean;
  theme?: 'light' | 'dark';
}

export const resolveDecorativeAsset = (
  assetOrManifest?: DecorativeAssetItem | DecorativeAssetManifest | null,
  options: ResolveAssetOptions = {},
): DecorativeAssetItem => {
  if (!assetOrManifest) {
    return DEFAULT_DECORATIVE_ASSET;
  }

  let selectedAsset: DecorativeAssetItem | undefined;

  // If manifest passed
  if ('assets' in assetOrManifest && typeof assetOrManifest.assets === 'object') {
    const manifest = assetOrManifest as DecorativeAssetManifest;
    const targetId = options.assetId || manifest.defaultAssetId;

    if (targetId && manifest.assets[targetId]) {
      selectedAsset = manifest.assets[targetId];
    } else {
      const keys = Object.keys(manifest.assets);
      selectedAsset = keys.length > 0 ? manifest.assets[keys[0]] : undefined;
    }
  } else if ('src' in assetOrManifest && 'id' in assetOrManifest) {
    selectedAsset = assetOrManifest as DecorativeAssetItem;
  }

  if (!selectedAsset) {
    return DEFAULT_DECORATIVE_ASSET;
  }

  const validation = validateDecorativeAsset(selectedAsset);
  if (!validation.valid) {
    console.warn(
      `[DecorativeLayer] Asset "${selectedAsset.id || 'unknown'}" rejected: ${validation.error}. Using fallback.`,
    );
    return DEFAULT_DECORATIVE_ASSET;
  }

  // Handle prefers-reduced-motion fallback
  if (options.prefersReducedMotion && selectedAsset.reducedMotionFallback) {
    if (typeof selectedAsset.reducedMotionFallback === 'string') {
      return {
        ...selectedAsset,
        src: selectedAsset.reducedMotionFallback,
      };
    }
    if (typeof selectedAsset.reducedMotionFallback === 'object') {
      return {
        ...selectedAsset,
        alt: selectedAsset.reducedMotionFallback.alt ?? selectedAsset.alt,
        src: selectedAsset.reducedMotionFallback.src,
      };
    }
  }

  return selectedAsset;
};

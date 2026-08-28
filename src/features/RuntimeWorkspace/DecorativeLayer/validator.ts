import type { DecorativeAssetItem } from './types';

export interface AssetValidationResult {
  error?: string;
  valid: boolean;
}

const FORBIDDEN_URI_PREFIXES = ['javascript:', 'vbscript:', 'data:text/html'];

export const validateDecorativeAsset = (asset: unknown): AssetValidationResult => {
  if (!asset || typeof asset !== 'object') {
    return { error: 'Asset must be a non-null object', valid: false };
  }

  const item = asset as Partial<DecorativeAssetItem>;

  if (!item.id || typeof item.id !== 'string' || item.id.trim() === '') {
    return { error: 'Asset "id" is required and must be a non-empty string', valid: false };
  }

  if (typeof item.src !== 'string' || item.src.trim() === '') {
    return { error: 'Asset "src" is required and must be a non-empty string', valid: false };
  }

  const trimmedSrc = item.src.trim().toLowerCase();
  for (const prefix of FORBIDDEN_URI_PREFIXES) {
    if (trimmedSrc.startsWith(prefix)) {
      return { error: `Asset "src" uses forbidden unsafe URI scheme: ${prefix}`, valid: false };
    }
  }

  if (typeof item.alt !== 'string') {
    return {
      error:
        'Asset "alt" text is mandatory for accessibility compliance (use empty string "" if purely decorative with aria-hidden)',
      valid: false,
    };
  }

  if (item.theme && !['light', 'dark', 'auto'].includes(item.theme)) {
    return {
      error: `Invalid theme "${item.theme}". Allowed themes are: "light", "dark", "auto"`,
      valid: false,
    };
  }

  if (item.reducedMotionFallback !== undefined) {
    if (typeof item.reducedMotionFallback === 'string') {
      const fallbackSrc = item.reducedMotionFallback.trim().toLowerCase();
      for (const prefix of FORBIDDEN_URI_PREFIXES) {
        if (fallbackSrc.startsWith(prefix)) {
          return {
            error: `reducedMotionFallback uses forbidden unsafe URI scheme: ${prefix}`,
            valid: false,
          };
        }
      }
    } else if (
      typeof item.reducedMotionFallback === 'object' &&
      item.reducedMotionFallback !== null
    ) {
      const fallbackObj = item.reducedMotionFallback;
      if (typeof fallbackObj.src !== 'string' || fallbackObj.src.trim() === '') {
        return {
          error: 'reducedMotionFallback object must contain a non-empty "src" string',
          valid: false,
        };
      }
      const fallbackSrc = fallbackObj.src.trim().toLowerCase();
      for (const prefix of FORBIDDEN_URI_PREFIXES) {
        if (fallbackSrc.startsWith(prefix)) {
          return {
            error: `reducedMotionFallback object uses forbidden unsafe URI scheme: ${prefix}`,
            valid: false,
          };
        }
      }
    } else {
      return {
        error: 'reducedMotionFallback must be a string URI or an object with "src"',
        valid: false,
      };
    }
  }

  return { valid: true };
};

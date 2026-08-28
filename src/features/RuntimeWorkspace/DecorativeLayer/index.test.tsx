import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import DecorativeLayer from './index';
import { resolveDecorativeAsset } from './resolver';
import {
  type DecorativeAssetItem,
  type DecorativeAssetManifest,
  DEFAULT_DECORATIVE_ASSET,
} from './types';
import { validateDecorativeAsset } from './validator';

describe('DecorativeLayer Asset Contract & Accessibility Validation', () => {
  it('validateDecorativeAsset accepts compliant asset item', () => {
    const validAsset: DecorativeAssetItem = {
      alt: 'Zen garden decorative pattern',
      ariaHidden: true,
      id: 'zen-pattern-1',
      src: '/assets/decor/zen-pattern.svg',
      theme: 'light',
    };

    const res = validateDecorativeAsset(validAsset);
    expect(res.valid).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it('validateDecorativeAsset rejects asset missing mandatory alt text for accessibility compliance', () => {
    const missingAlt = {
      id: 'no-alt-asset',
      src: '/assets/decor/bg.png',
    };

    const res = validateDecorativeAsset(missingAlt);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('alt');
  });

  it('validateDecorativeAsset rejects unsafe URI schemes like javascript: or vbscript:', () => {
    const unsafeAsset: DecorativeAssetItem = {
      alt: 'Unsafe vector',
      id: 'unsafe-1',
      src: 'javascript:alert(1)',
    };

    const res = validateDecorativeAsset(unsafeAsset);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('forbidden unsafe URI scheme');
  });

  it('validateDecorativeAsset rejects invalid theme values', () => {
    const invalidTheme = {
      alt: 'Valid alt',
      id: 'bad-theme',
      src: '/valid.png',
      theme: 'neon-cyberpunk' as any,
    };

    const res = validateDecorativeAsset(invalidTheme);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Invalid theme');
  });

  it('resolveDecorativeAsset returns default static asset on empty or invalid inputs', () => {
    const fromNull = resolveDecorativeAsset(null);
    expect(fromNull).toEqual(DEFAULT_DECORATIVE_ASSET);

    const fromInvalid = resolveDecorativeAsset({
      alt: 'Test',
      id: 'bad',
      src: 'javascript:void(0)',
    } as any);
    expect(fromInvalid).toEqual(DEFAULT_DECORATIVE_ASSET);
  });

  it('resolveDecorativeAsset handles string and object reducedMotionFallback options', () => {
    const animAsset: DecorativeAssetItem = {
      alt: 'Subtle water ripple animation',
      id: 'water-anim',
      reducedMotionFallback: '/assets/decor/static-ripple.png',
      src: '/assets/decor/animated-ripple.webp',
    };

    // Standard motion: returns animated src
    const standard = resolveDecorativeAsset(animAsset, { prefersReducedMotion: false });
    expect(standard.src).toBe('/assets/decor/animated-ripple.webp');

    // Reduced motion: returns fallback static src
    const reduced = resolveDecorativeAsset(animAsset, { prefersReducedMotion: true });
    expect(reduced.src).toBe('/assets/decor/static-ripple.png');
  });

  it('resolveDecorativeAsset selects defaultAssetId from a manifest', () => {
    const manifest: DecorativeAssetManifest = {
      assets: {
        'dark-bg': {
          alt: 'Dark atmosphere overlay',
          id: 'dark-bg',
          src: '/dark.svg',
          theme: 'dark',
        },
        'light-bg': {
          alt: 'Light atmosphere overlay',
          id: 'light-bg',
          src: '/light.svg',
          theme: 'light',
        },
      },
      defaultAssetId: 'dark-bg',
      version: '1.0.0',
    };

    const resolved = resolveDecorativeAsset(manifest);
    expect(resolved.id).toBe('dark-bg');
    expect(resolved.src).toBe('/dark.svg');
  });

  it('DecorativeLayer component renders default static layer with aria-hidden="true"', () => {
    render(<DecorativeLayer />);

    const layer = screen.getByTestId('decorative-layer');
    expect(layer).toBeInTheDocument();
    expect(layer).toHaveAttribute('aria-hidden', 'true');
    expect(layer).toHaveAttribute('data-asset-id', DEFAULT_DECORATIVE_ASSET.id);
    expect(screen.queryByTestId('decorative-custom-asset')).not.toBeInTheDocument();
  });

  it('DecorativeLayer component renders compliant custom asset with accessible attributes', () => {
    const customAsset: DecorativeAssetItem = {
      alt: 'Clean atmospheric background',
      ariaHidden: true,
      id: 'custom-zen-1',
      src: '/assets/zen-bg.png',
    };

    render(<DecorativeLayer asset={customAsset} />);

    const img = screen.getByTestId('decorative-custom-asset');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/assets/zen-bg.png');
    expect(img).toHaveAttribute('alt', 'Clean atmospheric background');
    expect(img).toHaveAttribute('aria-hidden', 'true');
  });
});

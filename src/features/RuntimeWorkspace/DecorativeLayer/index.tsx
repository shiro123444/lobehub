import { memo } from 'react';

import { resolveDecorativeAsset } from './resolver';
import { styles } from './style';
import {
  type DecorativeAssetItem,
  type DecorativeAssetManifest,
  DEFAULT_DECORATIVE_ASSET,
} from './types';

export interface DecorativeLayerProps {
  asset?: DecorativeAssetItem;
  assetId?: string;
  className?: string;
  manifest?: DecorativeAssetManifest;
}

export const DecorativeLayer = memo<DecorativeLayerProps>(
  ({ asset, assetId, className, manifest }) => {
    const resolvedAsset = resolveDecorativeAsset(asset || manifest, { assetId });
    const isCustomAsset = resolvedAsset.id !== DEFAULT_DECORATIVE_ASSET.id;

    return (
      <div
        aria-hidden="true"
        className={className ? `${styles.container} ${className}` : styles.container}
        data-asset-id={resolvedAsset.id}
        data-testid="decorative-layer"
      >
        <div className={styles.accentGlow} />
        <div className={styles.gridOverlay} />
        {isCustomAsset && (
          <img
            alt={resolvedAsset.alt}
            aria-hidden={resolvedAsset.ariaHidden ?? true}
            className={styles.customAsset}
            data-testid="decorative-custom-asset"
            src={resolvedAsset.src}
          />
        )}
      </div>
    );
  },
);

DecorativeLayer.displayName = 'DecorativeLayer';

export default DecorativeLayer;
export * from './resolver';
export * from './types';
export * from './validator';

'use client';

import { useMarketAuth } from '@/layout/AuthProvider/MarketAuth';
import { useServerConfigStore } from '@/store/serverConfig';
import { serverConfigSelectors } from '@/store/serverConfig/selectors';

/**
 * Safe wrapper around useMarketAuth that skips sign-in when trusted client is enabled.
 * Use this instead of useMarketAuth directly when the signIn action is for Market auth.
 */
export const useMarketAuthSafe = () => {
  const marketAuth = useMarketAuth();
  const enableMarketTrustedClient = useServerConfigStore(
    serverConfigSelectors.enableMarketTrustedClient,
  );

  const signInSafe = async () => {
    if (enableMarketTrustedClient) {
      // Trusted client mode: no user login needed, return null
      return null;
    }
    return marketAuth.signIn();
  };

  return {
    ...marketAuth,
    // When trusted client is enabled, treat as authenticated
    isAuthenticated: enableMarketTrustedClient || marketAuth.isAuthenticated,
    signIn: signInSafe,
  };
};

import {
  adminClient,
  genericOAuthClient,
  inferAdditionalFields,
  magicLinkClient,
  usernameClient,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { type auth } from '@/auth';
import { appEnv } from '@/envs/app';

export const {
  changeEmail,
  linkSocial,
  oauth2,
  accountInfo,
  listAccounts,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  signIn,
  signOut,
  signUp,
  unlinkAccount,
  useSession,
} = createAuthClient({
  baseURL: typeof window !== 'undefined' ? window.location.origin : appEnv.NEXT_PUBLIC_APP_URL,
  plugins: [
    adminClient(),
    inferAdditionalFields<typeof auth>(),
    usernameClient(),
    genericOAuthClient(),
    // Always include magicLinkClient - server will reject if not enabled
    magicLinkClient(),
  ],
});

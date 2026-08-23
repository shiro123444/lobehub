import { isDesktop } from '@lobechat/const';
import { type PropsWithChildren, useEffect } from 'react';

import { useSession } from '@/libs/better-auth/auth-client';

import BetterAuth from './BetterAuth';
import Desktop from './Desktop';

const PUBLIC_PATH_PREFIXES = [
  '/auth-error',
  '/community',
  '/market-auth-callback',
  '/oauth',
  '/reset-password',
  '/share',
  '/signin',
  '/signup',
  '/verify-email',
  '/verify-im',
];

const getSigninUrl = () => {
  const callbackUrl = location.toString();
  const url = new URL('/signin', location.origin);

  // Vite serves only the SPA shell on 9876; auth pages are rendered by Next on 3010.
  if (import.meta.env.DEV && location.port === '9876') {
    url.protocol = location.protocol;
    url.hostname = location.hostname;
    url.port = '3010';
  }

  url.searchParams.set('callbackUrl', callbackUrl);

  return url.toString();
};

const WebAuthGate = ({ children }: PropsWithChildren) => {
  const { data: session, isPending } = useSession();

  useEffect(() => {
    if (isPending || session?.user) return;
    if (PUBLIC_PATH_PREFIXES.some((prefix) => location.pathname.startsWith(prefix))) return;

    window.location.replace(getSigninUrl());
  }, [isPending, session?.user]);

  return children;
};

const AuthProvider = ({ children }: PropsWithChildren) => {
  if (isDesktop) {
    return <Desktop>{children}</Desktop>;
  }

  // In SPA/Vite mode, always use BetterAuth.
  // If auth is not configured on the server, useSession() will return no session
  // and the user will be treated as not signed in — same effect as NoAuth.
  return (
    <BetterAuth>
      <WebAuthGate>{children}</WebAuthGate>
    </BetterAuth>
  );
};

export default AuthProvider;

import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { type PropsWithChildren } from 'react';

import BusinessAuthProvider from '@/business/client/BusinessAuthProvider';
import ClientOnly from '@/components/client/ClientOnly';
import Loading from '@/components/Loading/BrandTextLoading';
import { type DynamicLayoutProps } from '@/types/next';

import AuthContainer from './_layout';
import AuthGlobalProvider from './_layout/AuthGlobalProvider';

const AuthLayout = async ({ children, params }: PropsWithChildren<DynamicLayoutProps>) => {
  const { variants } = await params;

  return (
    <AuthGlobalProvider variants={variants}>
      <ClientOnly fallback={<Loading debugId={'Auth'} />}>
        <NuqsAdapter>
          <BusinessAuthProvider>
            <AuthContainer>{children}</AuthContainer>
          </BusinessAuthProvider>
        </NuqsAdapter>
      </ClientOnly>
    </AuthGlobalProvider>
  );
};

export default AuthLayout;

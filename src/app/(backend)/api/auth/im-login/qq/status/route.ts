import { serializeSignedCookie } from 'better-call';
import { eq } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { nexusImLoginCodes } from '@/database/schemas/nexus';
import { serverDB } from '@/database/server';

async function createAuthenticatedResponse(loginCode: {
  confirmedAt: Date | null;
  expiresAt: Date;
  id: string;
  identityId: string | null;
  status: string;
  userId: string | null;
}) {
  if (!loginCode.userId) {
    return NextResponse.json({
      confirmedAt: loginCode.confirmedAt?.toISOString(),
      expiresAt: loginCode.expiresAt.toISOString(),
      identityId: loginCode.identityId,
      linked: false,
      status: loginCode.status,
    });
  }

  const authContext = (await auth.$context) as any;
  const session = await authContext.internalAdapter.createSession(loginCode.userId);
  const sessionCookie = await serializeSignedCookie(
    authContext.authCookies.sessionToken.name,
    session.token,
    authContext.secret,
    {
      ...authContext.authCookies.sessionToken.options,
      maxAge: authContext.sessionConfig.expiresIn,
    },
  );

  await serverDB
    .update(nexusImLoginCodes)
    .set({
      consumedAt: new Date(),
      status: 'authenticated',
      updatedAt: new Date(),
    })
    .where(eq(nexusImLoginCodes.id, loginCode.id));

  const response = NextResponse.json({
    authenticated: true,
    confirmedAt: loginCode.confirmedAt?.toISOString(),
    expiresAt: loginCode.expiresAt.toISOString(),
    identityId: loginCode.identityId,
    linked: true,
    status: 'authenticated',
  });
  response.headers.append('set-cookie', sessionCookie);

  return response;
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  const [loginCode] = await serverDB
    .select({
      confirmedAt: nexusImLoginCodes.confirmedAt,
      expiresAt: nexusImLoginCodes.expiresAt,
      id: nexusImLoginCodes.id,
      identityId: nexusImLoginCodes.identityId,
      status: nexusImLoginCodes.status,
      userId: nexusImLoginCodes.userId,
      consumedAt: nexusImLoginCodes.consumedAt,
    })
    .from(nexusImLoginCodes)
    .where(eq(nexusImLoginCodes.id, id))
    .limit(1);

  if (!loginCode) {
    return NextResponse.json({ error: 'Login code not found' }, { status: 404 });
  }

  const expired = loginCode.status === 'pending' && loginCode.expiresAt.getTime() <= Date.now();

  if (expired) {
    await serverDB
      .update(nexusImLoginCodes)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(nexusImLoginCodes.id, loginCode.id));
  }

  if (loginCode.status === 'confirmed' && !loginCode.consumedAt) {
    return createAuthenticatedResponse(loginCode);
  }

  return NextResponse.json({
    authenticated: loginCode.status === 'authenticated',
    confirmedAt: loginCode.confirmedAt?.toISOString(),
    expiresAt: loginCode.expiresAt.toISOString(),
    identityId: loginCode.identityId,
    linked: Boolean(loginCode.userId),
    status: expired ? 'expired' : loginCode.status,
  });
}

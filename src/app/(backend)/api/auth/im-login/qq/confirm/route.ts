import { and, eq, gt } from 'drizzle-orm';
import { idGenerator } from '@lobechat/database';
import { NextResponse, type NextRequest } from 'next/server';

import { users } from '@/database/schemas/user';
import { nexusImIdentities, nexusImLoginCodes } from '@/database/schemas/nexus';
import { serverDB } from '@/database/server';
import {
  hashNexusImLoginCode,
  isValidNexusImLoginCode,
  verifyNexusImBotSecret,
} from '@/libs/better-auth/nexus-im-login';

export async function POST(req: NextRequest) {
  if (!verifyNexusImBotSecret(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const code = body.code;
  const externalId = String(body.qqId || body.qqNumber || '').trim();

  if (!isValidNexusImLoginCode(code)) {
    return NextResponse.json({ error: 'Invalid verification code' }, { status: 400 });
  }

  if (!externalId) {
    return NextResponse.json({ error: 'qqId or qqNumber is required' }, { status: 400 });
  }

  const [loginCode] = await serverDB
    .select()
    .from(nexusImLoginCodes)
    .where(
      and(
        eq(nexusImLoginCodes.provider, 'qq'),
        eq(nexusImLoginCodes.status, 'pending'),
        eq(nexusImLoginCodes.codeHash, hashNexusImLoginCode(code)),
        gt(nexusImLoginCodes.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!loginCode) {
    return NextResponse.json({ error: 'Verification code expired or not found' }, { status: 404 });
  }

  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : undefined;
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : undefined;
  const avatar = typeof body.avatar === 'string' ? body.avatar.trim() : undefined;
  const metadata = {
    qqNumber: body.qqNumber,
  };

  let [identity] = await serverDB
    .select()
    .from(nexusImIdentities)
    .where(and(eq(nexusImIdentities.provider, 'qq'), eq(nexusImIdentities.externalId, externalId)))
    .limit(1);

  if (identity) {
    [identity] = await serverDB
      .update(nexusImIdentities)
      .set({
        avatar,
        displayName,
        groupId,
        metadata,
        updatedAt: new Date(),
      })
      .where(eq(nexusImIdentities.id, identity.id))
      .returning();
  } else {
    [identity] = await serverDB
      .insert(nexusImIdentities)
      .values({
        avatar,
        displayName,
        externalId,
        groupId,
        metadata,
        provider: 'qq',
      })
      .returning();
  }

  let userId = identity.userId;

  if (!userId) {
    const newUserId = idGenerator('user', 32 - 'user_'.length);

    await serverDB
      .insert(users)
      .values({
        avatar,
        emailVerified: false,
        fullName: displayName || `QQ ${externalId}`,
        id: newUserId,
        role: 'user',
      });

    userId = newUserId;

    [identity] = await serverDB
      .update(nexusImIdentities)
      .set({
        updatedAt: new Date(),
        userId,
      })
      .where(eq(nexusImIdentities.id, identity.id))
      .returning();
  }

  await serverDB
    .update(nexusImLoginCodes)
    .set({
      confirmedAt: new Date(),
      identityId: identity.id,
      status: 'confirmed',
      updatedAt: new Date(),
      userId,
    })
    .where(eq(nexusImLoginCodes.id, loginCode.id));

  return NextResponse.json({
    linked: Boolean(userId),
    status: 'confirmed',
  });
}

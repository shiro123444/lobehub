import { NextResponse, type NextRequest } from 'next/server';

import { nexusImLoginCodes } from '@/database/schemas/nexus';
import { serverDB } from '@/database/server';
import { createNexusImLoginCode, hashNexusImLoginCode } from '@/libs/better-auth/nexus-im-login';

const EXPIRES_IN_SECONDS = 5 * 60;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : undefined;
  const code = createNexusImLoginCode();
  const expiresAt = new Date(Date.now() + EXPIRES_IN_SECONDS * 1000);

  const [loginCode] = await serverDB
    .insert(nexusImLoginCodes)
    .values({
      codeHash: hashNexusImLoginCode(code),
      expiresAt,
      groupId: groupId || undefined,
      provider: 'qq',
      status: 'pending',
    })
    .returning({ expiresAt: nexusImLoginCodes.expiresAt, id: nexusImLoginCodes.id });

  return NextResponse.json({
    code,
    expiresAt: loginCode.expiresAt.toISOString(),
    expiresIn: EXPIRES_IN_SECONDS,
    id: loginCode.id,
  });
}

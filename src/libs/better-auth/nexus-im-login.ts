import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { authEnv } from '@/envs/auth';

export function createNexusImLoginCode() {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashNexusImLoginCode(code: string) {
  const secret = authEnv.AUTH_SECRET?.trim() || 'nexus-im-login-secret';
  return createHmac('sha256', secret).update(code).digest('hex');
}

export function isValidNexusImLoginCode(code: unknown): code is string {
  return typeof code === 'string' && /^\d{6}$/.test(code);
}

export function verifyNexusImBotSecret(authorization: string | null) {
  const secret = process.env.NEXUS_QQ_BOT_SECRET?.trim();
  if (!secret) return true;

  const token = authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;

  const expected = Buffer.from(secret);
  const actual = Buffer.from(token);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

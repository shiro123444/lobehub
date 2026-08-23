import { pbkdf2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

export const NEXUS_LEGACY_PASSWORD_PREFIX = 'nexus-pbkdf2-sha256';
export const NEXUS_LEGACY_PASSWORD_ITERATIONS = 200_000;

interface NexusLegacyPasswordPayload {
  hash: string;
  iterations?: number;
  salt: string;
}

export function encodeNexusLegacyPasswordHash({
  hash,
  iterations = NEXUS_LEGACY_PASSWORD_ITERATIONS,
  salt,
}: NexusLegacyPasswordPayload) {
  return [NEXUS_LEGACY_PASSWORD_PREFIX, iterations, salt, hash].join('$');
}

export function isNexusLegacyPasswordHash(hash: string) {
  return hash.startsWith(`${NEXUS_LEGACY_PASSWORD_PREFIX}$`);
}

export async function verifyNexusLegacyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}) {
  if (!isNexusLegacyPasswordHash(hash)) return false;

  const [, iterationsValue, salt, storedHash] = hash.split('$');
  const iterations = Number(iterationsValue);

  if (!Number.isInteger(iterations) || iterations <= 0 || !salt || !storedHash) return false;

  let storedBuffer: Buffer;

  try {
    storedBuffer = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }

  if (storedBuffer.length === 0) return false;

  const derivedKey = (await pbkdf2Async(
    password,
    salt,
    iterations,
    storedBuffer.length,
    'sha256',
  )) as Buffer;

  return derivedKey.length === storedBuffer.length && timingSafeEqual(derivedKey, storedBuffer);
}

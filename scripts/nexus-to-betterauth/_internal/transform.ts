import { encodeNexusLegacyPasswordHash } from '../../../src/libs/better-auth/nexus-legacy-password';

const EMAIL_REGEX = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;
const NEXUS_SOURCE = 'kiro-kroxy';

export interface NexusSqliteUser {
  avatar: string | null;
  balance_usd: number | null;
  created_at: string | null;
  display_name: string | null;
  email: string | null;
  email_verified: number | null;
  email_verified_at: string | null;
  id: number;
  is_active: number | null;
  notes: string | null;
  password_hash: string;
  password_salt: string;
  student_id: string;
  total_tokens: number | null;
  used_tokens: number | null;
}

export function buildAccountId(legacyUserId: number) {
  return `cred_nexus_${legacyUserId}`;
}

export function buildPlaceholderEmail(legacyUserId: number, domain: string) {
  return `legacy-${legacyUserId}@${domain.toLowerCase()}`;
}

export function buildUserId(legacyUserId: number) {
  return `user_nexus_${legacyUserId}`;
}

export function convertSqliteDate(value?: string | null) {
  if (!value) return undefined;

  const normalized = value.trim().replace(' ', 'T');
  const date = new Date(`${normalized}+08:00`);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function normalizeLegacyEmail(value?: string | null) {
  const email = value?.trim().toLowerCase();
  if (!email || !EMAIL_REGEX.test(email)) return undefined;
  return email;
}

export function toBetterAuthRows(user: NexusSqliteUser, placeholderEmailDomain: string) {
  const userId = buildUserId(user.id);
  const legacyCreatedAt = convertSqliteDate(user.created_at);
  const email = normalizeLegacyEmail(user.email) || buildPlaceholderEmail(user.id, placeholderEmailDomain);
  const emailVerified = Boolean(user.email_verified && normalizeLegacyEmail(user.email));

  return {
    account: {
      accountId: userId,
      createdAt: legacyCreatedAt,
      id: buildAccountId(user.id),
      password: encodeNexusLegacyPasswordHash({
        hash: user.password_hash,
        salt: user.password_salt,
      }),
      providerId: 'credential',
      updatedAt: legacyCreatedAt,
      userId,
    },
    mapping: {
      legacyCreatedAt,
      legacyStudentId: user.student_id,
      legacyUserId: user.id,
      metadata: {
        balanceUsd: user.balance_usd ?? 0,
        email: user.email,
        notes: user.notes,
        totalTokens: user.total_tokens ?? 0,
        usedTokens: user.used_tokens ?? 0,
      },
      source: NEXUS_SOURCE,
      userId,
    },
    user: {
      avatar: user.avatar || undefined,
      banned: user.is_active === 0,
      createdAt: legacyCreatedAt,
      email,
      emailVerified,
      emailVerifiedAt: emailVerified ? convertSqliteDate(user.email_verified_at) || legacyCreatedAt : undefined,
      fullName: user.display_name || user.student_id,
      id: userId,
      normalizedEmail: email,
      role: 'user',
      updatedAt: legacyCreatedAt,
      username: user.student_id,
    },
  };
}

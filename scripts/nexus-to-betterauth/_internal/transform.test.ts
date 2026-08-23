import { describe, expect, it } from 'vitest';

import { buildPlaceholderEmail, convertSqliteDate, normalizeLegacyEmail } from './transform';

describe('nexus-to-betterauth transform', () => {
  it('normalizes valid legacy emails', () => {
    expect(normalizeLegacyEmail(' Shiro@Example.COM ')).toBe('shiro@example.com');
  });

  it('ignores invalid legacy emails', () => {
    expect(normalizeLegacyEmail('not-an-email')).toBeUndefined();
  });

  it('builds deterministic placeholder emails', () => {
    expect(buildPlaceholderEmail(42, 'users.nexus.local')).toBe('legacy-42@users.nexus.local');
  });

  it('converts NEXUS local sqlite dates as China time', () => {
    expect(convertSqliteDate('2026-05-18 12:30:00')?.toISOString()).toBe(
      '2026-05-18T04:30:00.000Z',
    );
  });
});

import { describe, expect, it } from 'vitest';

import { encodeNexusLegacyPasswordHash, verifyNexusLegacyPassword } from './nexus-legacy-password';

describe('nexus legacy password', () => {
  it('verifies NEXUS PBKDF2-SHA256 password hashes', async () => {
    const legacyPassword = encodeNexusLegacyPasswordHash({
      hash: '2a59ebd649825fd204a751e5b9f52cb8a1d4a4795e8de44cfb749c47730f0fc8',
      salt: '0123456789abcdef0123456789abcdef',
    });

    await expect(
      verifyNexusLegacyPassword({ hash: legacyPassword, password: 'NexusPass123!' }),
    ).resolves.toBe(true);
    await expect(
      verifyNexusLegacyPassword({ hash: legacyPassword, password: 'wrong-password' }),
    ).resolves.toBe(false);
  });

  it('ignores non-NEXUS password hashes', async () => {
    await expect(
      verifyNexusLegacyPassword({ hash: '$scrypt$not-nexus', password: 'NexusPass123!' }),
    ).resolves.toBe(false);
  });
});

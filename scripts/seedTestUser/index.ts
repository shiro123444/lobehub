import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import { eq, sql } from 'drizzle-orm';

const env = process.env.NODE_ENV || 'development';
dotenvExpand.expand(dotenv.config());
dotenvExpand.expand(dotenv.config({ override: true, path: '.env.local' }));
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}` }));
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}.local` }));

const parseFlag = (name: string) => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
};

const email = (parseFlag('email') || 'test@nexus.dev').trim().toLowerCase();
const password = parseFlag('password') || 'NexusTest123!';
const username = (parseFlag('username') || 'test').trim();
const fullName = parseFlag('fullName') || 'Nexus Test';

const main = async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Configure .env.local first.');
    process.exit(1);
  }

  const { hashPassword } = await import('better-auth/crypto');
  const { serverDB } = await import('../../packages/database/src/server');
  const { account } = await import('../../packages/database/src/schemas/betterAuth');
  const { users } = await import('../../packages/database/src/schemas/user');
  const { idGenerator } = await import('../../packages/database/src/utils/idGenerator');

  // Keep local dev databases usable even if they were created before this column existed.
  await serverDB.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_username" text`);

  const now = new Date();
  const passwordHash = await hashPassword(password);

  const [existingUser] = await serverDB
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const userId = existingUser?.id || idGenerator('user', 32 - 'user_'.length);

  if (existingUser) {
    await serverDB
      .update(users)
      .set({
        displayUsername: username,
        emailVerified: true,
        fullName,
        normalizedEmail: email,
        username,
        updatedAt: now,
      })
      .where(eq(users.id, userId));
  } else {
    await serverDB.insert(users).values({
      displayUsername: username,
      email,
      emailVerified: true,
      fullName,
      id: userId,
      normalizedEmail: email,
      role: 'user',
      username,
    });
  }

  const [existingCredential] = await serverDB
    .select({ id: account.id })
    .from(account)
    .where(sql`${account.userId} = ${userId} and ${account.providerId} = 'credential'`)
    .limit(1);

  if (existingCredential) {
    await serverDB
      .update(account)
      .set({ password: passwordHash, updatedAt: now })
      .where(eq(account.id, existingCredential.id));
  } else {
    await serverDB.insert(account).values({
      accountId: userId,
      createdAt: now,
      id: `cred_${userId}`,
      password: passwordHash,
      providerId: 'credential',
      updatedAt: now,
      userId,
    });
  }

  console.log('Seeded test user:');
  console.log(`  email: ${email}`);
  console.log(`  username: ${username}`);
  console.log(`  password: ${password}`);
  console.log(`  userId: ${userId}`);

  process.exit(0);
};

main().catch((error) => {
  console.error('Seed test user failed:', error);
  process.exit(1);
});

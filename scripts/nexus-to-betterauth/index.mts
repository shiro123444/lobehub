import { inArray, or, sql } from 'drizzle-orm';

import {
  getBatchSize,
  getMigrationMode,
  getPlaceholderEmailDomain,
  getSqlitePath,
  isDryRun,
} from './_internal/config';
import { db, pool, schema } from './_internal/db';
import { type NexusSqliteUser, toBetterAuthRows } from './_internal/transform';

const BATCH_SIZE = getBatchSize();
const IS_DRY_RUN = isDryRun();
const PROGRESS_TABLE = sql.identifier('nexus_migration_progress');

const GREEN_BOLD = '\u001B[1;32m';
const RED_BOLD = '\u001B[1;31m';
const RESET = '\u001B[0m';

function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isFinite(size) || size <= 0) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function formatDuration(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function loadNexusUsers(sqlitePath: string): Promise<NexusSqliteUser[]> {
  const { Database } = await import('bun:sqlite');
  const sqlite = new Database(sqlitePath, { readonly: true });

  try {
    return sqlite
      .query<NexusSqliteUser>(`
        SELECT
          id,
          student_id,
          display_name,
          email,
          email_verified,
          email_verified_at,
          password_hash,
          password_salt,
          created_at,
          is_active,
          total_tokens,
          used_tokens,
          balance_usd,
          notes,
          avatar
        FROM users
        ORDER BY id ASC
      `)
      .all();
  } finally {
    sqlite.close();
  }
}

async function assertNoUniqueConflicts(rows: ReturnType<typeof toBetterAuthRows>[]) {
  const usernames = rows.map((row) => row.user.username);
  const emails = rows.map((row) => row.user.email);

  const existingUsers = await db
    .select({
      email: schema.users.email,
      id: schema.users.id,
      username: schema.users.username,
    })
    .from(schema.users)
    .where(or(inArray(schema.users.username, usernames), inArray(schema.users.email, emails)));

  const desiredByUsername = new Map(rows.map((row) => [row.user.username, row.user.id]));
  const desiredByEmail = new Map(rows.map((row) => [row.user.email, row.user.id]));

  const conflicts = existingUsers.filter((user) => {
    const usernameOwner = user.username ? desiredByUsername.get(user.username) : undefined;
    const emailOwner = user.email ? desiredByEmail.get(user.email) : undefined;

    return (usernameOwner && usernameOwner !== user.id) || (emailOwner && emailOwner !== user.id);
  });

  if (conflicts.length > 0) {
    const sample = conflicts
      .slice(0, 5)
      .map((user) => `${user.id}:${user.username || '-'}:${user.email || '-'}`)
      .join(', ');
    throw new Error(
      `[nexus-to-betterauth] user unique conflicts detected: count=${conflicts.length}, sample=${sample}`,
    );
  }
}

async function migrateFromNexus() {
  const sqlitePath = getSqlitePath();
  const placeholderEmailDomain = getPlaceholderEmailDomain();
  const legacyUsers = await loadNexusUsers(sqlitePath);

  if (!IS_DRY_RUN) {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${PROGRESS_TABLE} (
        legacy_user_id INTEGER PRIMARY KEY,
        processed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  }

  const processedLegacyIds = new Set<number>();

  if (!IS_DRY_RUN) {
    const processedResult = await db.execute<{ legacy_user_id: number }>(
      sql`SELECT legacy_user_id FROM ${PROGRESS_TABLE};`,
    );
    const rows = (processedResult as { rows?: { legacy_user_id: number }[] }).rows ?? [];
    for (const row of rows) processedLegacyIds.add(Number(row.legacy_user_id));
  }

  const unprocessedUsers = legacyUsers.filter((user) => !processedLegacyIds.has(user.id));
  const batches = chunk(unprocessedUsers, BATCH_SIZE);
  const startedAt = Date.now();
  let importedUsers = 0;
  let placeholderEmails = 0;
  let disabledUsers = 0;

  console.log(`[nexus-to-betterauth] sqlite: ${sqlitePath}`);
  console.log(`[nexus-to-betterauth] legacy users: ${legacyUsers.length}`);
  console.log(`[nexus-to-betterauth] already processed: ${processedLegacyIds.size}`);
  console.log(
    `[nexus-to-betterauth] batches: ${batches.length} (batchSize=${BATCH_SIZE}, toProcess=${unprocessedUsers.length})`,
  );

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const rows = batch.map((user) => toBetterAuthRows(user, placeholderEmailDomain));

    await assertNoUniqueConflicts(rows);

    const userRows: (typeof schema.users.$inferInsert)[] = rows.map((row) => row.user);
    const accountRows: (typeof schema.account.$inferInsert)[] = rows.map((row) => row.account);
    const mappingRows: (typeof schema.nexusLegacyUserMappings.$inferInsert)[] = rows.map(
      (row) => row.mapping,
    );

    placeholderEmails += rows.filter((row) =>
      row.user.email.endsWith(`@${placeholderEmailDomain.toLowerCase()}`),
    ).length;
    disabledUsers += rows.filter((row) => row.user.banned).length;

    if (!IS_DRY_RUN && userRows.length > 0) {
      await db.transaction(async (tx) => {
        await tx
          .insert(schema.users)
          .values(userRows)
          .onConflictDoUpdate({
            set: {
              avatar: sql`excluded.avatar`,
              banned: sql`excluded.banned`,
              email: sql`excluded.email`,
              emailVerified: sql`excluded.email_verified`,
              emailVerifiedAt: sql`excluded.email_verified_at`,
              fullName: sql`excluded.full_name`,
              normalizedEmail: sql`excluded.normalized_email`,
              role: sql`excluded.role`,
              username: sql`excluded.username`,
              updatedAt: sql`excluded.updated_at`,
            },
            target: schema.users.id,
          });

        await tx
          .insert(schema.account)
          .values(accountRows)
          .onConflictDoUpdate({
            set: {
              password: sql`excluded.password`,
              updatedAt: sql`excluded.updated_at`,
            },
            target: schema.account.id,
          });

        await tx
          .insert(schema.nexusLegacyUserMappings)
          .values(mappingRows)
          .onConflictDoUpdate({
            set: {
              legacyCreatedAt: sql`excluded.legacy_created_at`,
              legacyStudentId: sql`excluded.legacy_student_id`,
              metadata: sql`excluded.metadata`,
              updatedAt: sql`excluded.updated_at`,
              userId: sql`excluded.user_id`,
            },
            target: [
              schema.nexusLegacyUserMappings.source,
              schema.nexusLegacyUserMappings.legacyUserId,
            ],
          });

        const progressValues = batch.map((user) => sql`(${user.id})`);
        await tx.execute(sql`
          INSERT INTO ${PROGRESS_TABLE} (legacy_user_id)
          VALUES ${sql.join(progressValues, sql`, `)}
          ON CONFLICT (legacy_user_id) DO NOTHING;
        `);
      });
    }

    importedUsers += batch.length;
    console.log(
      `[nexus-to-betterauth] batch ${batchIndex + 1}/${batches.length} done, users ${importedUsers}/${unprocessedUsers.length}, dryRun=${IS_DRY_RUN}`,
    );
  }

  console.log(
    `[nexus-to-betterauth] completed users=${GREEN_BOLD}${importedUsers}${RESET}, placeholders=${placeholderEmails}, disabled=${disabledUsers}, dryRun=${IS_DRY_RUN}, elapsed=${formatDuration(Date.now() - startedAt)}`,
  );
}

async function confirmProductionWrite(mode: string) {
  if (mode !== 'prod' || IS_DRY_RUN) return true;

  console.log('WARNING: Running NEXUS migration in PRODUCTION mode. Type "yes" to continue.');
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question('Confirm (yes/no): ', resolve);
  });
  rl.close();

  return answer.toLowerCase() === 'yes';
}

async function main() {
  const startedAt = Date.now();
  const mode = getMigrationMode();

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║            NEXUS to Better Auth Migration Script          ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Mode:     ${mode.padEnd(48)}║`);
  console.log(`║  Dry Run:  ${(IS_DRY_RUN ? 'YES (no changes will be made)' : 'NO').padEnd(48)}║`);
  console.log(`║  Batch:    ${String(BATCH_SIZE).padEnd(48)}║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!(await confirmProductionWrite(mode))) {
    console.log('Aborted by user.');
    await pool.end();
    return;
  }

  try {
    await migrateFromNexus();
    console.log(
      `${GREEN_BOLD}Migration success.${RESET} (${formatDuration(Date.now() - startedAt)})`,
    );
  } catch (error) {
    console.error(
      `${RED_BOLD}Migration failed${RESET} (${formatDuration(Date.now() - startedAt)}):`,
      error,
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();

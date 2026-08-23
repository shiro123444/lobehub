import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

export type DatabaseDriver = 'neon' | 'node';
export type MigrationMode = 'test' | 'prod';

if (existsSync('.env')) {
  loadEnvFile();
}

const DEFAULT_BATCH_SIZE = 300;
const DEFAULT_DATABASE_DRIVER: DatabaseDriver = 'neon';
const DEFAULT_MODE: MigrationMode = 'test';
const DEFAULT_PLACEHOLDER_EMAIL_DOMAIN = 'users.nexus.local';

export function getBatchSize() {
  return Number(process.env.NEXUS_TO_BETTERAUTH_BATCH_SIZE) || DEFAULT_BATCH_SIZE;
}

export function getDatabaseDriver(): DatabaseDriver {
  const driver = process.env.NEXUS_TO_BETTERAUTH_DATABASE_DRIVER;
  if (driver === 'neon' || driver === 'node') return driver;
  return DEFAULT_DATABASE_DRIVER;
}

export function getDatabaseUrl(mode = getMigrationMode()) {
  const key =
    mode === 'test'
      ? 'TEST_NEXUS_TO_BETTERAUTH_DATABASE_URL'
      : 'PROD_NEXUS_TO_BETTERAUTH_DATABASE_URL';
  const value = process.env[key] || process.env.NEXUS_TO_BETTERAUTH_DATABASE_URL;

  if (!value) {
    throw new Error(`${key} or NEXUS_TO_BETTERAUTH_DATABASE_URL is required`);
  }

  return value;
}

export function getMigrationMode(): MigrationMode {
  const mode = process.env.NEXUS_TO_BETTERAUTH_MODE;
  if (mode === 'test' || mode === 'prod') return mode;
  return DEFAULT_MODE;
}

export function getPlaceholderEmailDomain() {
  return process.env.NEXUS_TO_BETTERAUTH_PLACEHOLDER_EMAIL_DOMAIN || DEFAULT_PLACEHOLDER_EMAIL_DOMAIN;
}

export function getSqlitePath() {
  const value =
    process.env.NEXUS_TO_BETTERAUTH_SQLITE_PATH || `${process.env.HOME || ''}/.kiro-proxy/portal.db`;

  if (!value || !existsSync(value)) {
    throw new Error(`NEXUS sqlite database not found: ${value || '<empty>'}`);
  }

  return value;
}

export function isDryRun() {
  return process.argv.includes('--dry-run') || process.env.NEXUS_TO_BETTERAUTH_DRY_RUN === '1';
}

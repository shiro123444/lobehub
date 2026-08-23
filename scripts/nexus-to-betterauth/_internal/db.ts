import { neonConfig, Pool as NeonPool } from '@neondatabase/serverless';
import { drizzle as neonDrizzle } from 'drizzle-orm/neon-serverless';
import { drizzle as nodeDrizzle } from 'drizzle-orm/node-postgres';
import { Pool as NodePool } from 'pg';
import ws from 'ws';

import * as schemaModule from '../../../packages/database/src/schemas';
import { getDatabaseDriver, getDatabaseUrl } from './config';

function createDatabase() {
  const databaseUrl = getDatabaseUrl();
  const driver = getDatabaseDriver();

  if (driver === 'node') {
    const pool = new NodePool({ connectionString: databaseUrl });
    const db = nodeDrizzle(pool, { schema: schemaModule });
    return { db, pool };
  }

  neonConfig.webSocketConstructor = ws;
  const pool = new NeonPool({ connectionString: databaseUrl });
  const db = neonDrizzle(pool, { schema: schemaModule });
  return { db, pool };
}

const { db, pool } = createDatabase();

export { db, pool };
export * as schema from '../../../packages/database/src/schemas';

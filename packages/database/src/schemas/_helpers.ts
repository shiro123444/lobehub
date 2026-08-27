import { boolean, numeric, timestamp, varchar } from 'drizzle-orm/pg-core';

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const varchar255 = (name: string) => varchar(name, { length: 255 });

export const createdAt = () => timestamptz('created_at').notNull().defaultNow();
export const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
/**
 * Soft-delete columns for user content that goes through the recycle bin.
 *
 * - `isDeleted` — the flag every ownership-scoped read filters on
 *   (`is_deleted = false`); cheap to index, unambiguous in raw SQL.
 * - `deletedAt` — when the row was trashed; drives the retention clock and
 *   the "deleted 3 days ago" copy.
 *
 * The two are always written together (`trashStamp()` / `restoreStamp()` in
 * `utils/softDelete.ts`) — treat `is_deleted = (deleted_at IS NOT NULL)` as an
 * invariant. See `schemas/trash.ts` for the registry that indexes trashed
 * roots across tables, and `utils/workspace.ts` for the read-side filter.
 *
 * Adding this to a table makes its rows *filterable*; it does not make them
 * *trashable* — that still needs a handler in the server `TrashService`.
 */
export const softDeleteColumns = () => ({
  deletedAt: timestamptz('deleted_at'),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export const accessedAt = () =>
  timestamptz('accessed_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Amount field - Unified configuration with precision 20, scale 6, returns number type
 *
 * Caller should handle default and nullable values
 */
export const amountNumeric = (name: string) =>
  numeric(name, { mode: 'number', precision: 20, scale: 6 });

// columns.helpers.ts
export const timestamps = {
  accessedAt: accessedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
};

declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean });
    close(): void;
    query<T = unknown>(sql: string): {
      all(...params: unknown[]): T[];
      get(...params: unknown[]): T | null;
    };
  }
}

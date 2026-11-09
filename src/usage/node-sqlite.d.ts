// The pinned @types/node (20.x) predates node:sqlite (Node 22.5 behind a flag, 22.13 without).
// This scopes just the surface src/usage/*.js actually calls, until the
// pinned @types/node major version catches up to the engines range.
declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): StatementResultingChanges;
  }
  export class DatabaseSync {
    constructor(path: string, options?: Record<string, unknown>);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

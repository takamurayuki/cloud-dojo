// node:sqlite（Node 22.5+）の最小型宣言。リポジトリの @types/node は v20 系で型が無いため。
declare module 'node:sqlite' {
  type SQLValue = null | number | bigint | string | Uint8Array;
  export class StatementSync {
    run(...params: SQLValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SQLValue[]): Record<string, SQLValue> | undefined;
    all(...params: SQLValue[]): Record<string, SQLValue>[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; enableForeignKeyConstraints?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

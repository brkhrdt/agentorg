import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Small compatibility layer over Node's synchronous SQLite API. */
export class Database {
  private readonly inner: DatabaseSync;
  constructor(path: string, options: { create?: boolean } = {}) {
    this.inner = new DatabaseSync(path, { readOnly: false });
  }
  exec(sql: string): void { this.inner.exec(sql); }
  query<Row = Record<string, unknown>, Params extends unknown[] = unknown[]>(sql: string) {
    const statement = this.inner.prepare(sql);
    return {
      get: (...params: Params): Row | undefined => statement.get(...params as SQLInputValue[]) as Row | undefined,
      all: (...params: Params): Row[] => statement.all(...params as SQLInputValue[]) as Row[],
      run: (...params: Params) => statement.run(...params as SQLInputValue[]),
      iterate: (...params: Params) => statement.iterate(...params as SQLInputValue[]) as IterableIterator<Row>,
    };
  }
  prepare<Row = Record<string, unknown>, Params extends unknown[] = unknown[]>(sql: string) {
    const statement = this.inner.prepare(sql);
    return { iterate: (...params: Params) => statement.iterate(...params as SQLInputValue[]) as IterableIterator<Row> };
  }
  transaction<T extends (...args: never[]) => unknown>(callback: T): T {
    return ((...args: never[]) => {
      this.inner.exec("BEGIN IMMEDIATE");
      try { const result = callback(...args); this.inner.exec("COMMIT"); return result; }
      catch (error) { this.inner.exec("ROLLBACK"); throw error; }
    }) as T;
  }
  close(): void { this.inner.close(); }
}

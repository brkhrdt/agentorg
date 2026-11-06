import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Small compatibility layer over Node's synchronous SQLite API. */
export class Database {
  private readonly inner: DatabaseSync;
  private transactionDepth = 0;
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
      const depth = this.transactionDepth++;
      const savepoint = `node_tx_${depth}`;
      try { this.inner.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`); }
      catch (error) { this.transactionDepth--; throw error; }
      try {
        const result = callback(...args);
        this.inner.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        if (depth === 0) this.inner.exec("ROLLBACK");
        else this.inner.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      } finally { this.transactionDepth--; }
    }) as T;
  }
  close(): void { this.inner.close(); }
}

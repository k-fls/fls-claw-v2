export type DbDialect = 'sqlite' | 'postgres';

export interface RunResult {
  changes: number;
}

/**
 * Async central-database boundary. Session mailboxes deliberately do not use
 * this interface: inbound.db and outbound.db remain direct SQLite databases.
 *
 * Transaction callbacks must issue DB calls sequentially. Do not use
 * Promise.all, and never await mailbox, container, adapter, or network work
 * while a central transaction is open. Put those effects after commit.
 */
export interface DbDriver {
  readonly dialect: DbDialect;
  get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  hasTable(name: string): Promise<boolean>;
  close(): Promise<void>;
}

import type { BrokerStrategy, IBrokerEngine } from "../types/engine.js";

/**
 * PostgreSQL Broker using FOR UPDATE SKIP LOCKED for atomic job claiming.
 *
 * Tables (auto-created):
 *   {prefix}_queue (
 *     broker_name TEXT NOT NULL,
 *     id          TEXT NOT NULL,
 *     priority    INT NOT NULL DEFAULT 0,
 *     run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     locked_by   TEXT,
 *     locked_until TIMESTAMPTZ,
 *     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     PRIMARY KEY (broker_name, id)
 *   )
 */
export class PostgresBroker implements IBrokerEngine {
  private pool: any;
  private tableName: string;
  private initialized = false;

  constructor(connectionString: string, tablePrefix = "oqron", poolSize = 10) {
    this.tableName = `${tablePrefix}_queue`;
    this._initPool(connectionString, poolSize);
  }

  private async _initPool(
    connectionString: string,
    poolSize: number,
  ): Promise<void> {
    const { Pool } = await import("pg");
    this.pool = new Pool({ connectionString, max: poolSize });
  }

  private async ensureTable(): Promise<void> {
    if (this.initialized) return;
    while (!this.pool) await new Promise((r) => setTimeout(r, 10));

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        broker_name TEXT NOT NULL,
        id TEXT NOT NULL,
        priority INT NOT NULL DEFAULT 0,
        run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_by TEXT,
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (broker_name, id)
      )
    `);

    // Index for efficient claim queries
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_claim
      ON ${this.tableName} (broker_name, run_at)
      WHERE locked_by IS NULL
    `);

    this.initialized = true;
  }

  async publish(
    brokerName: string,
    id: string,
    delayMs?: number,
    priority?: number,
  ): Promise<void> {
    await this.ensureTable();
    const runAt =
      delayMs && delayMs > 0
        ? new Date(Date.now() + delayMs).toISOString()
        : new Date().toISOString();

    await this.pool.query(
      `INSERT INTO ${this.tableName} (broker_name, id, priority, run_at)
       VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (broker_name, id) DO UPDATE
       SET priority = $3, run_at = $4::timestamptz, locked_by = NULL, locked_until = NULL`,
      [brokerName, id, priority ?? 0, runAt],
    );
  }

  /**
   * Atomic claim using FOR UPDATE SKIP LOCKED.
   * This is the PostgreSQL equivalent of Redis LPOP+SETNX — it atomically
   * selects unlocked rows and marks them as locked, skipping any rows
   * already locked by other workers.
   */
  async claim(
    brokerName: string,
    consumerId: string,
    limit: number,
    lockTtlMs: number,
    strategy: BrokerStrategy = "fifo",
  ): Promise<string[]> {
    await this.ensureTable();
    const lockUntil = new Date(Date.now() + lockTtlMs).toISOString();
    const now = new Date().toISOString();

    // Order clause based on strategy
    let orderBy: string;
    switch (strategy) {
      case "lifo":
        orderBy = "created_at DESC";
        break;
      case "priority":
        orderBy = "priority ASC, created_at ASC";
        break;
      case "fifo":
      default:
        orderBy = "created_at ASC";
        break;
    }

    // Single atomic query: SELECT + UPDATE via CTE
    const result = await this.pool.query(
      `WITH candidates AS (
        SELECT id FROM ${this.tableName}
        WHERE broker_name = $1
          AND run_at <= $2::timestamptz
          AND (locked_by IS NULL OR locked_until < $2::timestamptz)
        ORDER BY ${orderBy}
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${this.tableName} q
      SET locked_by = $4, locked_until = $5::timestamptz
      FROM candidates c
      WHERE q.broker_name = $1 AND q.id = c.id
      RETURNING q.id`,
      [brokerName, now, limit, consumerId, lockUntil],
    );

    return result.rows.map((r: any) => r.id);
  }

  async extendLock(
    id: string,
    consumerId: string,
    lockTtlMs: number,
  ): Promise<void> {
    await this.ensureTable();
    const lockUntil = new Date(Date.now() + lockTtlMs).toISOString();

    const result = await this.pool.query(
      `UPDATE ${this.tableName}
       SET locked_until = $1::timestamptz
       WHERE id = $2 AND locked_by = $3`,
      [lockUntil, id, consumerId],
    );

    if (result.rowCount === 0) {
      throw new Error(`Lock lost or stolen for entity ${id}`);
    }
  }

  async ack(brokerName: string, id: string): Promise<void> {
    await this.ensureTable();
    await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE broker_name = $1 AND id = $2`,
      [brokerName, id],
    );
  }

  async nack(brokerName: string, id: string, delayMs?: number): Promise<void> {
    await this.ensureTable();
    const runAt =
      delayMs && delayMs > 0
        ? new Date(Date.now() + delayMs).toISOString()
        : new Date().toISOString();

    await this.pool.query(
      `UPDATE ${this.tableName}
       SET locked_by = NULL, locked_until = NULL, run_at = $1::timestamptz
       WHERE broker_name = $2 AND id = $3`,
      [runAt, brokerName, id],
    );
  }

  async pause(brokerName: string): Promise<void> {
    // Use a sentinel row to indicate paused state
    await this.ensureTable();
    await this.pool.query(
      `INSERT INTO ${this.tableName} (broker_name, id, priority, locked_by)
       VALUES ($1, '__paused__', -1, '__system__')
       ON CONFLICT (broker_name, id) DO NOTHING`,
      [brokerName],
    );
  }

  async resume(brokerName: string): Promise<void> {
    await this.ensureTable();
    await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE broker_name = $1 AND id = '__paused__'`,
      [brokerName],
    );
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type DbInstance = Database.Database;

let dbInstance: DbInstance | null = null;

export function createDatabase(dbPath?: string): DbInstance {
  const resolvedPath = dbPath ?? process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'shopping-list.db');

  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolvedPath);
  if (resolvedPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  initializeSchema(db);
  return db;
}

export function initializeSchema(db: DbInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE,
      password_hash TEXT,
      api_key_hash TEXT UNIQUE NOT NULL,
      api_key_prefix TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      can_manage_users INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled', 'revoked')),
      invited_by TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invite_tokens (
      token TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      grants_manage_users INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      max_uses INTEGER NOT NULL DEFAULT 10,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shopping_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      quantity TEXT NOT NULL DEFAULT '1',
      notes TEXT NOT NULL DEFAULT '',
      store_id TEXT,
      store_name TEXT NOT NULL DEFAULT 'General',
      image_data TEXT,
      checked INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_by_name TEXT NOT NULL DEFAULT 'User',
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shopping_items_store ON shopping_items(store_name);
    CREATE INDEX IF NOT EXISTS idx_shopping_items_checked ON shopping_items(checked);
    CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash);
  `);

  // Ensure new columns exist on previously created databases
  const userColumns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!userColumns.some((col) => col.name === 'can_manage_users')) {
    db.exec('ALTER TABLE users ADD COLUMN can_manage_users INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      UPDATE users
      SET can_manage_users = 1
      WHERE username = 'shopping_admin'
         OR invited_by IN (SELECT id FROM users WHERE username = 'shopping_admin')
    `);
  }

  const inviteColumns = db
    .prepare('PRAGMA table_info(invite_tokens)')
    .all() as Array<{ name: string }>;
  if (!inviteColumns.some((col) => col.name === 'grants_manage_users')) {
    db.exec('ALTER TABLE invite_tokens ADD COLUMN grants_manage_users INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      UPDATE invite_tokens
      SET grants_manage_users = 1
      WHERE created_by IN (SELECT id FROM users WHERE username = 'shopping_admin')
    `);
  }

  // Seed initial default stores if none exist
  const countRow = db.prepare('SELECT COUNT(*) as count FROM stores').get() as { count: number };
  if (countRow.count === 0) {
    const now = new Date().toISOString();
    const insertStore = db.prepare(
      'INSERT OR IGNORE INTO stores (id, name, created_by, created_at) VALUES (?, ?, ?, ?)'
    );
    const defaultStores = ['Supermarket', 'Farmers Market', 'Hardware Store', 'Pharmacy'];
    for (const storeName of defaultStores) {
      insertStore.run(crypto.randomUUID(), storeName, 'system', now);
    }
  }
}

export function getDb(): DbInstance {
  if (!dbInstance) {
    dbInstance = createDatabase();
  }
  return dbInstance;
}

export function setDb(db: DbInstance): void {
  dbInstance = db;
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore close errors if already closed
    }
    dbInstance = null;
  }
}

export function checkDbReady(db: DbInstance = getDb()): boolean {
  try {
    const row = db.prepare('SELECT 1 as ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

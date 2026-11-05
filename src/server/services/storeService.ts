import crypto from 'node:crypto';
import type { DbInstance } from '../db/database.js';
import { NotFoundError, ValidationError } from '../errors/AppError.js';

export interface StoreRecord {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
}

export interface StoreDTO {
  id: string;
  name: string;
  createdBy: string | null;
  createdAt: string;
}

export function toStoreDTO(row: StoreRecord): StoreDTO {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function listStores(db: DbInstance): StoreDTO[] {
  const rows = db
    .prepare('SELECT * FROM stores ORDER BY name COLLATE NOCASE ASC')
    .all() as StoreRecord[];
  return rows.map(toStoreDTO);
}

export function getStoreById(db: DbInstance, storeId: string): StoreDTO {
  const row = db
    .prepare('SELECT * FROM stores WHERE id = ?')
    .get(storeId) as StoreRecord | undefined;
  if (!row) {
    throw new NotFoundError('Store');
  }
  return toStoreDTO(row);
}

export function findOrCreateStore(
  db: DbInstance,
  rawName: string,
  userId?: string
): { store: StoreDTO; created: boolean } {
  const name = (rawName ?? '').trim();
  if (name.length < 1 || name.length > 80) {
    throw new ValidationError('Store name must be between 1 and 80 characters', [
      { field: 'name', message: 'Store name must be between 1 and 80 characters' },
    ]);
  }

  const existing = db
    .prepare('SELECT * FROM stores WHERE name = ? COLLATE NOCASE')
    .get(name) as StoreRecord | undefined;

  if (existing) {
    return { store: toStoreDTO(existing), created: false };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO stores (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    userId ?? 'system',
    now
  );

  const created = db.prepare('SELECT * FROM stores WHERE id = ?').get(id) as StoreRecord;
  return { store: toStoreDTO(created), created: true };
}

import crypto from 'node:crypto';
import type { DbInstance } from '../db/database.js';
import { NotFoundError, ValidationError } from '../errors/AppError.js';
import { findOrCreateStore, getStoreById } from './storeService.js';
import type { PublicUser } from './authService.js';

export interface ShoppingItemRecord {
  id: string;
  name: string;
  quantity: string;
  notes: string;
  store_id: string | null;
  store_name: string;
  image_data: string | null;
  checked: number;
  created_by: string | null;
  created_by_name: string;
  updated_at: string;
  created_at: string;
}

export interface ShoppingItemDTO {
  id: string;
  name: string;
  quantity: string;
  notes: string;
  storeId: string | null;
  storeName: string;
  imageData: string | null;
  checked: boolean;
  createdBy: string | null;
  createdByName: string;
  updatedAt: string;
  createdAt: string;
}

export interface CreateItemInput {
  id?: string;
  name: string;
  quantity?: string;
  notes?: string;
  storeId?: string | null;
  storeName?: string | null;
  imageData?: string | null;
  checked?: boolean;
}

export interface UpdateItemInput {
  name?: string;
  quantity?: string;
  notes?: string;
  storeId?: string | null;
  storeName?: string | null;
  imageData?: string | null;
  checked?: boolean;
}

export interface OfflineMutation {
  type: 'create' | 'update' | 'delete';
  itemId: string;
  payload?: Partial<CreateItemInput> & UpdateItemInput;
  timestamp?: string;
}

const VALID_IMAGE_DATA_REGEX = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;
const MAX_IMAGE_LENGTH = 7_000_000; // ~5MB binary image encoded in base64

export function toItemDTO(row: ShoppingItemRecord): ShoppingItemDTO {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    notes: row.notes,
    storeId: row.store_id,
    storeName: row.store_name,
    imageData: row.image_data,
    checked: row.checked === 1,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function validateImageData(imageData: string | null | undefined): string | null {
  if (imageData === undefined || imageData === null || imageData.trim() === '') {
    return null;
  }
  const trimmed = imageData.trim();
  if (trimmed.length > MAX_IMAGE_LENGTH) {
    throw new ValidationError('Attached picture exceeds maximum allowed size (5MB)', [
      { field: 'imageData', message: 'Image size exceeds 5MB limit' },
    ]);
  }
  if (!VALID_IMAGE_DATA_REGEX.test(trimmed)) {
    throw new ValidationError('Attached picture must be a valid base64 image data URI', [
      { field: 'imageData', message: 'Invalid image format; expected data:image/*;base64,...' },
    ]);
  }
  return trimmed;
}

function resolveStore(
  db: DbInstance,
  storeId: string | null | undefined,
  storeName: string | null | undefined,
  userId?: string
): { storeId: string | null; storeName: string } {
  if (storeName && storeName.trim() !== '') {
    const { store } = findOrCreateStore(db, storeName.trim(), userId);
    return { storeId: store.id, storeName: store.name };
  }
  if (storeId && storeId.trim() !== '') {
    const store = getStoreById(db, storeId.trim());
    return { storeId: store.id, storeName: store.name };
  }
  const { store } = findOrCreateStore(db, 'Supermarket', userId);
  return { storeId: store.id, storeName: store.name };
}

export function listItems(
  db: DbInstance,
  filters?: { storeName?: string; checked?: boolean }
): ShoppingItemDTO[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.storeName && filters.storeName.trim() !== '') {
    conditions.push('store_name = ? COLLATE NOCASE');
    params.push(filters.storeName.trim());
  }

  if (typeof filters?.checked === 'boolean') {
    conditions.push('checked = ?');
    params.push(filters.checked ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM shopping_items ${whereClause} ORDER BY checked ASC, updated_at DESC`
    )
    .all(...params) as ShoppingItemRecord[];

  return rows.map(toItemDTO);
}

export function getItemById(db: DbInstance, itemId: string): ShoppingItemDTO {
  const row = db
    .prepare('SELECT * FROM shopping_items WHERE id = ?')
    .get(itemId) as ShoppingItemRecord | undefined;
  if (!row) {
    throw new NotFoundError('Shopping item');
  }
  return toItemDTO(row);
}

export function createItem(
  db: DbInstance,
  input: CreateItemInput,
  user: PublicUser
): ShoppingItemDTO {
  const name = (input.name ?? '').trim();
  if (name.length < 1 || name.length > 150) {
    throw new ValidationError('Item name must be between 1 and 150 characters', [
      { field: 'name', message: 'Item name must be between 1 and 150 characters' },
    ]);
  }

  const quantity = (input.quantity ?? '1').trim() || '1';
  if (quantity.length > 50) {
    throw new ValidationError('Quantity must be 50 characters or fewer', [
      { field: 'quantity', message: 'Quantity must be 50 characters or fewer' },
    ]);
  }

  const notes = (input.notes ?? '').trim();
  if (notes.length > 500) {
    throw new ValidationError('Notes must be 500 characters or fewer', [
      { field: 'notes', message: 'Notes must be 500 characters or fewer' },
    ]);
  }

  const validImage = validateImageData(input.imageData);
  const { storeId, storeName } = resolveStore(db, input.storeId, input.storeName, user.id);

  const id = input.id && input.id.trim() !== '' ? input.id.trim() : crypto.randomUUID();
  const now = new Date().toISOString();
  const checked = input.checked ? 1 : 0;

  db.prepare(
    `INSERT INTO shopping_items (
      id, name, quantity, notes, store_id, store_name, image_data,
      checked, created_by, created_by_name, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      quantity = excluded.quantity,
      notes = excluded.notes,
      store_id = excluded.store_id,
      store_name = excluded.store_name,
      image_data = COALESCE(excluded.image_data, shopping_items.image_data),
      checked = excluded.checked,
      updated_at = excluded.updated_at`
  ).run(
    id,
    name,
    quantity,
    notes,
    storeId,
    storeName,
    validImage,
    checked,
    user.id,
    user.name,
    now,
    now
  );

  return getItemById(db, id);
}

export function updateItem(
  db: DbInstance,
  itemId: string,
  input: UpdateItemInput,
  user: PublicUser
): ShoppingItemDTO {
  const existing = db
    .prepare('SELECT * FROM shopping_items WHERE id = ?')
    .get(itemId) as ShoppingItemRecord | undefined;

  if (!existing) {
    throw new NotFoundError('Shopping item');
  }

  let name = existing.name;
  if (input.name !== undefined) {
    name = input.name.trim();
    if (name.length < 1 || name.length > 150) {
      throw new ValidationError('Item name must be between 1 and 150 characters', [
        { field: 'name', message: 'Item name must be between 1 and 150 characters' },
      ]);
    }
  }

  let quantity = existing.quantity;
  if (input.quantity !== undefined) {
    quantity = input.quantity.trim() || '1';
  }

  let notes = existing.notes;
  if (input.notes !== undefined) {
    notes = input.notes.trim();
  }

  let storeId = existing.store_id;
  let storeName = existing.store_name;
  if (input.storeName !== undefined || input.storeId !== undefined) {
    const resolved = resolveStore(db, input.storeId, input.storeName, user.id);
    storeId = resolved.storeId;
    storeName = resolved.storeName;
  }

  let imageData = existing.image_data;
  if (input.imageData !== undefined) {
    imageData = validateImageData(input.imageData);
  }

  const checked =
    input.checked !== undefined ? (input.checked ? 1 : 0) : existing.checked;
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE shopping_items
     SET name = ?, quantity = ?, notes = ?, store_id = ?, store_name = ?,
         image_data = ?, checked = ?, updated_at = ?
     WHERE id = ?`
  ).run(name, quantity, notes, storeId, storeName, imageData, checked, now, itemId);

  return getItemById(db, itemId);
}

export function deleteItem(db: DbInstance, itemId: string): void {
  const result = db.prepare('DELETE FROM shopping_items WHERE id = ?').run(itemId);
  if (result.changes === 0) {
    throw new NotFoundError('Shopping item');
  }
}

export function syncOfflineMutations(
  db: DbInstance,
  mutations: OfflineMutation[],
  user: PublicUser
): { applied: number; items: ShoppingItemDTO[] } {
  let applied = 0;

  const tx = db.transaction(() => {
    for (const mutation of mutations) {
      if (mutation.type === 'create' && mutation.payload) {
        createItem(
          db,
          {
            ...mutation.payload,
            name: mutation.payload.name ?? '',
            id: mutation.itemId || mutation.payload.id,
          },
          user
        );
        applied++;
      } else if (mutation.type === 'update' && mutation.payload && mutation.itemId) {
        const exists = db
          .prepare('SELECT id FROM shopping_items WHERE id = ?')
          .get(mutation.itemId);
        if (exists) {
          updateItem(db, mutation.itemId, mutation.payload, user);
          applied++;
        } else if (mutation.payload.name) {
          createItem(
            db,
            {
              ...mutation.payload,
              id: mutation.itemId,
              name: mutation.payload.name,
            },
            user
          );
          applied++;
        }
      } else if (mutation.type === 'delete' && mutation.itemId) {
        db.prepare('DELETE FROM shopping_items WHERE id = ?').run(mutation.itemId);
        applied++;
      }
    }
  });

  tx();

  return {
    applied,
    items: listItems(db),
  };
}

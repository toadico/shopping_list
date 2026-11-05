import type { DbInstance } from '../db/database.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors/AppError.js';
import { toPublicUser, type PublicUser, type UserRecord } from './authService.js';

export function listUsers(db: DbInstance): PublicUser[] {
  const rows = db
    .prepare('SELECT * FROM users ORDER BY CASE WHEN role = \'admin\' THEN 0 ELSE 1 END, created_at DESC')
    .all() as UserRecord[];
  return rows.map(toPublicUser);
}

export function getUserById(db: DbInstance, userId: string): PublicUser {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRecord | undefined;
  if (!row) {
    throw new NotFoundError('User');
  }
  return toPublicUser(row);
}

export function updateUserStatus(
  db: DbInstance,
  userId: string,
  status: 'active' | 'disabled' | 'revoked'
): PublicUser {
  if (!['active', 'disabled', 'revoked'].includes(status)) {
    throw new ValidationError('Status must be active, disabled, or revoked', [
      { field: 'status', message: 'Invalid user status' },
    ]);
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
    | UserRecord
    | undefined;
  if (!target) {
    throw new NotFoundError('User');
  }

  if (target.username === 'shopping_admin' || target.role === 'admin') {
    throw new ConflictError('Cannot disable or revoke the primary shopping_admin account');
  }

  if (target.status === 'revoked' && status !== 'revoked') {
    throw new ConflictError('A revoked user API key cannot be re-enabled');
  }

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRecord;
  return toPublicUser(updated);
}

export function revokeUserAccess(db: DbInstance, userId: string): PublicUser {
  return updateUserStatus(db, userId, 'revoked');
}

export function deleteUser(db: DbInstance, userId: string): void {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
    | UserRecord
    | undefined;
  if (!target) {
    throw new NotFoundError('User');
  }

  if (target.username === 'shopping_admin' || target.role === 'admin') {
    throw new ConflictError('Cannot delete the primary shopping_admin account');
  }

  if (target.status !== 'revoked') {
    throw new ConflictError('Only users with a revoked API key can be deleted');
  }

  db.prepare('UPDATE invite_tokens SET revoked = 1 WHERE created_by = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

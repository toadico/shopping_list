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

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRecord;
  return toPublicUser(updated);
}

export function revokeUserAccess(db: DbInstance, userId: string): PublicUser {
  return updateUserStatus(db, userId, 'revoked');
}

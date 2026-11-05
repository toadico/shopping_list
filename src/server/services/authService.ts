import crypto from 'node:crypto';
import QRCode from 'qrcode';
import type { DbInstance } from '../db/database.js';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../errors/AppError.js';

export interface UserRecord {
  id: string;
  name: string;
  username: string | null;
  password_hash: string | null;
  api_key_hash: string;
  api_key_prefix: string;
  role: 'admin' | 'user';
  can_manage_users: number;
  status: 'active' | 'disabled' | 'revoked';
  invited_by: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface PublicUser {
  id: string;
  name: string;
  username: string | null;
  apiKeyPrefix: string;
  role: 'admin' | 'user';
  canManageUsers: boolean;
  status: 'active' | 'disabled' | 'revoked';
  invitedBy: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface InviteInfo {
  token: string;
  inviteUrl: string;
  qrCodeDataUrl: string;
  createdByName: string;
  grantsManageUsers: boolean;
  expiresAt: string;
}

export function toPublicUser(row: UserRecord): PublicUser {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    apiKeyPrefix: row.api_key_prefix,
    role: row.role,
    canManageUsers: row.role === 'admin' || row.can_manage_users === 1,
    status: row.status,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export function generateApiKey(): string {
  return `slk_${crypto.randomBytes(24).toString('hex')}`;
}

export function generateRandomAdminPassword(): string {
  // 20-char high-entropy alphanumeric password
  return crypto.randomBytes(15).toString('base64url').slice(0, 20);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) {
    return false;
  }
  const [salt, keyHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, keyBuf);
}

/**
 * Ensures the initial user "shopping_admin" exists.
 * On first container start, sets a random password and persists it in SQLite.
 * Returns the admin password so the container startup can log it to stdout console only.
 */
export function bootstrapAdminAccount(db: DbInstance): {
  username: string;
  password: string;
  created: boolean;
} {
  const now = new Date().toISOString();

  const existingConfig = db
    .prepare('SELECT value FROM system_config WHERE key = ?')
    .get('admin_console_password') as { value: string } | undefined;

  const existingAdmin = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get('shopping_admin') as UserRecord | undefined;

  if (existingAdmin && existingConfig) {
    return {
      username: 'shopping_admin',
      password: existingConfig.value,
      created: false,
    };
  }

  const password = existingConfig?.value ?? generateRandomAdminPassword();
  const passwordHash = hashPassword(password);
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const apiKeyPrefix = apiKey.slice(0, 10);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO system_config (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run('admin_console_password', password, now);

    if (!existingAdmin) {
      db.prepare(
        `INSERT INTO users (
          id, name, username, password_hash, api_key_hash, api_key_prefix,
          role, can_manage_users, status, invited_by, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'admin', 1, 'active', 'system', ?, ?)`
      ).run(
        crypto.randomUUID(),
        'Shopping Administrator',
        'shopping_admin',
        passwordHash,
        apiKeyHash,
        apiKeyPrefix,
        now,
        now
      );
    } else {
      db.prepare('UPDATE users SET password_hash = ?, can_manage_users = 1, status = ? WHERE id = ?').run(
        passwordHash,
        'active',
        existingAdmin.id
      );
    }
  });

  tx();

  return {
    username: 'shopping_admin',
    password,
    created: true,
  };
}

export function printAdminPasswordBanner(password: string): void {
  const border = '='.repeat(68);
  process.stdout.write(
    `\n${border}\n` +
      `  SHARED SHOPPING LIST — CONTAINER CONSOLE ADMIN CREDENTIALS\n` +
      `${border}\n` +
      `  Initial Admin Username : shopping_admin\n` +
      `  Initial Admin Password : ${password}\n` +
      `${border}\n\n`
  );
}

export function loginAdmin(
  db: DbInstance,
  username: string,
  password: string
): { user: PublicUser; apiKey: string } {
  if (!username || !password) {
    throw new ValidationError('Username and password are required');
  }

  if (username !== 'shopping_admin') {
    throw new UnauthorizedError('Only shopping_admin may log in with a username and password');
  }

  const admin = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get('shopping_admin') as UserRecord | undefined;

  if (!admin || !admin.password_hash || !verifyPassword(password, admin.password_hash)) {
    throw new UnauthorizedError('Invalid username or password');
  }

  const newApiKey = generateApiKey();
  const apiKeyHash = hashApiKey(newApiKey);
  const apiKeyPrefix = newApiKey.slice(0, 10);
  const now = new Date().toISOString();

  db.prepare(
    'UPDATE users SET api_key_hash = ?, api_key_prefix = ?, last_seen_at = ? WHERE id = ?'
  ).run(apiKeyHash, apiKeyPrefix, now, admin.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(admin.id) as UserRecord;
  return {
    user: toPublicUser(updated),
    apiKey: newApiKey,
  };
}

export function authenticateByApiKey(db: DbInstance, rawApiKey?: string): PublicUser {
  if (!rawApiKey || typeof rawApiKey !== 'string' || rawApiKey.trim() === '') {
    throw new UnauthorizedError('API key is required');
  }

  const cleanKey = rawApiKey.trim();
  const keyHash = hashApiKey(cleanKey);

  const user = db
    .prepare('SELECT * FROM users WHERE api_key_hash = ?')
    .get(keyHash) as UserRecord | undefined;

  if (!user) {
    throw new UnauthorizedError('Invalid or unrecognized API key');
  }

  if (user.status === 'disabled') {
    throw new ForbiddenError('Your account has been disabled by the administrator');
  }

  if (user.status === 'revoked') {
    throw new ForbiddenError('Your API key access has been revoked by the administrator');
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, user.id);
  user.last_seen_at = now;

  return toPublicUser(user);
}

export async function createInviteQr(
  db: DbInstance,
  creator: PublicUser,
  baseUrl: string,
  maxUses = 10
): Promise<InviteInfo> {
  const token = crypto.randomBytes(24).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  // Only the shopping_admin account can pass user-management rights via QR code.
  // Users who scan from any other user cannot manage the users list, even if that
  // user has user-management privileges.
  const grantsManageUsers = creator.username === 'shopping_admin' ? 1 : 0;

  db.prepare(
    `INSERT INTO invite_tokens (
      token, created_by, created_by_name, grants_manage_users,
      expires_at, used_count, max_uses, revoked, created_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?)`
  ).run(
    token,
    creator.id,
    creator.name,
    grantsManageUsers,
    expiresAt,
    maxUses,
    now.toISOString()
  );

  const normalizedBase = baseUrl.replace(/\/$/, '');
  const inviteUrl = `${normalizedBase}/?invite=${encodeURIComponent(token)}`;
  const qrCodeDataUrl = await QRCode.toDataURL(inviteUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 300,
  });

  return {
    token,
    inviteUrl,
    qrCodeDataUrl,
    createdByName: creator.name,
    grantsManageUsers: grantsManageUsers === 1,
    expiresAt,
  };
}

export function verifyInviteToken(
  db: DbInstance,
  token: string
): {
  token: string;
  createdByName: string;
  grantsManageUsers: boolean;
  expiresAt: string;
} {
  if (!token || token.trim() === '') {
    throw new ValidationError('Invite token is required');
  }

  const row = db
    .prepare('SELECT * FROM invite_tokens WHERE token = ?')
    .get(token.trim()) as
    | {
        token: string;
        created_by: string;
        created_by_name: string;
        grants_manage_users: number;
        expires_at: string;
        used_count: number;
        max_uses: number;
        revoked: number;
      }
    | undefined;

  if (!row) {
    throw new NotFoundError('Invite token');
  }

  if (row.revoked === 1) {
    throw new ForbiddenError('This invite QR code has been revoked');
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new ForbiddenError('This invite QR code has expired');
  }

  if (row.used_count >= row.max_uses) {
    throw new ForbiddenError('This invite QR code has reached its maximum number of uses');
  }

  return {
    token: row.token,
    createdByName: row.created_by_name,
    grantsManageUsers: row.grants_manage_users === 1,
    expiresAt: row.expires_at,
  };
}

export function redeemInviteToken(
  db: DbInstance,
  token: string,
  name: string
): { user: PublicUser; apiKey: string } {
  const trimmedName = (name ?? '').trim();
  if (trimmedName.length < 2 || trimmedName.length > 60) {
    throw new ValidationError('Name must be between 2 and 60 characters', [
      { field: 'name', message: 'Name must be between 2 and 60 characters' },
    ]);
  }

  // Verify token validity first
  verifyInviteToken(db, token);

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const apiKeyPrefix = apiKey.slice(0, 10);
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const inviteRow = db
      .prepare('SELECT * FROM invite_tokens WHERE token = ?')
      .get(token.trim()) as {
      created_by: string;
      grants_manage_users: number;
      used_count: number;
      max_uses: number;
    };

    if (inviteRow.used_count >= inviteRow.max_uses) {
      throw new ForbiddenError('This invite QR code has reached its maximum number of uses');
    }

    // Verify whether the invite creator is specifically shopping_admin
    const creatorRow = db
      .prepare('SELECT username FROM users WHERE id = ?')
      .get(inviteRow.created_by) as { username: string | null } | undefined;

    const canManageUsers =
      inviteRow.grants_manage_users === 1 && creatorRow?.username === 'shopping_admin' ? 1 : 0;

    db.prepare('UPDATE invite_tokens SET used_count = used_count + 1 WHERE token = ?').run(
      token.trim()
    );

    db.prepare(
      `INSERT INTO users (
        id, name, username, password_hash, api_key_hash, api_key_prefix,
        role, can_manage_users, status, invited_by, created_at, last_seen_at
      ) VALUES (?, ?, NULL, NULL, ?, ?, 'user', ?, 'active', ?, ?, ?)`
    ).run(
      userId,
      trimmedName,
      apiKeyHash,
      apiKeyPrefix,
      canManageUsers,
      inviteRow.created_by,
      now,
      now
    );
  });

  tx();

  const createdUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRecord;
  return {
    user: toPublicUser(createdUser),
    apiKey,
  };
}

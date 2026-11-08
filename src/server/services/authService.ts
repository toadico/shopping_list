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

export function generateApiKey(seedName?: string): string {
  const randomEntropy = crypto.randomBytes(32);
  if (seedName && seedName.trim() !== '') {
    const seededDigest = crypto
      .createHmac('sha256', randomEntropy)
      .update(`${seedName.trim()}:${Date.now()}:${crypto.randomUUID()}`)
      .digest('hex');
    return `slk_${seededDigest.slice(0, 48)}`;
  }
  return `slk_${randomEntropy.subarray(0, 24).toString('hex')}`;
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

interface AdminConsolePasswordState {
  passwordHash: string;
  expiresAt: number;
  failedAttempts: number;
  expired: boolean;
  expiredReason: string | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

const ADMIN_PASSWORD_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ADMIN_PASSWORD_FAILED_ATTEMPTS = 3;

let adminPasswordState: AdminConsolePasswordState | null = null;

export function printAdminPasswordBanner(password: string, expiresAtIso?: string): void {
  const border = '='.repeat(68);
  const expiryDisplay =
    expiresAtIso ??
    (adminPasswordState ? new Date(adminPasswordState.expiresAt).toISOString() : '30 minutes from start');
  process.stdout.write(
    `\n${border}\n` +
      `  SHARED SHOPPING LIST — CONTAINER CONSOLE ADMIN CREDENTIALS\n` +
      `${border}\n` +
      `  Initial Admin Username : shopping_admin\n` +
      `  Initial Admin Password : ${password}\n` +
      `  Password Policy        : 1 correct use | max 3 failed attempts | 30m TTL\n` +
      `  Password Expires At    : ${expiryDisplay}\n` +
      `${border}\n\n`
  );
}

export function printAdminPasswordExpiredNotice(reason: string): void {
  const border = '='.repeat(68);
  process.stdout.write(
    `\n${border}\n` +
      `  SHARED SHOPPING LIST — shopping_admin CONSOLE PASSWORD EXPIRED\n` +
      `${border}\n` +
      `  Status     : EXPIRED (${reason})\n` +
      `  Expired At : ${new Date().toISOString()}\n` +
      `  Note       : The shopping_admin API key remains active.\n` +
      `               Restart the container if you need a new console password.\n` +
      `${border}\n\n`
  );
}

export function expireAdminConsolePassword(reason: string): void {
  if (!adminPasswordState || adminPasswordState.expired) {
    return;
  }
  if (adminPasswordState.expiryTimer) {
    clearTimeout(adminPasswordState.expiryTimer);
    adminPasswordState.expiryTimer = null;
  }
  adminPasswordState.expired = true;
  adminPasswordState.expiredReason = reason;
  adminPasswordState.passwordHash = '';
  printAdminPasswordExpiredNotice(reason);
}

/**
 * Ensures the initial user "shopping_admin" exists in SQLite (with NO password stored in DB)
 * and generates a fresh ephemeral console password in memory that expires after:
 * - 1 correct use
 * - 3 incorrect attempts
 * - 30 minutes after container startup
 */
export function bootstrapAdminAccount(
  db: DbInstance,
  ttlMs = ADMIN_PASSWORD_TTL_MS
): {
  username: string;
  password: string;
  expiresAt: string;
  created: boolean;
} {
  const now = new Date().toISOString();

  if (adminPasswordState?.expiryTimer) {
    clearTimeout(adminPasswordState.expiryTimer);
  }

  // Generate fresh ephemeral password in memory only (never stored in SQLite)
  const password = generateRandomAdminPassword();
  const passwordHash = hashPassword(password);
  const expiresAtMs = Date.now() + ttlMs;
  const expiresAtIso = new Date(expiresAtMs).toISOString();

  const expiryTimer = setTimeout(() => {
    expireAdminConsolePassword('30-minute container startup timeout');
  }, ttlMs);
  expiryTimer.unref();

  adminPasswordState = {
    passwordHash,
    expiresAt: expiresAtMs,
    failedAttempts: 0,
    expired: false,
    expiredReason: null,
    expiryTimer,
  };

  const existingAdmin = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get('shopping_admin') as UserRecord | undefined;

  const tx = db.transaction(() => {
    // Ensure no admin password is stored in system_config or users table
    db.prepare('DELETE FROM system_config WHERE key = ?').run('admin_console_password');

    const startupKey = generateApiKey('shopping_admin');
    const startupKeyHash = hashApiKey(startupKey);
    const startupKeyPrefix = 'password';

    if (!existingAdmin) {
      db.prepare(
        `INSERT INTO users (
          id, name, username, password_hash, api_key_hash, api_key_prefix,
          role, can_manage_users, status, invited_by, created_at, last_seen_at
        ) VALUES (?, ?, ?, NULL, ?, ?, 'admin', 1, 'active', 'system', ?, ?)`
      ).run(
        crypto.randomUUID(),
        'Shopping Administrator',
        'shopping_admin',
        startupKeyHash,
        startupKeyPrefix,
        now,
        now
      );
    } else {
      db.prepare(
        'UPDATE users SET password_hash = NULL, api_key_hash = ?, api_key_prefix = ?, can_manage_users = 1, status = ? WHERE id = ?'
      ).run(startupKeyHash, startupKeyPrefix, 'active', existingAdmin.id);
    }
  });

  tx();

  return {
    username: 'shopping_admin',
    password,
    expiresAt: expiresAtIso,
    created: !existingAdmin,
  };
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

  if (!adminPasswordState) {
    throw new UnauthorizedError('Admin console password is not active. Restart the container.');
  }

  if (!adminPasswordState.expired && Date.now() >= adminPasswordState.expiresAt) {
    expireAdminConsolePassword('30-minute container startup timeout');
  }

  if (adminPasswordState.expired) {
    throw new UnauthorizedError(
      `The shopping_admin console password has expired (${adminPasswordState.expiredReason}). Restart the container to generate a new console password.`
    );
  }

  const admin = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get('shopping_admin') as UserRecord | undefined;

  if (!admin) {
    throw new UnauthorizedError('Admin account not found');
  }

  const isPasswordValid = verifyPassword(password, adminPasswordState.passwordHash);
  if (!isPasswordValid) {
    adminPasswordState.failedAttempts += 1;
    if (adminPasswordState.failedAttempts >= MAX_ADMIN_PASSWORD_FAILED_ATTEMPTS) {
      expireAdminConsolePassword('3 incorrect login attempts');
      throw new UnauthorizedError(
        'The shopping_admin console password has expired after 3 incorrect attempts. Restart the container to generate a new console password.'
      );
    }
    throw new UnauthorizedError('Invalid username or password');
  }

  // Expire the console password immediately after 1 correct use
  expireAdminConsolePassword('1 correct login use');

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
  baseUrl: string
): Promise<InviteInfo> {
  const token = crypto.randomBytes(24).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString(); // 30 minutes
  const maxUses = 1; // Single-use invite

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

  const apiKey = generateApiKey(trimmedName);
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

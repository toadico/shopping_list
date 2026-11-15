import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, type DbInstance } from '../../src/server/db/database.js';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../src/server/errors/AppError.js';
import {
  authenticateByApiKey,
  bootstrapAdminAccount,
  createInviteQr,
  loginAdmin,
  printAdminPasswordBanner,
  redeemInviteToken,
  verifyInviteToken,
} from '../../src/server/services/authService.js';
import {
  deleteUser,
  listUsers,
  revokeUserAccess,
  updateUserStatus,
} from '../../src/server/services/userService.js';
import { findOrCreateStore, listStores } from '../../src/server/services/storeService.js';
import {
  createItem,
  deleteItem,
  listItems,
  syncOfflineMutations,
  updateItem,
} from '../../src/server/services/itemService.js';
import {
  addSseClient,
  broadcastEvent,
  closeAllSseClients,
  disconnectUserSseClients,
} from '../../src/server/services/eventHub.js';
import type { Response } from 'express';

describe('Unit Tests: Error Hierarchy & Domain Services', () => {
  let db: DbInstance;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('Custom Error Hierarchy', () => {
    it('constructs AppError subclasses with expected HTTP status codes and codes', () => {
      const base = new AppError('Something failed', 500, 'INTERNAL_ERROR');
      expect(base.statusCode).toBe(500);
      expect(base.isOperational).toBe(true);

      const validation = new ValidationError('Invalid field', [
        { field: 'name', message: 'Required' },
      ]);
      expect(validation.statusCode).toBe(400);
      expect(validation.code).toBe('VALIDATION_ERROR');
      expect(validation.details).toHaveLength(1);

      expect(new UnauthorizedError().statusCode).toBe(401);
      expect(new ForbiddenError().statusCode).toBe(403);
      expect(new NotFoundError('Item').statusCode).toBe(404);
      expect(new ConflictError().statusCode).toBe(409);
    });
  });

  describe('Admin Bootstrap & Console Password Lifecycle', () => {
    it('never stores the password in SQLite, expires after 1 correct use (while keeping API key active), and logs expiration to console', () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const boot = bootstrapAdminAccount(db);
        expect(boot.username).toBe('shopping_admin');
        expect(boot.created).toBe(true);
        expect(boot.password.length).toBeGreaterThanOrEqual(16);

        // 1. Verify password is NOT stored anywhere in SQLite
        const configRow = db
          .prepare('SELECT * FROM system_config WHERE key = ?')
          .get('admin_console_password');
        expect(configRow).toBeUndefined();

        const adminRow = db
          .prepare('SELECT password_hash FROM users WHERE username = ?')
          .get('shopping_admin') as { password_hash: string | null };
        expect(adminRow.password_hash).toBeNull();

        // 2. First correct use succeeds and expires the console password immediately
        const loginResult = loginAdmin(db, 'shopping_admin', boot.password);
        expect(loginResult.user.username).toBe('shopping_admin');
        expect(loginResult.user.role).toBe('admin');
        expect(loginResult.apiKey).toMatch(/^slk_/);
        expect(stdoutSpy).toHaveBeenCalledWith(
          expect.stringContaining('EXPIRED (1 correct login use)')
        );

        // Second attempt with the same password fails because it expired after 1 correct use
        expect(() => loginAdmin(db, 'shopping_admin', boot.password)).toThrow(
          /expired/i
        );

        // However, the shopping_admin API key remains active and unaffected
        const authenticatedAdmin = authenticateByApiKey(db, loginResult.apiKey);
        expect(authenticatedAdmin.username).toBe('shopping_admin');
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it('expires the shopping_admin password after 3 incorrect login attempts and logs to console', () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const boot = bootstrapAdminAccount(db);

        expect(() => loginAdmin(db, 'shopping_admin', 'wrong-1')).toThrow(UnauthorizedError);
        expect(() => loginAdmin(db, 'shopping_admin', 'wrong-2')).toThrow(UnauthorizedError);
        expect(() => loginAdmin(db, 'shopping_admin', 'wrong-3')).toThrow(
          /expired after 3 incorrect attempts/i
        );

        expect(stdoutSpy).toHaveBeenCalledWith(
          expect.stringContaining('EXPIRED (3 incorrect login attempts)')
        );

        // Even the valid password is now rejected until container restart
        expect(() => loginAdmin(db, 'shopping_admin', boot.password)).toThrow(/expired/i);
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it('expires the shopping_admin password and API key after the startup timeout and logs to console', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        // Use a short 40ms TTL to verify startup timeout expiration for both password and API key
        const boot = bootstrapAdminAccount(db, 40);
        printAdminPasswordBanner(boot.password, boot.expiresAt);
        expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('shopping_admin'));
        expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining(boot.password));

        const loginResult = loginAdmin(db, 'shopping_admin', boot.password);
        expect(authenticateByApiKey(db, loginResult.apiKey).username).toBe('shopping_admin');

        await new Promise((resolve) => setTimeout(resolve, 60));

        expect(() => loginAdmin(db, 'shopping_admin', boot.password)).toThrow(/expired/i);
        expect(() => authenticateByApiKey(db, loginResult.apiKey)).toThrow(
          /shopping_admin API key has expired/i
        );
      } finally {
        stdoutSpy.mockRestore();
      }
    });
  });

  describe('QR Code Onboarding & User Access Lifecycle', () => {
    it('allows admin or active users to create QR invites, onboard new users, and lets admin disable or revoke access', async () => {
      const { password } = bootstrapAdminAccount(db);
      const { user: adminUser } = loginAdmin(db, 'shopping_admin', password);

      // Admin creates a QR invite (grantsManageUsers = true, expires in 30m, 1 use)
      const beforeCreate = Date.now();
      const invite = await createInviteQr(db, adminUser, 'http://localhost:3000');
      const expiresMs = new Date(invite.expiresAt).getTime() - beforeCreate;
      expect(expiresMs).toBeGreaterThanOrEqual(29 * 60 * 1000);
      expect(expiresMs).toBeLessThanOrEqual(31 * 60 * 1000);
      expect(invite.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(invite.inviteUrl).toContain(`/?invite=${encodeURIComponent(invite.token)}`);
      expect(invite.grantsManageUsers).toBe(true);

      // Verify invite token
      const verified = verifyInviteToken(db, invite.token);
      expect(verified.createdByName).toBe('Shopping Administrator');
      expect(verified.grantsManageUsers).toBe(true);

      // New user 1 joins using shopping_admin's QR invite token -> receives canManageUsers = true
      const beforeJoin = Date.now();
      const joined1 = redeemInviteToken(db, invite.token, 'Alice Shopper');
      expect(joined1.user.name).toBe('Alice Shopper');
      expect(joined1.user.role).toBe('user');
      expect(joined1.user.canManageUsers).toBe(true);
      expect(joined1.apiKey).toMatch(/^slk_/);
      expect(joined1.user.apiKeyExpiresAt).toBeTruthy();
      const initialKeyTtlMs = new Date(joined1.user.apiKeyExpiresAt!).getTime() - beforeJoin;
      expect(initialKeyTtlMs).toBeGreaterThanOrEqual(89 * 24 * 60 * 60 * 1000);
      expect(initialKeyTtlMs).toBeLessThanOrEqual(91 * 24 * 60 * 60 * 1000);

      // Simulate near-expiry (1 day left) and verify accessing the system renews apiKeyExpiresAt back to 90 days
      const oneDayFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      db.prepare('UPDATE users SET api_key_expires_at = ? WHERE id = ?').run(
        oneDayFromNow,
        joined1.user.id
      );
      const renewedUser = authenticateByApiKey(db, joined1.apiKey);
      const renewedTtlMs = new Date(renewedUser.apiKeyExpiresAt!).getTime() - Date.now();
      expect(renewedTtlMs).toBeGreaterThanOrEqual(89 * 24 * 60 * 60 * 1000);

      // Simulate 90 days of inactivity (expired api_key_expires_at) -> rejected with UnauthorizedError
      const expiredIso = new Date(Date.now() - 1000).toISOString();
      db.prepare('UPDATE users SET api_key_expires_at = ? WHERE id = ?').run(
        expiredIso,
        joined1.user.id
      );
      expect(() => authenticateByApiKey(db, joined1.apiKey)).toThrow(
        /expired after 90 days of inactivity/i
      );

      // Restore active 90-day expiry for remaining lifecycle assertions
      db.prepare('UPDATE users SET api_key_expires_at = ? WHERE id = ?').run(
        new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        joined1.user.id
      );

      // Admin's invite is also single-use, so reusing it must fail with ForbiddenError
      expect(() => redeemInviteToken(db, invite.token, 'Second Use')).toThrow(ForbiddenError);

      // Alice (even though she has canManageUsers = true) creates an invite QR code for Bob -> does NOT pass manage users right
      const aliceInvite = await createInviteQr(db, joined1.user, 'http://localhost:3000');
      expect(aliceInvite.grantsManageUsers).toBe(false);
      const joined2 = redeemInviteToken(db, aliceInvite.token, 'Bob Buyer');
      expect(joined2.user.invitedBy).toBe(joined1.user.id);
      expect(joined2.user.canManageUsers).toBe(false);

      // Alice's invite is single-use, so a second redemption must fail with ForbiddenError
      expect(() => redeemInviteToken(db, aliceInvite.token, 'Charlie')).toThrow(ForbiddenError);

      // Admin sees all users
      const allUsers = listUsers(db);
      expect(allUsers.length).toBe(3);

      // Admin disables Alice
      const disabledAlice = updateUserStatus(db, joined1.user.id, 'disabled');
      expect(disabledAlice.status).toBe('disabled');
      expect(() => authenticateByApiKey(db, joined1.apiKey)).toThrow(ForbiddenError);

      // Admin re-enables Alice
      updateUserStatus(db, joined1.user.id, 'active');
      expect(authenticateByApiKey(db, joined1.apiKey).id).toBe(joined1.user.id);

      // Cannot delete an active or disabled user before their API key is revoked
      expect(() => deleteUser(db, joined1.user.id)).toThrow(ConflictError);

      // Admin revokes Alice's API key access
      revokeUserAccess(db, joined1.user.id);
      expect(() => authenticateByApiKey(db, joined1.apiKey)).toThrow(ForbiddenError);

      // Once revoked, Alice's API key cannot be re-enabled or set back to disabled
      expect(() => updateUserStatus(db, joined1.user.id, 'active')).toThrow(ConflictError);
      expect(() => updateUserStatus(db, joined1.user.id, 'disabled')).toThrow(ConflictError);

      // Once revoked, Alice can be deleted
      deleteUser(db, joined1.user.id);
      expect(listUsers(db).some((u) => u.id === joined1.user.id)).toBe(false);

      // Admin cannot disable, revoke, or delete shopping_admin itself
      expect(() => updateUserStatus(db, adminUser.id, 'revoked')).toThrow(ConflictError);
      expect(() => deleteUser(db, adminUser.id)).toThrow(ConflictError);
    });
  });

  describe('Stores & Shopping Items with Inline Store Creation and Pictures', () => {
    it('prevents shopping_admin from creating items while allowing onboarded users to create items, add stores, attach pictures, and sync offline mutations', async () => {
      const { password } = bootstrapAdminAccount(db);
      const { user: adminUser } = loginAdmin(db, 'shopping_admin', password);

      // shopping_admin cannot create items
      expect(() =>
        createItem(db, { name: 'Forbidden Admin Item' }, adminUser)
      ).toThrow(ForbiddenError);

      // Onboard a regular user via QR invite to test shopping list operations
      const invite = await createInviteQr(db, adminUser, 'http://localhost:3000');
      const { user: shopperUser } = redeemInviteToken(db, invite.token, 'Maya Shopper');

      const initialStores = listStores(db);
      expect(initialStores.length).toBeGreaterThanOrEqual(4);

      const sampleBase64Image =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

      // Add item with a brand-new typed store name ("Trader Joe's") and a picture
      const item = createItem(
        db,
        {
          name: 'Everything But The Bagel Seasoning',
          quantity: '2 jars',
          notes: 'Spice aisle',
          storeName: "Trader Joe's",
          imageData: sampleBase64Image,
        },
        shopperUser
      );

      expect(item.name).toBe('Everything But The Bagel Seasoning');
      expect(item.storeName).toBe("Trader Joe's");
      expect(item.imageData).toBe(sampleBase64Image);
      expect(item.checked).toBe(false);

      // Verify "Trader Joe's" is now in the selectable stores list
      const updatedStores = listStores(db);
      expect(updatedStores.some((s) => s.name === "Trader Joe's")).toBe(true);

      // Case-insensitive store deduplication check
      const dupStore = findOrCreateStore(db, "trader joe's", shopperUser.id);
      expect(dupStore.created).toBe(false);

      // Update item to checked
      const checkedItem = updateItem(db, item.id, { checked: true }, shopperUser);
      expect(checkedItem.checked).toBe(true);
      expect(checkedItem.checkedBy).toBe(shopperUser.id);
      expect(checkedItem.checkedByName).toBe('Maya Shopper');
      expect(checkedItem.checkedAt).toBeTruthy();

      // Simulate an older timestamp on the checked item, then re-add it to the unchecked list
      const pastTimestamp = '2020-01-01T00:00:00.000Z';
      db.prepare('UPDATE shopping_items SET created_at = ?, updated_at = ? WHERE id = ?').run(
        pastTimestamp,
        pastTimestamp,
        item.id
      );

      // Re-adding via createItem (e.g. selecting from checked item suggestions) updates both createdAt and updatedAt
      const reAddedItem = createItem(
        db,
        {
          id: item.id,
          name: item.name,
          quantity: '3 jars',
          storeName: item.storeName,
          checked: false,
        },
        shopperUser
      );
      expect(reAddedItem.checked).toBe(false);
      expect(reAddedItem.createdAt).not.toBe(pastTimestamp);
      expect(reAddedItem.updatedAt).not.toBe(pastTimestamp);

      // Checking and then unchecking via updateItem also updates createdAt and updatedAt
      updateItem(db, item.id, { checked: true }, shopperUser);
      db.prepare('UPDATE shopping_items SET created_at = ?, updated_at = ? WHERE id = ?').run(
        pastTimestamp,
        pastTimestamp,
        item.id
      );
      const uncheckedAgain = updateItem(db, item.id, { checked: false }, shopperUser);
      expect(uncheckedAgain.checked).toBe(false);
      expect(uncheckedAgain.createdAt).not.toBe(pastTimestamp);
      expect(uncheckedAgain.updatedAt).not.toBe(pastTimestamp);

      // Batch offline sync mutations
      const syncResult = syncOfflineMutations(
        db,
        [
          {
            type: 'create',
            itemId: 'offline-item-1',
            payload: {
              name: 'Sourdough Bread',
              quantity: '1 loaf',
              storeName: 'Local Bakery',
            },
          },
          {
            type: 'update',
            itemId: 'offline-item-1',
            payload: {
              checked: true,
            },
          },
        ],
        shopperUser
      );

      expect(syncResult.applied).toBe(2);
      const allItems = listItems(db);
      expect(allItems.some((i) => i.id === 'offline-item-1' && i.checked)).toBe(true);

      // Delete item
      deleteItem(db, item.id);
      expect(listItems(db).some((i) => i.id === item.id)).toBe(false);

      // One-time purchase item is automatically deleted when checked and does not remain in checked items
      const oneTimeItem = createItem(
        db,
        {
          name: 'Birthday Candles',
          quantity: '1',
          storeName: 'Supermarket',
          oneTime: true,
        },
        shopperUser
      );
      expect(oneTimeItem.oneTime).toBe(true);
      expect(listItems(db).some((i) => i.id === oneTimeItem.id)).toBe(true);

      const checkedOneTime = updateItem(db, oneTimeItem.id, { checked: true }, shopperUser);
      expect(checkedOneTime.checked).toBe(true);
      expect(checkedOneTime.oneTime).toBe(true);
      expect(listItems(db).some((i) => i.id === oneTimeItem.id)).toBe(false);
    });
  });

  describe('Real-Time Multi-Device Event Hub (SSE)', () => {
    it('broadcasts updates to connected device streams and disconnects revoked users', () => {
      const writes1: string[] = [];
      const writes2: string[] = [];
      let ended1 = false;

      const mockRes1 = {
        write: (chunk: string) => {
          writes1.push(chunk);
          return true;
        },
        end: () => {
          ended1 = true;
        },
      } as unknown as Response;

      const mockRes2 = {
        write: (chunk: string) => {
          writes2.push(chunk);
          return true;
        },
        end: () => {},
      } as unknown as Response;

      addSseClient('client-1', 'user-1', mockRes1);
      addSseClient('client-2', 'user-2', mockRes2);

      broadcastEvent({
        type: 'items_updated',
        items: [],
        timestamp: new Date().toISOString(),
      });

      expect(writes1).toHaveLength(1);
      expect(writes1[0]).toContain('"type":"items_updated"');
      expect(writes2).toHaveLength(1);

      // Disconnect user-1 (e.g., when admin disables/revokes user-1)
      disconnectUserSseClients('user-1');
      expect(ended1).toBe(true);

      // Subsequent broadcast only goes to user-2
      broadcastEvent({
        type: 'stores_updated',
        stores: [],
        timestamp: new Date().toISOString(),
      });
      expect(writes1).toHaveLength(1);
      expect(writes2).toHaveLength(2);

      closeAllSseClients();
    });
  });
});

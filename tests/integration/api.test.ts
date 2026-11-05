import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createDatabase, setDb, closeDb, type DbInstance } from '../../src/server/db/database.js';
import { bootstrapAdminAccount } from '../../src/server/services/authService.js';
import { createApp } from '../../src/server/app.js';

describe('Integration Tests: Express API Routes, Security & Probes', () => {
  let db: DbInstance;
  let app: Express;
  let adminPassword = '';
  let adminApiKey = '';

  beforeEach(async () => {
    db = createDatabase(':memory:');
    setDb(db);
    const boot = bootstrapAdminAccount(db);
    adminPassword = boot.password;
    app = createApp({ enableRateLimit: false });

    const loginRes = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'shopping_admin', password: adminPassword });

    expect(loginRes.status).toBe(200);
    adminApiKey = loginRes.body.apiKey;
  });

  afterEach(() => {
    closeDb();
  });

  describe('Health & Readiness Probes + Helmet Security Headers', () => {
    it('returns 200 on /healthz and /ready with security headers applied', async () => {
      const healthRes = await request(app).get('/healthz');
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.status).toBe('ok');
      expect(healthRes.headers['x-content-type-options']).toBe('nosniff');
      expect(healthRes.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');

      const readyRes = await request(app).get('/ready');
      expect(readyRes.status).toBe(200);
      expect(readyRes.body.status).toBe('ready');
    });

    it('returns 503 on /healthz and /ready when shutting down', async () => {
      const shuttingDownApp = createApp({
        enableRateLimit: false,
        isShuttingDown: () => true,
      });

      const healthRes = await request(shuttingDownApp).get('/healthz');
      expect(healthRes.status).toBe(503);

      const readyRes = await request(shuttingDownApp).get('/ready');
      expect(readyRes.status).toBe(503);
    });
  });

  describe('Authentication & QR Code Onboarding Flow', () => {
    it('rejects unauthenticated requests to protected routes with 401', async () => {
      const res = await request(app).get('/api/items');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects non-admin username login attempts and wrong admin passwords', async () => {
      const nonAdmin = await request(app)
        .post('/api/auth/admin/login')
        .send({ username: 'some_user', password: adminPassword });
      expect(nonAdmin.status).toBe(401);

      const badPass = await request(app)
        .post('/api/auth/admin/login')
        .send({ username: 'shopping_admin', password: 'wrong-password' });
      expect(badPass.status).toBe(401);
    });

    it('completes full QR invite onboarding and allows existing user to invite another user', async () => {
      // 1. Admin generates QR invite
      const inviteRes = await request(app)
        .post('/api/auth/invites')
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({ baseUrl: 'http://localhost:3000', maxUses: 5 });

      expect(inviteRes.status).toBe(201);
      const token = inviteRes.body.invite.token;
      expect(inviteRes.body.invite.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

      // 2. Publicly verify invite token
      const verifyRes = await request(app).get(`/api/auth/invites/${token}`);
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.invite.token).toBe(token);

      // 3. New user Sarah joins by scanning shopping_admin's QR code -> receives canManageUsers = true
      const joinRes = await request(app)
        .post('/api/auth/join')
        .send({ token, name: 'Sarah Connor' });

      expect(joinRes.status).toBe(201);
      expect(joinRes.body.user.name).toBe('Sarah Connor');
      expect(joinRes.body.user.role).toBe('user');
      expect(joinRes.body.user.canManageUsers).toBe(true);
      const sarahKey = joinRes.body.apiKey;

      // 4. Sarah can access /api/auth/me using X-API-Key or Bearer header
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('X-API-Key', sarahKey);
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.name).toBe('Sarah Connor');
      expect(meRes.body.user.canManageUsers).toBe(true);

      // 5. Sarah (invited by shopping_admin) CAN access /api/users to manage users
      const sarahUsersListRes = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${sarahKey}`);
      expect(sarahUsersListRes.status).toBe(200);

      // 6. Sarah generates a QR code invite for John -> does NOT pass user-management rights
      const sarahInviteRes = await request(app)
        .post('/api/auth/invites')
        .set('Authorization', `Bearer ${sarahKey}`)
        .send({});
      expect(sarahInviteRes.status).toBe(201);
      expect(sarahInviteRes.body.invite.grantsManageUsers).toBe(false);

      const johnJoinRes = await request(app)
        .post('/api/auth/join')
        .send({ token: sarahInviteRes.body.invite.token, name: 'John Connor' });
      expect(johnJoinRes.status).toBe(201);
      expect(johnJoinRes.body.user.canManageUsers).toBe(false);
      const johnKey = johnJoinRes.body.apiKey;

      // 7. John (invited by Sarah, not shopping_admin) CANNOT access /api/users (403 Forbidden)
      const forbiddenUsersRes = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${johnKey}`);
      expect(forbiddenUsersRes.status).toBe(403);

      // 7. Admin can list all users and disable or revoke Sarah's access
      const usersListRes = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(usersListRes.status).toBe(200);
      expect(usersListRes.body.users.length).toBe(3);

      const disableRes = await request(app)
        .patch(`/api/users/${joinRes.body.user.id}/status`)
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({ status: 'disabled' });
      expect(disableRes.status).toBe(200);
      expect(disableRes.body.user.status).toBe('disabled');

      const blockedRes = await request(app)
        .get('/api/items')
        .set('Authorization', `Bearer ${sarahKey}`);
      expect(blockedRes.status).toBe(403);

      // 8. Admin revokes Sarah permanently
      const revokeRes = await request(app)
        .post(`/api/users/${joinRes.body.user.id}/revoke`)
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.user.status).toBe('revoked');
    });
  });

  describe('Stores & Shopping Items CRUD, Picture Attachment, Sanitization & Sync', () => {
    it('supports selectable stores, typing new stores, attaching pictures, sanitizing XSS inputs, and offline sync', async () => {
      // List initial stores
      const storesRes = await request(app)
        .get('/api/stores')
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(storesRes.status).toBe(200);
      expect(storesRes.body.stores.length).toBeGreaterThanOrEqual(4);

      // Add a new store explicitly
      const createStoreRes = await request(app)
        .post('/api/stores')
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({ name: 'Costco Wholesale' });
      expect(createStoreRes.status).toBe(201);
      expect(createStoreRes.body.store.name).toBe('Costco Wholesale');

      const validImage =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

      // Create shopping item with a brand-new typed store ("Whole Foods") + picture + script tag that gets sanitized
      const createItemRes = await request(app)
        .post('/api/items')
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({
          name: 'Avocados <script>alert(1)</script>',
          quantity: '6',
          notes: 'Ripe ones',
          storeName: 'Whole Foods',
          imageData: validImage,
        });

      expect(createItemRes.status).toBe(201);
      expect(createItemRes.body.item.name).toBe('Avocados');
      expect(createItemRes.body.item.storeName).toBe('Whole Foods');
      expect(createItemRes.body.item.imageData).toBe(validImage);

      // Verify "Whole Foods" was automatically added to the selectable stores list
      const storesAfterRes = await request(app)
        .get('/api/stores')
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(
        storesAfterRes.body.stores.some((s: { name: string }) => s.name === 'Whole Foods')
      ).toBe(true);

      // Reject invalid imageData format with 400 ValidationError
      const badImageRes = await request(app)
        .post('/api/items')
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({
          name: 'Apples',
          imageData: 'javascript:alert(1)',
        });
      expect(badImageRes.status).toBe(400);
      expect(badImageRes.body.error.code).toBe('VALIDATION_ERROR');

      // Toggle item checked status via PATCH
      const itemId = createItemRes.body.item.id;
      const patchRes = await request(app)
        .patch(`/api/items/${itemId}`)
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({ checked: true, quantity: '8' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.item.checked).toBe(true);
      expect(patchRes.body.item.quantity).toBe('8');

      // Filter items by storeName
      const filteredRes = await request(app)
        .get('/api/items?storeName=Whole%20Foods')
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(filteredRes.status).toBe(200);
      expect(filteredRes.body.items).toHaveLength(1);

      // Batch sync offline mutations
      const syncRes = await request(app)
        .post('/api/items/sync')
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({
          mutations: [
            {
              type: 'create',
              itemId: 'sync-item-100',
              payload: {
                name: 'Almond Milk',
                quantity: '2',
                storeName: 'Target',
              },
            },
          ],
        });
      expect(syncRes.status).toBe(200);
      expect(syncRes.body.applied).toBe(1);
      expect(
        syncRes.body.items.some((i: { id: string }) => i.id === 'sync-item-100')
      ).toBe(true);

      // Delete item
      const deleteRes = await request(app)
        .delete(`/api/items/${itemId}`)
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(deleteRes.status).toBe(204);

      // Deleting non-existent item returns 404
      const deleteMissingRes = await request(app)
        .delete(`/api/items/${itemId}`)
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(deleteMissingRes.status).toBe(404);
    });

    it('returns 404 NotFoundError for unknown API routes', async () => {
      const res = await request(app)
        .get('/api/non-existent-endpoint')
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});

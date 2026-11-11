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
    expect(loginRes.headers['set-cookie']).toBeUndefined();
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

    it('enforces PUBLIC_BASE_URL host and origin restrictions when configured', async () => {
      const restrictedApp = createApp({
        enableRateLimit: false,
        publicBaseUrl: 'https://shopping.example.com',
      });

      const wrongHostRes = await request(restrictedApp)
        .get('/api/items')
        .set('Host', 'evil.example.com');
      expect(wrongHostRes.status).toBe(403);

      const wrongOriginRes = await request(restrictedApp)
        .get('/api/items')
        .set('Host', 'shopping.example.com')
        .set('Origin', 'https://attacker.example.com');
      expect(wrongOriginRes.status).toBe(403);

      const allowedHostRes = await request(restrictedApp)
        .get('/api/items')
        .set('Host', 'shopping.example.com');
      expect(allowedHostRes.status).toBe(401);
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

    it('rejects non-admin username login attempts, expires password after 1 correct use, and expires after 3 wrong attempts', async () => {
      const nonAdmin = await request(app)
        .post('/api/auth/admin/login')
        .send({ username: 'some_user', password: adminPassword });
      expect(nonAdmin.status).toBe(401);

      // Reusing adminPassword after the 1 successful login in beforeEach is rejected as expired
      const secondUse = await request(app)
        .post('/api/auth/admin/login')
        .send({ username: 'shopping_admin', password: adminPassword });
      expect(secondUse.status).toBe(401);
      expect(secondUse.body.error.message).toMatch(/expired/i);

      // Simulate container restart and verify 3 failed attempts expire the new password
      const restartBoot = bootstrapAdminAccount(db);
      for (let i = 0; i < 3; i++) {
        const badPass = await request(app)
          .post('/api/auth/admin/login')
          .send({ username: 'shopping_admin', password: 'wrong-password' });
        expect(badPass.status).toBe(401);
      }

      const afterThreeFails = await request(app)
        .post('/api/auth/admin/login')
        .send({ username: 'shopping_admin', password: restartBoot.password });
      expect(afterThreeFails.status).toBe(401);
      expect(afterThreeFails.body.error.message).toMatch(/expired/i);
    });

    it('completes full QR invite onboarding and allows existing user to invite another user', async () => {
      // 1. Admin generates QR invite (expires in 30 minutes, 1 use)
      const inviteRes = await request(app)
        .post('/api/auth/invites')
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({ baseUrl: 'http://localhost:3000' });

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

      // Attempting to reuse the same single-use invite token fails with 403 Forbidden
      const reuseInviteRes = await request(app)
        .post('/api/auth/join')
        .send({ token, name: 'Duplicate User' });
      expect(reuseInviteRes.status).toBe(403);
      const setCookieHeader = joinRes.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();
      expect(String(setCookieHeader)).toContain('shopping_list_api_key=');
      expect(String(setCookieHeader)).toContain('HttpOnly');

      // 4. Sarah can access /api/auth/me using the HttpOnly cookie or X-API-Key/Bearer header, while URL ?apiKey= is rejected
      const cookieMeRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `shopping_list_api_key=${sarahKey}`);
      expect(cookieMeRes.status).toBe(200);
      expect(cookieMeRes.body.user.name).toBe('Sarah Connor');

      const urlQueryKeyRes = await request(app).get(
        `/api/auth/me?apiKey=${encodeURIComponent(sarahKey)}`
      );
      expect(urlQueryKeyRes.status).toBe(401);

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

      // Cannot delete a disabled (non-revoked) user
      const prematureDeleteRes = await request(app)
        .delete(`/api/users/${joinRes.body.user.id}`)
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(prematureDeleteRes.status).toBe(409);

      // 8. Admin revokes Sarah permanently
      const revokeRes = await request(app)
        .post(`/api/users/${joinRes.body.user.id}/revoke`)
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.user.status).toBe('revoked');

      // 9. Attempting to re-enable a revoked user's API key is rejected with 409 Conflict
      const reEnableRes = await request(app)
        .patch(`/api/users/${joinRes.body.user.id}/status`)
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({ status: 'active' });
      expect(reEnableRes.status).toBe(409);
      expect(reEnableRes.body.error.message).toMatch(/cannot be re-enabled/i);

      // 10. Once revoked, the user can be deleted
      const deleteUserRes = await request(app)
        .delete(`/api/users/${joinRes.body.user.id}`)
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(deleteUserRes.status).toBe(204);

      const usersAfterDeleteRes = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(usersAfterDeleteRes.status).toBe(200);
      expect(
        usersAfterDeleteRes.body.users.some(
          (u: { id: string }) => u.id === joinRes.body.user.id
        )
      ).toBe(false);
    });
  });

  describe('Stores & Shopping Items CRUD, Picture Attachment, Sanitization & Sync', () => {
    it('blocks shopping_admin from accessing items/stores while supporting selectable stores, pictures, XSS sanitization, and offline sync for onboarded users', async () => {
      // shopping_admin is blocked from accessing /api/items and /api/stores
      const adminGetItemsRes = await request(app)
        .get('/api/items')
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(adminGetItemsRes.status).toBe(403);

      const adminCreateItemRes = await request(app)
        .post('/api/items')
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({ name: 'Milk' });
      expect(adminCreateItemRes.status).toBe(403);

      const adminGetStoresRes = await request(app)
        .get('/api/stores')
        .set('Authorization', `Bearer ${adminApiKey}`);
      expect(adminGetStoresRes.status).toBe(403);

      // Onboard a regular shopper via QR invite
      const inviteRes = await request(app)
        .post('/api/auth/invites')
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({});
      expect(inviteRes.status).toBe(201);

      const joinRes = await request(app)
        .post('/api/auth/join')
        .send({ token: inviteRes.body.invite.token, name: 'Elena Shopper' });
      expect(joinRes.status).toBe(201);
      const shopperApiKey = joinRes.body.apiKey;

      // List initial stores as shopper
      const storesRes = await request(app)
        .get('/api/stores')
        .set('Authorization', `Bearer ${shopperApiKey}`);
      expect(storesRes.status).toBe(200);
      expect(storesRes.body.stores.length).toBeGreaterThanOrEqual(4);

      // Add a new store explicitly
      const createStoreRes = await request(app)
        .post('/api/stores')
        .set('Authorization', `Bearer ${shopperApiKey}`)
        .send({ name: 'Costco Wholesale' });
      expect(createStoreRes.status).toBe(201);
      expect(createStoreRes.body.store.name).toBe('Costco Wholesale');

      const validImage =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

      // Create shopping item with a brand-new typed store ("Whole Foods") + picture + script tag that gets sanitized
      const createItemRes = await request(app)
        .post('/api/items')
        .set('Authorization', `Bearer ${shopperApiKey}`)
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
        .set('Authorization', `Bearer ${shopperApiKey}`);
      expect(
        storesAfterRes.body.stores.some((s: { name: string }) => s.name === 'Whole Foods')
      ).toBe(true);

      // Reject invalid imageData format with 400 ValidationError
      const badImageRes = await request(app)
        .post('/api/items')
        .set('Authorization', `Bearer ${shopperApiKey}`)
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
        .set('Authorization', `Bearer ${shopperApiKey}`)
        .send({ checked: true, quantity: '8' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.item.checked).toBe(true);
      expect(patchRes.body.item.checkedByName).toBe('Elena Shopper');
      expect(patchRes.body.item.checkedAt).toBeTruthy();
      expect(patchRes.body.item.quantity).toBe('8');

      // Filter items by storeName
      const filteredRes = await request(app)
        .get('/api/items?storeName=Whole%20Foods')
        .set('Authorization', `Bearer ${shopperApiKey}`);
      expect(filteredRes.status).toBe(200);
      expect(filteredRes.body.items).toHaveLength(1);

      // Batch sync offline mutations
      const syncRes = await request(app)
        .post('/api/items/sync')
        .set('Authorization', `Bearer ${shopperApiKey}`)
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
        .set('Authorization', `Bearer ${shopperApiKey}`);
      expect(deleteRes.status).toBe(204);

      // Deleting non-existent item returns 404
      const deleteMissingRes = await request(app)
        .delete(`/api/items/${itemId}`)
        .set('Authorization', `Bearer ${shopperApiKey}`);
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

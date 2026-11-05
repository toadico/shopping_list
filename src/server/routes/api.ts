import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/database.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  createInviteQr,
  loginAdmin,
  redeemInviteToken,
  verifyInviteToken,
} from '../services/authService.js';
import {
  listUsers,
  revokeUserAccess,
  updateUserStatus,
} from '../services/userService.js';
import { findOrCreateStore, listStores } from '../services/storeService.js';
import {
  createItem,
  deleteItem,
  listItems,
  syncOfflineMutations,
  updateItem,
} from '../services/itemService.js';
import {
  addSseClient,
  broadcastEvent,
  disconnectUserSseClients,
  removeSseClient,
} from '../services/eventHub.js';

export const apiRouter = Router();

const adminLoginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

const joinSchema = z.object({
  token: z.string().min(1, 'Invite token is required'),
  name: z.string().min(2, 'Name must be at least 2 characters').max(60, 'Name must be 60 characters or fewer'),
});

const createInviteSchema = z.object({
  baseUrl: z.string().url().optional(),
  maxUses: z.number().int().min(1).max(100).optional(),
});

const userStatusSchema = z.object({
  status: z.enum(['active', 'disabled', 'revoked']),
});

const createStoreSchema = z.object({
  name: z.string().min(1, 'Store name is required').max(80, 'Store name must be 80 characters or fewer'),
});

const createItemSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'Item name is required').max(150, 'Item name must be 150 characters or fewer'),
  quantity: z.string().max(50).optional(),
  notes: z.string().max(500).optional(),
  storeId: z.string().nullable().optional(),
  storeName: z.string().max(80).nullable().optional(),
  imageData: z.string().nullable().optional(),
  checked: z.boolean().optional(),
});

const updateItemSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  quantity: z.string().max(50).optional(),
  notes: z.string().max(500).optional(),
  storeId: z.string().nullable().optional(),
  storeName: z.string().max(80).nullable().optional(),
  imageData: z.string().nullable().optional(),
  checked: z.boolean().optional(),
});

const syncMutationsSchema = z.object({
  mutations: z.array(
    z.object({
      type: z.enum(['create', 'update', 'delete']),
      itemId: z.string().min(1),
      payload: z.record(z.unknown()).optional(),
      timestamp: z.string().optional(),
    })
  ),
});

// --- Auth & Onboarding Routes ---

apiRouter.post('/auth/admin/login', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = adminLoginSchema.parse(req.body);
    const result = loginAdmin(getDb(), parsed.username, parsed.password);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/auth/me', requireAuth, (req: Request, res: Response) => {
  res.status(200).json({ user: req.user });
});

apiRouter.post(
  '/auth/invites',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createInviteSchema.parse(req.body ?? {});
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
      const baseUrl = parsed.baseUrl ?? `${protocol}://${host}`;
      const invite = await createInviteQr(getDb(), req.user!, baseUrl, parsed.maxUses ?? 10);
      res.status(201).json({ invite });
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.get('/auth/invites/:token', (req: Request, res: Response, next: NextFunction) => {
  try {
    const info = verifyInviteToken(getDb(), String(req.params.token ?? ''));
    res.status(200).json({ invite: info });
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/auth/join', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = joinSchema.parse(req.body);
    const result = redeemInviteToken(getDb(), parsed.token, parsed.name);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// --- Admin User Management Routes ---

apiRouter.get('/users', requireAuth, requireAdmin, (_req: Request, res: Response, next: NextFunction) => {
  try {
    const users = listUsers(getDb());
    res.status(200).json({ users });
  } catch (err) {
    next(err);
  }
});

apiRouter.patch(
  '/users/:id/status',
  requireAuth,
  requireAdmin,
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = userStatusSchema.parse(req.body);
      const user = updateUserStatus(getDb(), String(req.params.id), parsed.status);
      if (user.status !== 'active') {
        disconnectUserSseClients(user.id);
      }
      res.status(200).json({ user });
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.post(
  '/users/:id/revoke',
  requireAuth,
  requireAdmin,
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = revokeUserAccess(getDb(), String(req.params.id));
      disconnectUserSseClients(user.id);
      res.status(200).json({ user });
    } catch (err) {
      next(err);
    }
  }
);

// --- Real-Time Server-Sent Events (SSE) Stream ---

apiRouter.get('/events', requireAuth, (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const clientId = crypto.randomUUID();
  addSseClient(clientId, req.user!.id, res);

  // Send initial connected event with current items & stores snapshot
  const db = getDb();
  const initialPayload = {
    type: 'connected' as const,
    items: listItems(db),
    stores: listStores(db),
    timestamp: new Date().toISOString(),
  };
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

  req.on('close', () => {
    removeSseClient(clientId);
  });
});

// --- Store Routes ---

apiRouter.get('/stores', requireAuth, (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stores = listStores(getDb());
    res.status(200).json({ stores });
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/stores', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createStoreSchema.parse(req.body);
    const db = getDb();
    const { store, created } = findOrCreateStore(db, parsed.name, req.user!.id);
    if (created) {
      broadcastEvent({
        type: 'stores_updated',
        stores: listStores(db),
        timestamp: new Date().toISOString(),
      });
    }
    res.status(created ? 201 : 200).json({ store, created });
  } catch (err) {
    next(err);
  }
});

// --- Shopping List Item Routes ---

apiRouter.get('/items', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeName = typeof req.query.storeName === 'string' ? req.query.storeName : undefined;
    const checkedParam = req.query.checked;
    const checked =
      checkedParam === 'true' ? true : checkedParam === 'false' ? false : undefined;

    const items = listItems(getDb(), { storeName, checked });
    res.status(200).json({ items });
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/items', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createItemSchema.parse(req.body);
    const db = getDb();
    const item = createItem(db, parsed, req.user!);
    broadcastEvent({
      type: 'items_updated',
      items: listItems(db),
      stores: listStores(db),
      timestamp: new Date().toISOString(),
    });
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

apiRouter.patch('/items/:id', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = updateItemSchema.parse(req.body);
    const db = getDb();
    const item = updateItem(db, String(req.params.id), parsed, req.user!);
    broadcastEvent({
      type: 'items_updated',
      items: listItems(db),
      stores: listStores(db),
      timestamp: new Date().toISOString(),
    });
    res.status(200).json({ item });
  } catch (err) {
    next(err);
  }
});

apiRouter.delete('/items/:id', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    deleteItem(db, String(req.params.id));
    broadcastEvent({
      type: 'items_updated',
      items: listItems(db),
      stores: listStores(db),
      timestamp: new Date().toISOString(),
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/items/sync', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = syncMutationsSchema.parse(req.body);
    const db = getDb();
    const result = syncOfflineMutations(
      db,
      parsed.mutations as Parameters<typeof syncOfflineMutations>[1],
      req.user!
    );
    broadcastEvent({
      type: 'items_updated',
      items: result.items,
      stores: listStores(db),
      timestamp: new Date().toISOString(),
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

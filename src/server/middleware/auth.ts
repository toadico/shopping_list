import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/database.js';
import { authenticateByApiKey, type PublicUser } from '../services/authService.js';
import { ForbiddenError, UnauthorizedError } from '../errors/AppError.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

export function extractApiKey(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim() !== '') {
    return xApiKey.trim();
  }
  const queryApiKey = req.query?.apiKey;
  if (typeof queryApiKey === 'string' && queryApiKey.trim() !== '') {
    return queryApiKey.trim();
  }
  return undefined;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    const apiKey = extractApiKey(req);
    const user = authenticateByApiKey(getDb(), apiKey);
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    if (req.user.role !== 'admin' && !req.user.canManageUsers) {
      throw new ForbiddenError('User management privileges required');
    }
    next();
  } catch (err) {
    next(err);
  }
}

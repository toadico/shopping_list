import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/database.js';
import {
  authenticateByApiKey,
  USER_API_KEY_TTL_MS,
  type PublicUser,
} from '../services/authService.js';
import { ForbiddenError, UnauthorizedError } from '../errors/AppError.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

export const AUTH_COOKIE_NAME = 'shopping_list_api_key';

function parseCookieHeader(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const key = part.slice(0, eqIdx).trim();
    const rawVal = part.slice(eqIdx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(rawVal);
      } catch {
        cookies[key] = rawVal;
      }
    }
  }
  return cookies;
}

export function setAuthCookie(req: Request, res: Response, apiKey: string): void {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(AUTH_COOKIE_NAME, apiKey, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isHttps,
    path: '/',
    maxAge: USER_API_KEY_TTL_MS, // 90 days (automatically renewed on access)
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  });
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
  const cookies = parseCookieHeader(req.headers.cookie);
  const cookieKey = cookies[AUTH_COOKIE_NAME];
  if (typeof cookieKey === 'string' && cookieKey.trim() !== '') {
    return cookieKey.trim();
  }
  return undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    const apiKey = extractApiKey(req);
    const user = authenticateByApiKey(getDb(), apiKey);
    const hasHeaderKey =
      Boolean(req.headers.authorization?.toLowerCase().startsWith('bearer ')) ||
      (typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key'].trim() !== '');
    if (!hasHeaderKey && (user.username === 'shopping_admin' || user.role === 'admin')) {
      throw new UnauthorizedError(
        'The shopping_admin account does not use cookie authentication'
      );
    }
    if (
      !res.headersSent &&
      apiKey &&
      user.role !== 'admin' &&
      user.username !== 'shopping_admin'
    ) {
      setAuthCookie(req, res, apiKey);
    }
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

export function requireShopper(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    if (req.user.username === 'shopping_admin' || req.user.role === 'admin') {
      throw new ForbiddenError(
        'The shopping_admin account does not have access to the shopping list'
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

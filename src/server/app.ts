import crypto from 'node:crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { checkDbReady } from './db/database.js';
import { sanitizeMiddleware } from './middleware/sanitize.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/api.js';
import { ForbiddenError, NotFoundError } from './errors/AppError.js';

export interface AppOptions {
  enableRateLimit?: boolean;
  publicBaseUrl?: string;
  nextHandler?: (req: Request, res: Response) => Promise<void> | void;
  isShuttingDown?: () => boolean;
}

function parseConfiguredPublicUrl(rawUrl?: string): URL | null {
  const candidate = (rawUrl ?? process.env.PUBLIC_BASE_URL ?? '').trim();
  if (!candidate) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function validateRequiredPublicBaseUrl(rawUrl?: string): URL {
  const candidate = (rawUrl ?? process.env.PUBLIC_BASE_URL ?? '').trim();
  if (!candidate) {
    throw new Error(
      'PUBLIC_BASE_URL environment variable is required to start the server (e.g., https://shopping.example.com or http://localhost:3000).'
    );
  }
  const parsed = parseConfiguredPublicUrl(candidate);
  if (!parsed) {
    throw new Error(
      `Invalid PUBLIC_BASE_URL "${candidate}": must be a valid http:// or https:// URL.`
    );
  }
  return parsed;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const allowedPublicUrl = parseConfiguredPublicUrl(options.publicBaseUrl);
  const allowedOrigin = allowedPublicUrl ? allowedPublicUrl.origin : null;
  const cspSources = allowedOrigin ? ["'self'", allowedOrigin] : ["'self'"];

  // Generate a cryptographic CSP nonce per request for Next.js inline scripts
  app.use((req: Request, res: Response, next: NextFunction) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;
    req.headers['x-nonce'] = nonce;
    next();
  });

  // Security headers with Helmet (configured to support self-hosted HTTP & HTTPS without unsafe-inline / unsafe-eval)
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: cspSources,
          scriptSrc: [
            ...cspSources,
            (_req, res) => `'nonce-${String((res as Response).locals.cspNonce)}'`,
          ],
          styleSrc: cspSources,
          imgSrc: [...cspSources, 'data:', 'blob:'],
          connectSrc: cspSources,
          mediaSrc: [...cspSources, 'blob:', 'mediastream:'],
          workerSrc: [...cspSources, 'blob:'],
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      originAgentCluster: false,
      strictTransportSecurity: false,
    })
  );

  // Forward the generated Content-Security-Policy header onto req.headers so Next.js SSR attaches the nonce to inline scripts
  app.use((req: Request, res: Response, next: NextFunction) => {
    const cspHeader = res.getHeader('Content-Security-Policy');
    if (typeof cspHeader === 'string') {
      req.headers['content-security-policy'] = cspHeader;
    }
    next();
  });

  // Standard CORS policy restricted to PUBLIC_BASE_URL when configured
  app.use(
    cors({
      origin: allowedOrigin ?? process.env.CORS_ORIGIN ?? true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      credentials: true,
    })
  );

  // Liveness probe (/healthz)
  app.get('/healthz', (_req: Request, res: Response) => {
    if (options.isShuttingDown?.()) {
      res.status(503).json({ status: 'shutting_down', timestamp: new Date().toISOString() });
      return;
    }
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Readiness probe (/ready)
  app.get('/ready', (_req: Request, res: Response) => {
    if (options.isShuttingDown?.()) {
      res.status(503).json({ status: 'not_ready', reason: 'shutting_down' });
      return;
    }
    const dbReady = checkDbReady();
    if (!dbReady) {
      res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
      return;
    }
    res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
  });

  // Enforce PUBLIC_BASE_URL host/origin restriction when configured
  if (allowedPublicUrl) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const forwardedHost = req.headers['x-forwarded-host'];
      const rawHost =
        (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
          ?.split(',')[0]
          ?.trim() || req.headers.host;

      if (!rawHost || rawHost.toLowerCase() !== allowedPublicUrl.host.toLowerCase()) {
        next(
          new ForbiddenError(
            `Access denied: requests must be addressed to ${allowedPublicUrl.origin}`
          )
        );
        return;
      }

      const originHeader = req.headers.origin;
      if (originHeader) {
        try {
          const reqOrigin = new URL(originHeader).origin;
          if (reqOrigin.toLowerCase() !== allowedPublicUrl.origin.toLowerCase()) {
            next(
              new ForbiddenError(
                `Access denied: request origin must match ${allowedPublicUrl.origin}`
              )
            );
            return;
          }
        } catch {
          next(new ForbiddenError('Access denied: invalid Origin header'));
          return;
        }
      }

      const refererHeader = req.headers.referer;
      if (refererHeader) {
        try {
          const reqRefererOrigin = new URL(refererHeader).origin;
          if (reqRefererOrigin.toLowerCase() !== allowedPublicUrl.origin.toLowerCase()) {
            next(
              new ForbiddenError(
                `Access denied: request referer must match ${allowedPublicUrl.origin}`
              )
            );
            return;
          }
        } catch {
          next(new ForbiddenError('Access denied: invalid Referer header'));
          return;
        }
      }

      next();
    });
  }

  // Rate limiting on API routes
  if (options.enableRateLimit !== false) {
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: Number(process.env.RATE_LIMIT_MAX ?? 300),
      standardHeaders: true,
      legacyHeaders: false,
      validate: {
        xForwardedForHeader: false,
        trustProxy: false,
      },
      message: {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please try again shortly.',
        },
      },
    });
    app.use('/api', limiter);
  }

  // Sanitize query/params before routing; request bodies are parsed per-route AFTER authentication
  app.use('/api', sanitizeMiddleware);

  // Mount API routes
  app.use('/api', apiRouter);

  // Unknown API route handler
  app.all('/api/*', (req: Request, _res: Response, next: NextFunction) => {
    next(new NotFoundError(`Endpoint ${req.method} ${req.originalUrl}`));
  });

  // Centralized error handling middleware for API
  app.use(errorHandler);

  // Delegate non-API routes to Next.js frontend when attached
  if (options.nextHandler) {
    app.all('*', (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(options.nextHandler!(req, res)).catch(next);
    });
  }

  return app;
}

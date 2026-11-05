import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { checkDbReady } from './db/database.js';
import { sanitizeMiddleware } from './middleware/sanitize.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/api.js';
import { NotFoundError } from './errors/AppError.js';

export interface AppOptions {
  enableRateLimit?: boolean;
  nextHandler?: (req: Request, res: Response) => Promise<void> | void;
  isShuttingDown?: () => boolean;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Security headers with Helmet (configured to support self-hosted HTTP & HTTPS)
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          mediaSrc: ["'self'", 'blob:', 'mediastream:'],
          workerSrc: ["'self'", 'blob:'],
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      originAgentCluster: false,
      strictTransportSecurity: false,
    })
  );

  // Standard CORS policy
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN ?? true,
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

  // Body parsing & input sanitization for API routes
  app.use('/api', express.json({ limit: '10mb' }));
  app.use('/api', express.urlencoded({ extended: true, limit: '10mb' }));
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

import http from 'node:http';
import type { Socket } from 'node:net';
import next from 'next';
import { closeDb, getDb } from './db/database.js';
import { bootstrapAdminAccount, printAdminPasswordBanner } from './services/authService.js';
import { closeAllSseClients } from './services/eventHub.js';
import { createApp, validateRequiredPublicBaseUrl } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const dev = process.env.NODE_ENV !== 'production';

let shuttingDown = false;

export async function startServer(): Promise<http.Server> {
  // 0. Require a valid PUBLIC_BASE_URL on startup
  const publicBaseUrl = validateRequiredPublicBaseUrl(process.env.PUBLIC_BASE_URL);

  // 1. Initialize SQLite database & bootstrap shopping_admin
  const db = getDb();
  const { password, expiresAt } = bootstrapAdminAccount(db);

  // 2. Display shopping_admin password strictly on container console on every startup
  printAdminPasswordBanner(password, expiresAt);

  // 3. Prepare Next.js application
  const createNextServer = (
    typeof (next as { default?: unknown }).default === 'function'
      ? (next as unknown as { default: (opts: { dev: boolean }) => ReturnType<typeof import('next')['default']> }).default
      : (next as unknown as (opts: { dev: boolean }) => ReturnType<typeof import('next')['default']>)
  );
  const nextApp = createNextServer({ dev });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();

  // 4. Create Express app with Next.js handler and shutdown state
  const app = createApp({
    enableRateLimit: true,
    publicBaseUrl: publicBaseUrl.origin,
    isShuttingDown: () => shuttingDown,
    nextHandler: (req, res) => handle(req, res),
  });

  const server = http.createServer(app);
  const sockets = new Set<Socket>();

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, HOST, () => {
      process.stdout.write(
        `[server] Shared Shopping List running on http://${HOST}:${PORT} (mode: ${
          dev ? 'development' : 'production'
        })\n`
      );
      resolve();
    });
  });

  // 5. Graceful shutdown handlers (SIGTERM, SIGINT) to drain active connections
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write(`\n[server] Received ${signal}. Initiating graceful shutdown...\n`);
    closeAllSseClients();

    const forceExitTimer = setTimeout(() => {
      process.stderr.write('[server] Graceful shutdown timed out. Forcing remaining sockets closed.\n');
      for (const socket of sockets) {
        socket.destroy();
      }
      closeDb();
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    server.close(() => {
      closeDb();
      clearTimeout(forceExitTimer);
      process.stdout.write('[server] HTTP connections drained and SQLite closed cleanly.\n');
      process.exit(0);
    });

    // End idle keep-alive sockets promptly
    for (const socket of sockets) {
      socket.end();
    }
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return server;
}

if (process.env.NODE_ENV !== 'test') {
  startServer().catch((err) => {
    process.stderr.write(`[server] Fatal startup error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

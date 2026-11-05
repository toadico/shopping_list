import type { Response } from 'express';
import type { ShoppingItemDTO } from './itemService.js';
import type { StoreDTO } from './storeService.js';

export interface SyncEventPayload {
  type: 'connected' | 'items_updated' | 'stores_updated';
  items?: ShoppingItemDTO[];
  stores?: StoreDTO[];
  timestamp: string;
}

interface SseClient {
  id: string;
  userId: string;
  res: Response;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

const clients = new Map<string, SseClient>();

export function addSseClient(clientId: string, userId: string, res: Response): void {
  const heartbeatTimer = setInterval(() => {
    try {
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    } catch {
      removeSseClient(clientId);
    }
  }, 25_000);
  heartbeatTimer.unref();

  clients.set(clientId, {
    id: clientId,
    userId,
    res,
    heartbeatTimer,
  });
}

export function removeSseClient(clientId: string): void {
  const client = clients.get(clientId);
  if (client) {
    clearInterval(client.heartbeatTimer);
    clients.delete(clientId);
  }
}

export function broadcastEvent(payload: SyncEventPayload): void {
  const serialized = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [clientId, client] of clients.entries()) {
    try {
      client.res.write(serialized);
    } catch {
      removeSseClient(clientId);
    }
  }
}

export function disconnectUserSseClients(userId: string): void {
  for (const [clientId, client] of clients.entries()) {
    if (client.userId === userId) {
      removeSseClient(clientId);
      try {
        client.res.end();
      } catch {
        // Ignore
      }
    }
  }
}

export function closeAllSseClients(): void {
  for (const [clientId, client] of clients.entries()) {
    clearInterval(client.heartbeatTimer);
    try {
      client.res.end();
    } catch {
      // Ignore
    }
    clients.delete(clientId);
  }
}

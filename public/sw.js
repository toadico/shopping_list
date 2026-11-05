const CACHE_NAME = 'shopping-list-cache-v2';
const STATIC_ASSETS = ['/', '/manifest.json', '/icon.svg'];
const DB_NAME = 'shopping_list_offline_db';
const DB_VERSION = 1;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
            return Promise.resolve();
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return;
  }

  // Network-first with offline cache fallback for GET /api/items and GET /api/stores
  if (url.pathname === '/api/items' || url.pathname === '/api/stores') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) {
            return cached;
          }
          return new Response(
            JSON.stringify({ items: [], stores: [], offline: true }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        })
    );
    return;
  }

  // Stale-while-revalidate for same-origin static/navigation assets
  if (url.origin === self.location.origin && !url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) {
            return cached;
          }
          const rootFallback = await caches.match('/');
          return (
            rootFallback ||
            new Response('Offline', { status: 503, statusText: 'Offline' })
          );
        })
    );
  }
});

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        db.createObjectStore('items', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('stores')) {
        db.createObjectStore('stores', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('mutation_queue')) {
        db.createObjectStore('mutation_queue', { keyPath: 'queueId', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function flushOfflineQueueInSw() {
  try {
    const db = await openOfflineDb();

    const apiKey = await new Promise((resolve) => {
      const tx = db.transaction('meta', 'readonly');
      const getReq = tx.objectStore('meta').get('apiKey');
      getReq.onsuccess = () => resolve(getReq.result ? getReq.result.value : null);
      getReq.onerror = () => resolve(null);
    });

    if (!apiKey) {
      return;
    }

    const mutations = await new Promise((resolve) => {
      const tx = db.transaction('mutation_queue', 'readonly');
      const getAllReq = tx.objectStore('mutation_queue').getAll();
      getAllReq.onsuccess = () => resolve(getAllReq.result || []);
      getAllReq.onerror = () => resolve([]);
    });

    if (!mutations.length) {
      return;
    }

    const res = await fetch('/api/items/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ mutations }),
    });

    if (res.ok) {
      const data = await res.json();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['mutation_queue', 'items'], 'readwrite');
        tx.objectStore('mutation_queue').clear();
        if (Array.isArray(data.items)) {
          const itemsStore = tx.objectStore('items');
          itemsStore.clear();
          for (const item of data.items) {
            itemsStore.put(item);
          }
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'SYNC_COMPLETED', items: data.items });
      }
    }
  } catch {
    // Will retry on next sync trigger
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-shopping-items') {
    event.waitUntil(flushOfflineQueueInSw());
  }
});

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: string;
  notes: string;
  storeId: string | null;
  storeName: string;
  imageData: string | null;
  oneTime?: boolean;
  checked: boolean;
  checkedBy?: string | null;
  checkedByName?: string | null;
  checkedAt?: string | null;
  createdBy: string | null;
  createdByName: string;
  updatedAt: string;
  createdAt: string;
}

export interface Store {
  id: string;
  name: string;
  createdBy: string | null;
  createdAt: string;
}

export interface QueuedMutation {
  queueId?: number;
  type: 'create' | 'update' | 'delete';
  itemId: string;
  payload?: Record<string, unknown>;
  timestamp: string;
}

const DB_NAME = 'shopping_list_offline_db';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
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

export async function saveApiKeyToOfflineStore(apiKey: string | null): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      if (apiKey) {
        store.put({ key: 'apiKey', value: apiKey });
      } else {
        store.delete('apiKey');
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore IDB errors in restricted environments
  }
}

export async function saveCachedItems(items: ShoppingItem[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      store.clear();
      for (const item of items) {
        store.put(item);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore
  }
}

export async function getCachedItems(): Promise<ShoppingItem[]> {
  try {
    const db = await openDb();
    return await new Promise<ShoppingItem[]>((resolve) => {
      const tx = db.transaction('items', 'readonly');
      const req = tx.objectStore('items').getAll();
      req.onsuccess = () => {
        const list = (req.result as ShoppingItem[]) || [];
        list.sort((a, b) => {
          if (a.checked !== b.checked) {
            return a.checked ? 1 : -1;
          }
          return b.updatedAt.localeCompare(a.updatedAt);
        });
        resolve(list);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function saveCachedStores(stores: Store[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('stores', 'readwrite');
      const store = tx.objectStore('stores');
      store.clear();
      for (const s of stores) {
        store.put(s);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore
  }
}

export async function getCachedStores(): Promise<Store[]> {
  try {
    const db = await openDb();
    return await new Promise<Store[]>((resolve) => {
      const tx = db.transaction('stores', 'readonly');
      const req = tx.objectStore('stores').getAll();
      req.onsuccess = () => {
        const list = (req.result as Store[]) || [];
        list.sort((a, b) => a.name.localeCompare(b.name));
        resolve(list);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function enqueueOfflineMutation(
  mutation: Omit<QueuedMutation, 'queueId' | 'timestamp'>
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('mutation_queue', 'readwrite');
      tx.objectStore('mutation_queue').add({
        ...mutation,
        timestamp: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await requestBackgroundSync();
  } catch {
    // Ignore
  }
}

export async function getPendingMutations(): Promise<QueuedMutation[]> {
  try {
    const db = await openDb();
    return await new Promise<QueuedMutation[]>((resolve) => {
      const tx = db.transaction('mutation_queue', 'readonly');
      const req = tx.objectStore('mutation_queue').getAll();
      req.onsuccess = () => resolve((req.result as QueuedMutation[]) || []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function clearPendingMutations(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('mutation_queue', 'readwrite');
      tx.objectStore('mutation_queue').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore
  }
}

export async function registerServiceWorker(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch {
    // Service worker registration optional in non-HTTPS dev environments
  }
}

export async function requestBackgroundSync(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    if ('sync' in registration) {
      await (registration as ServiceWorkerRegistration & {
        sync: { register: (tag: string) => Promise<void> };
      }).sync.register('sync-shopping-items');
    }
  } catch {
    // Fallback handled by window online listener
  }
}

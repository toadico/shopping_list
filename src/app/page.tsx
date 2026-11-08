'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  clearPendingMutations,
  enqueueOfflineMutation,
  getCachedItems,
  getCachedStores,
  getPendingMutations,
  registerServiceWorker,
  saveApiKeyToOfflineStore,
  saveCachedItems,
  saveCachedStores,
  type ShoppingItem,
  type Store,
} from '../client/offlineStorage';

interface UserProfile {
  id: string;
  name: string;
  username: string | null;
  apiKeyPrefix: string;
  role: 'admin' | 'user';
  canManageUsers?: boolean;
  status: 'active' | 'disabled' | 'revoked';
  invitedBy: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

interface InviteData {
  token: string;
  inviteUrl: string;
  qrCodeDataUrl: string;
  createdByName: string;
  grantsManageUsers?: boolean;
  expiresAt: string;
}

const API_KEY_STORAGE_KEY = 'shopping_list_api_key';

async function compressImageFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 800;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(String(reader.result));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => reject(new Error('Failed to decode selected image'));
      img.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

function parseItemQuantity(qty: string | number | undefined): number {
  const parsed = Number.parseInt(String(qty ?? '1'), 10);
  return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
}

export default function ShoppingListApp() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [pendingSyncCount, setPendingSyncCount] = useState<number>(0);

  // Feedback alerts
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [newlyIssuedApiKey, setNewlyIssuedApiKey] = useState<string | null>(null);

  // Login / Join state
  const [loginTab, setLoginTab] = useState<'admin' | 'apikey' | 'join'>('admin');
  const [adminUsername, setAdminUsername] = useState('shopping_admin');
  const [adminPassword, setAdminPassword] = useState('');
  const [manualApiKey, setManualApiKey] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [inviteCreatorName, setInviteCreatorName] = useState<string | null>(null);
  const [newUserName, setNewUserName] = useState('');

  // Shopping list & stores state
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [filterStore, setFilterStore] = useState<string>('ALL');

  // Add item form state
  const [itemName, setItemName] = useState('');
  const [itemQuantity, setItemQuantity] = useState<number>(1);
  const [itemNotes, setItemNotes] = useState('');
  const [selectedStoreName, setSelectedStoreName] = useState('Supermarket');
  const [customStoreInput, setCustomStoreInput] = useState('');
  const [addStoreModalOpen, setAddStoreModalOpen] = useState(false);
  const [editingStoreId, setEditingStoreId] = useState<string | null>(null);
  const [editingStoreName, setEditingStoreName] = useState('');
  const [storeModalError, setStoreModalError] = useState<string | null>(null);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [submittingItem, setSubmittingItem] = useState(false);

  // Camera capture modal state
  const [cameraModalOpen, setCameraModalOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Lightbox image preview
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // QR Invite modal state
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [generatedInvite, setGeneratedInvite] = useState<InviteData | null>(null);
  const [generatingInvite, setGeneratingInvite] = useState(false);

  // Admin user management state
  const [adminTabOpen, setAdminTabOpen] = useState(false);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  const refreshPendingCount = useCallback(async () => {
    const pending = await getPendingMutations();
    setPendingSyncCount(pending.length);
  }, []);

  const syncOfflineQueue = useCallback(
    async (activeKey: string) => {
      const pending = await getPendingMutations();
      if (pending.length === 0) {
        return;
      }
      try {
        const res = await fetch('/api/items/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${activeKey}`,
          },
          body: JSON.stringify({ mutations: pending }),
        });
        if (res.ok) {
          const data = await res.json();
          await clearPendingMutations();
          setPendingSyncCount(0);
          if (Array.isArray(data.items)) {
            setItems(data.items);
            await saveCachedItems(data.items);
          }
          setSuccessMsg('Offline shopping list changes synced with server.');
        }
      } catch {
        // Remains queued for next online event
      }
    },
    []
  );

  const loadListAndStores = useCallback(
    async (activeKey: string) => {
      // Load cached items & stores immediately for fast offline-first UX
      const [cachedItems, cachedStores] = await Promise.all([
        getCachedItems(),
        getCachedStores(),
      ]);
      if (cachedItems.length > 0) {
        setItems(cachedItems);
      }
      if (cachedStores.length > 0) {
        setStores(cachedStores);
      }

      try {
        await syncOfflineQueue(activeKey);

        const [itemsRes, storesRes] = await Promise.all([
          fetch('/api/items', {
            headers: { Authorization: `Bearer ${activeKey}` },
          }),
          fetch('/api/stores', {
            headers: { Authorization: `Bearer ${activeKey}` },
          }),
        ]);

        if (itemsRes.ok) {
          const itemsData = await itemsRes.json();
          setItems(itemsData.items ?? []);
          await saveCachedItems(itemsData.items ?? []);
        }
        if (storesRes.ok) {
          const storesData = await storesRes.json();
          const loadedStores: Store[] = storesData.stores ?? [];
          setStores(loadedStores);
          await saveCachedStores(loadedStores);
          if (loadedStores.length > 0) {
            setSelectedStoreName((prev) => prev || loadedStores[0].name);
          }
        }
      } catch {
        // Offline fallback already loaded from IndexedDB
      } finally {
        await refreshPendingCount();
      }
    },
    [refreshPendingCount, syncOfflineQueue]
  );

  const fetchAllUsersForAdmin = useCallback(async (activeKey: string) => {
    setLoadingUsers(true);
    try {
      const res = await fetch('/api/users', {
        headers: { Authorization: `Bearer ${activeKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setAllUsers(data.users ?? []);
      }
    } catch {
      // Ignore
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  // Register Service Worker, online/offline listeners, and check URL invite parameter
  useEffect(() => {
    registerServiceWorker();
    setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);

    const handleOnline = () => {
      setIsOnline(true);
      const savedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
      const cachedProfile = localStorage.getItem('shopping_list_user_profile');
      const parsedProfile = cachedProfile ? (JSON.parse(cachedProfile) as UserProfile) : null;
      const isAdminAccount =
        parsedProfile?.role === 'admin' || parsedProfile?.username === 'shopping_admin';
      if (savedKey && !isAdminAccount) {
        void loadListAndStores(savedKey);
      }
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SYNC_COMPLETED' && Array.isArray(event.data.items)) {
        setItems(event.data.items);
        setPendingSyncCount(0);
      }
    };
    navigator.serviceWorker?.addEventListener('message', handleSwMessage);

    // Check if user scanned a QR code with ?invite=<token>
    const params = new URLSearchParams(window.location.search);
    const urlInvite = params.get('invite');
    if (urlInvite) {
      setInviteToken(urlInvite);
      setLoginTab('join');
      fetch(`/api/auth/invites/${encodeURIComponent(urlInvite)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.invite?.createdByName) {
            setInviteCreatorName(data.invite.createdByName);
          }
        })
        .catch(() => {});
    }

    // Restore saved API key
    const storedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (!storedKey) {
      setAuthLoading(false);
    } else {
      setAuthLoading(true);
      setApiKey(storedKey);
      void saveApiKeyToOfflineStore(storedKey);
      fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${storedKey}` },
      })
        .then(async (res) => {
          if (res.ok) {
            const data = await res.json();
            setCurrentUser(data.user);
            if (data.user?.role === 'admin' || data.user?.username === 'shopping_admin') {
              setAdminTabOpen(true);
              await fetchAllUsersForAdmin(storedKey);
            } else {
              await loadListAndStores(storedKey);
            }
          } else if (res.status === 401 || res.status === 403) {
            const errData = await res.json().catch(() => ({}));
            setErrorMsg(errData?.error?.message || 'Session expired or revoked');
            localStorage.removeItem(API_KEY_STORAGE_KEY);
            await saveApiKeyToOfflineStore(null);
            setApiKey(null);
            setCurrentUser(null);
          }
        })
        .catch(async () => {
          // Offline mode with existing API key: allow viewing cached items
          const cachedProfile = localStorage.getItem('shopping_list_user_profile');
          if (cachedProfile) {
            const parsedUser = JSON.parse(cachedProfile) as UserProfile;
            setCurrentUser(parsedUser);
            if (parsedUser.role !== 'admin' && parsedUser.username !== 'shopping_admin') {
              await loadListAndStores(storedKey);
            }
          }
        })
        .finally(() => {
          setAuthLoading(false);
        });
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      navigator.serviceWorker?.removeEventListener('message', handleSwMessage);
    };
  }, [fetchAllUsersForAdmin, loadListAndStores]);

  // Real-time multi-device sync via Server-Sent Events (SSE) + visibility/poll fallback
  useEffect(() => {
    if (
      !apiKey ||
      !currentUser ||
      !isOnline ||
      currentUser.role === 'admin' ||
      currentUser.username === 'shopping_admin'
    ) {
      return;
    }

    let eventSource: EventSource | null = null;
    if (typeof EventSource !== 'undefined') {
      eventSource = new EventSource('/api/events', { withCredentials: true });
      eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as {
            type?: string;
            items?: ShoppingItem[];
            stores?: Store[];
          };
          if (Array.isArray(payload.items)) {
            setItems(payload.items);
            void saveCachedItems(payload.items);
          }
          if (Array.isArray(payload.stores)) {
            setStores(payload.stores);
            void saveCachedStores(payload.stores);
          }
        } catch {
          // Ignore malformed event payloads
        }
      };
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadListAndStores(apiKey);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const pollInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadListAndStores(apiKey);
      }
    }, 15_000);

    return () => {
      eventSource?.close();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(pollInterval);
    };
  }, [apiKey, currentUser, isOnline, loadListAndStores]);

  const handleSaveSession = async (user: UserProfile, key: string) => {
    const isAdminAccount = user.role === 'admin' || user.username === 'shopping_admin';
    if (!isAdminAccount) {
      localStorage.setItem(API_KEY_STORAGE_KEY, key);
      localStorage.setItem('shopping_list_user_profile', JSON.stringify(user));
      await saveApiKeyToOfflineStore(key);
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
      localStorage.removeItem('shopping_list_user_profile');
      await saveApiKeyToOfflineStore(null);
    }
    setApiKey(key);
    setCurrentUser(user);
    if (isAdminAccount) {
      setAdminTabOpen(true);
      await fetchAllUsersForAdmin(key);
    } else {
      await loadListAndStores(key);
    }
  };

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    try {
      const res = await fetch('/api/auth/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: adminUsername.trim(),
          password: adminPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data?.error?.message || 'Admin login failed');
        return;
      }
      setAdminPassword('');
      await handleSaveSession(data.user, data.apiKey);
    } catch {
      setErrorMsg('Unable to reach server for admin login.');
    }
  };

  const handleApiKeyLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    const trimmed = manualApiKey.trim();
    if (!trimmed) {
      setErrorMsg('Please enter your API key.');
      return;
    }
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data?.error?.message || 'Invalid or revoked API key');
        return;
      }
      if (data.user?.role === 'admin' || data.user?.username === 'shopping_admin') {
        setErrorMsg(
          'The shopping_admin account can only sign in using the container startup password.'
        );
        return;
      }
      await handleSaveSession(data.user, trimmed);
    } catch {
      setErrorMsg('Unable to verify API key right now.');
    }
  };

  const handleRedeemInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    try {
      const res = await fetch('/api/auth/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: inviteToken.trim(),
          name: newUserName.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data?.error?.message || 'Failed to join with invite token');
        return;
      }
      setNewlyIssuedApiKey(data.apiKey);
      // Clear ?invite= query parameter from URL bar
      window.history.replaceState({}, '', '/');
      await handleSaveSession(data.user, data.apiKey);
    } catch {
      setErrorMsg('Network error while redeeming invite QR code.');
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    localStorage.removeItem('shopping_list_user_profile');
    await saveApiKeyToOfflineStore(null);
    setApiKey(null);
    setCurrentUser(null);
    setNewlyIssuedApiKey(null);
    setAdminTabOpen(false);
  };

  // Add Store from Manage Stores modal to selectable store button list
  const handleAddCustomStore = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setStoreModalError(null);
    const trimmed = customStoreInput.trim();
    if (!trimmed) {
      return;
    }

    const exists = stores.some((s) => s.name.toLowerCase() === trimmed.toLowerCase());
    if (exists) {
      setStoreModalError(`Store "${trimmed}" already exists.`);
      return;
    }

    setSelectedStoreName(trimmed);
    setCustomStoreInput('');

    const optimisticStore: Store = {
      id: `local-${Date.now()}`,
      name: trimmed,
      createdBy: currentUser?.id ?? null,
      createdAt: new Date().toISOString(),
    };
    const updatedStores = [...stores, optimisticStore].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    setStores(updatedStores);
    await saveCachedStores(updatedStores);

    if (apiKey && isOnline) {
      try {
        const res = await fetch('/api/stores', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ name: trimmed }),
        });
        if (res.ok) {
          const storesRes = await fetch('/api/stores', {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (storesRes.ok) {
            const storesData = await storesRes.json();
            setStores(storesData.stores ?? []);
            await saveCachedStores(storesData.stores ?? []);
          }
        }
      } catch {
        // Store will be created automatically when item is synced
      }
    }
  };

  // Edit / Rename an existing store in Manage Stores modal
  const handleUpdateStore = async (store: Store, e?: React.FormEvent) => {
    e?.preventDefault();
    setStoreModalError(null);
    const trimmed = editingStoreName.trim();
    if (!trimmed) {
      setStoreModalError('Store name cannot be empty.');
      return;
    }
    if (trimmed === store.name) {
      setEditingStoreId(null);
      setEditingStoreName('');
      return;
    }

    const duplicate = stores.some(
      (s) => s.id !== store.id && s.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) {
      setStoreModalError(`A store named "${trimmed}" already exists.`);
      return;
    }

    const previousName = store.name;
    const updatedStores = stores
      .map((s) => (s.id === store.id ? { ...s, name: trimmed } : s))
      .sort((a, b) => a.name.localeCompare(b.name));
    setStores(updatedStores);
    await saveCachedStores(updatedStores);

    const updatedItems = items.map((item) =>
      item.storeId === store.id || item.storeName.toLowerCase() === previousName.toLowerCase()
        ? { ...item, storeName: trimmed, updatedAt: new Date().toISOString() }
        : item
    );
    setItems(updatedItems);
    await saveCachedItems(updatedItems);

    if (selectedStoreName.toLowerCase() === previousName.toLowerCase()) {
      setSelectedStoreName(trimmed);
    }
    if (filterStore !== 'ALL' && filterStore.toLowerCase() === previousName.toLowerCase()) {
      setFilterStore(trimmed);
    }

    setEditingStoreId(null);
    setEditingStoreName('');

    if (apiKey && isOnline) {
      try {
        const res = await fetch(`/api/stores/${encodeURIComponent(store.id)}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ name: trimmed }),
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.stores)) {
            setStores(data.stores);
            await saveCachedStores(data.stores);
          }
          if (Array.isArray(data.items)) {
            setItems(data.items);
            await saveCachedItems(data.items);
          }
        } else {
          const errData = await res.json().catch(() => ({}));
          setStoreModalError(errData?.error?.message || 'Failed to update store name');
        }
      } catch {
        // Optimistic update already saved locally
      }
    }
  };

  // Camera capture handlers
  const openLiveCamera = async () => {
    setErrorMsg(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      setCameraModalOpen(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      }, 100);
    } catch {
      // Fallback to native file/camera input if permission denied or no webcam device
      fileInputRef.current?.click();
    }
  };

  const closeLiveCamera = () => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    setCameraModalOpen(false);
  };

  const captureFrameFromVideo = () => {
    if (!videoRef.current) {
      return;
    }
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const maxDim = 800;
    let width = video.videoWidth || 640;
    let height = video.videoHeight || 480;
    if (width > maxDim || height > maxDim) {
      if (width > height) {
        height = Math.round((height * maxDim) / width);
        width = maxDim;
      } else {
        width = Math.round((width * maxDim) / height);
        height = maxDim;
      }
    }
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      setAttachedImage(dataUrl);
    }
    closeLiveCamera();
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const dataUrl = await compressImageFileToDataUrl(file);
      setAttachedImage(dataUrl);
    } catch {
      setErrorMsg('Could not process attached photo.');
    }
  };

  // Add Shopping Item (online with offline queue fallback)
  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    const trimmedName = itemName.trim();
    if (!trimmedName) {
      setErrorMsg('Please enter an item name.');
      return;
    }

    const effectiveStoreName = customStoreInput.trim() || selectedStoreName || 'Supermarket';
    setSubmittingItem(true);

    const clientItemId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const payload = {
      id: clientItemId,
      name: trimmedName,
      quantity: String(Math.max(1, itemQuantity)),
      notes: itemNotes.trim(),
      storeName: effectiveStoreName,
      imageData: attachedImage,
      checked: false,
    };

    try {
      if (!isOnline || !apiKey) {
        throw new Error('OFFLINE');
      }

      const res = await fetch('/api/items', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setErrorMsg(errData?.error?.message || 'Failed to add item');
        setSubmittingItem(false);
        return;
      }

      const { item } = await res.json();
      const updatedItems = [item, ...items.filter((i) => i.id !== item.id)];
      setItems(updatedItems);
      await saveCachedItems(updatedItems);

      // Ensure store appears in selectable list if newly typed
      if (!stores.some((s) => s.name.toLowerCase() === item.storeName.toLowerCase())) {
        const storesRes = await fetch('/api/stores', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (storesRes.ok) {
          const storesData = await storesRes.json();
          setStores(storesData.stores ?? []);
          await saveCachedStores(storesData.stores ?? []);
        }
      }
      setSelectedStoreName(item.storeName);
    } catch {
      // Offline mode: add optimistically to IndexedDB cache and enqueue background sync mutation
      const now = new Date().toISOString();
      const offlineItem: ShoppingItem = {
        id: clientItemId,
        name: payload.name,
        quantity: payload.quantity,
        notes: payload.notes,
        storeId: null,
        storeName: effectiveStoreName,
        imageData: payload.imageData,
        checked: false,
        createdBy: currentUser?.id ?? null,
        createdByName: currentUser?.name ?? 'Me (Offline)',
        updatedAt: now,
        createdAt: now,
      };
      const updatedItems = [offlineItem, ...items];
      setItems(updatedItems);
      await saveCachedItems(updatedItems);

      if (!stores.some((s) => s.name.toLowerCase() === effectiveStoreName.toLowerCase())) {
        const updatedStores = [
          ...stores,
          {
            id: `offline-store-${Date.now()}`,
            name: effectiveStoreName,
            createdBy: currentUser?.id ?? null,
            createdAt: now,
          },
        ].sort((a, b) => a.name.localeCompare(b.name));
        setStores(updatedStores);
        await saveCachedStores(updatedStores);
      }

      await enqueueOfflineMutation({
        type: 'create',
        itemId: clientItemId,
        payload,
      });
      await refreshPendingCount();
      setSuccessMsg('Added item to offline cache — will background sync automatically.');
    } finally {
      setItemName('');
      setItemQuantity(1);
      setItemNotes('');
      setCustomStoreInput('');
      setAttachedImage(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setSubmittingItem(false);
    }
  };

  const handleUpdateItemQuantity = async (item: ShoppingItem, delta: number) => {
    const currentQty = parseItemQuantity(item.quantity);
    const nextQty = Math.max(1, currentQty + delta);
    if (nextQty === currentQty && item.quantity === String(nextQty)) {
      return;
    }
    const nextQuantity = String(nextQty);
    const optimistic = items.map((i) =>
      i.id === item.id
        ? { ...i, quantity: nextQuantity, updatedAt: new Date().toISOString() }
        : i
    );
    setItems(optimistic);
    await saveCachedItems(optimistic);

    try {
      if (!isOnline || !apiKey) {
        throw new Error('OFFLINE');
      }
      const res = await fetch(`/api/items/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ quantity: nextQuantity }),
      });
      if (res.ok) {
        const data = await res.json();
        const synced = optimistic.map((i) => (i.id === item.id ? data.item : i));
        setItems(synced);
        await saveCachedItems(synced);
      }
    } catch {
      await enqueueOfflineMutation({
        type: 'update',
        itemId: item.id,
        payload: {
          quantity: nextQuantity,
          name: item.name,
          storeName: item.storeName,
        },
      });
      await refreshPendingCount();
    }
  };

  const handleToggleItemChecked = async (item: ShoppingItem) => {
    const nextChecked = !item.checked;
    const optimistic = items.map((i) =>
      i.id === item.id ? { ...i, checked: nextChecked, updatedAt: new Date().toISOString() } : i
    );
    setItems(optimistic);
    await saveCachedItems(optimistic);

    try {
      if (!isOnline || !apiKey) {
        throw new Error('OFFLINE');
      }
      const res = await fetch(`/api/items/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ checked: nextChecked }),
      });
      if (res.ok) {
        const data = await res.json();
        const synced = optimistic.map((i) => (i.id === item.id ? data.item : i));
        setItems(synced);
        await saveCachedItems(synced);
      }
    } catch {
      await enqueueOfflineMutation({
        type: 'update',
        itemId: item.id,
        payload: { checked: nextChecked, name: item.name, storeName: item.storeName },
      });
      await refreshPendingCount();
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    const remaining = items.filter((i) => i.id !== itemId);
    setItems(remaining);
    await saveCachedItems(remaining);

    try {
      if (!isOnline || !apiKey) {
        throw new Error('OFFLINE');
      }
      await fetch(`/api/items/${encodeURIComponent(itemId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch {
      await enqueueOfflineMutation({
        type: 'delete',
        itemId,
      });
      await refreshPendingCount();
    }
  };

  // Generate QR Code Invite
  const handleGenerateInviteQr = async () => {
    if (!apiKey) {
      return;
    }
    setGeneratingInvite(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/auth/invites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          baseUrl: window.location.origin,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setGeneratedInvite(data.invite);
        setInviteModalOpen(true);
      } else {
        setErrorMsg(data?.error?.message || 'Failed to generate QR invite');
      }
    } catch {
      setErrorMsg('You must be online to generate a new invite QR code.');
    } finally {
      setGeneratingInvite(false);
    }
  };

  // Admin: update user status (active / disabled / revoked)
  const handleUpdateUserStatus = async (
    targetUserId: string,
    status: 'active' | 'disabled' | 'revoked'
  ) => {
    if (!apiKey) {
      return;
    }
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(targetUserId)}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (res.ok) {
        setAllUsers((prev) => prev.map((u) => (u.id === targetUserId ? data.user : u)));
        setSuccessMsg(`Updated user "${data.user.name}" status to ${status}.`);
      } else {
        setErrorMsg(data?.error?.message || 'Failed to update user status');
      }
    } catch {
      setErrorMsg('Failed to update user status.');
    }
  };

  // Admin: delete a user whose API key has been revoked
  const handleDeleteUser = async (targetUserId: string, targetUserName: string) => {
    if (!apiKey) {
      return;
    }
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(targetUserId)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (res.ok) {
        setAllUsers((prev) => prev.filter((u) => u.id !== targetUserId));
        setSuccessMsg(`Deleted revoked user "${targetUserName}".`);
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data?.error?.message || 'Failed to delete user');
      }
    } catch {
      setErrorMsg('Failed to delete user.');
    }
  };

  const filteredItems = items.filter((item) => {
    if (filterStore !== 'ALL' && item.storeName.toLowerCase() !== filterStore.toLowerCase()) {
      return false;
    }
    return true;
  });

  if (authLoading) {
    return (
      <div className="app-container">
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          Loading Shared Shopping List...
        </div>
      </div>
    );
  }

  // --- Unauthenticated Screen: Admin Login, API Key Login, or QR Code Invite Redemption ---
  if (!currentUser) {
    return (
      <div className="app-container" style={{ maxWidth: 520, marginTop: '2.5rem' }}>
        <div className="card">
          <div className="brand-title" style={{ marginBottom: '0.5rem' }}>
            <span>🛒 Shared Shopping List</span>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.25rem' }}>
            Private self-hosted shopping list. Access is restricted to authorized system users.
          </p>

          {errorMsg && <div className="alert alert-error">{errorMsg}</div>}

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
            <button
              type="button"
              className={`btn btn-sm ${loginTab === 'admin' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setLoginTab('admin')}
            >
              Admin Login
            </button>
            <button
              type="button"
              className={`btn btn-sm ${loginTab === 'apikey' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setLoginTab('apikey')}
            >
              Use API Key
            </button>
            <button
              type="button"
              className={`btn btn-sm ${loginTab === 'join' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setLoginTab('join')}
            >
              QR Invite Join
            </button>
          </div>

          {loginTab === 'admin' && (
            <form onSubmit={handleAdminLogin}>
              <div className="form-group">
                <label className="form-label" htmlFor="admin-username">
                  Admin Username
                </label>
                <input
                  id="admin-username"
                  className="input"
                  type="text"
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="admin-password">
                  Admin Password (displayed on container console at startup)
                </label>
                <input
                  id="admin-password"
                  className="input"
                  type="password"
                  placeholder="Enter password from container logs"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                Sign in as shopping_admin
              </button>
            </form>
          )}

          {loginTab === 'apikey' && (
            <form onSubmit={handleApiKeyLogin}>
              <div className="form-group">
                <label className="form-label" htmlFor="user-api-key">
                  Your Personal API Key
                </label>
                <input
                  id="user-api-key"
                  className="input"
                  type="password"
                  placeholder="slk_..."
                  value={manualApiKey}
                  onChange={(e) => setManualApiKey(e.target.value)}
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                Access Shopping List
              </button>
            </form>
          )}

          {loginTab === 'join' && (
            <form onSubmit={handleRedeemInvite}>
              {inviteCreatorName && (
                <div className="alert alert-success">
                  You have been invited by <strong>{inviteCreatorName}</strong>! Enter your name
                  below to generate your personal API key.
                </div>
              )}
              <div className="form-group">
                <label className="form-label" htmlFor="invite-token-input">
                  QR Invite Code
                </label>
                <input
                  id="invite-token-input"
                  className="input"
                  type="text"
                  placeholder="Invite token from scanned QR code"
                  value={inviteToken}
                  onChange={(e) => setInviteToken(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="new-user-name">
                  Your Name
                </label>
                <input
                  id="new-user-name"
                  className="input"
                  type="text"
                  placeholder="e.g., Alex Rivera"
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                Create Account & Generate API Key
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // --- Authenticated Main Application ---
  return (
    <div className="app-container">
      {errorMsg && <div className="alert alert-error">{errorMsg}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      {/* Newly created API Key banner for QR-onboarded users */}
      {newlyIssuedApiKey && (
        <div className="alert alert-success">
          <div style={{ fontWeight: 700, marginBottom: '0.35rem' }}>
            Welcome, {currentUser.name}! Your non-expiring personal API key has been generated and
            saved on this device:
          </div>
          <code
            style={{
              display: 'block',
              padding: '0.5rem',
              background: '#064e3b',
              borderRadius: 6,
              wordBreak: 'break-all',
              marginBottom: '0.5rem',
            }}
          >
            {newlyIssuedApiKey}
          </code>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => setNewlyIssuedApiKey(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Shopping List & Add Item Sections (Not shown to shopping_admin) */}
      {currentUser.role !== 'admin' && currentUser.username !== 'shopping_admin' && (
        <>
          {/* Shopping List Section */}
          <section className="card">
            <div className="card-title">
              <span>📋 Shopping List ({filteredItems.length})</span>
              {pendingSyncCount > 0 && isOnline && apiKey && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => syncOfflineQueue(apiKey)}
                >
                  🔄 Sync Now ({pendingSyncCount})
                </button>
              )}
            </div>

            {/* Store Filter Bar */}
            <div className="store-chips" style={{ marginBottom: '1rem' }}>
              <button
                type="button"
                className={`store-chip ${filterStore === 'ALL' ? 'active' : ''}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setFilterStore('ALL');
                }}
              >
                All Stores ({items.length})
              </button>
              {stores.map((s) => {
                const count = items.filter(
                  (i) => i.storeName.toLowerCase() === s.name.toLowerCase()
                ).length;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`store-chip ${
                      filterStore.toLowerCase() === s.name.toLowerCase() ? 'active' : ''
                    }`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setFilterStore(s.name);
                    }}
                  >
                    {s.name} ({count})
                  </button>
                );
              })}
            </div>

            {filteredItems.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem 0' }}>
                No shopping list items yet. Add your first item below!
              </p>
            ) : (
              <div className="item-list">
                {filteredItems.map((item) => {
                  const numericQuantity = parseItemQuantity(item.quantity);
                  return (
                    <div
                      key={item.id}
                      className={`item-row ${item.checked ? 'checked' : ''}`}
                    >
                      <div
                        className="item-name-row"
                        style={{
                          textDecoration: item.checked ? 'line-through' : 'none',
                        }}
                      >
                        {item.name}
                      </div>

                      <div className="item-body-row">
                        <div className="item-main">
                          <input
                            type="checkbox"
                            className="item-checkbox"
                            checked={item.checked}
                            onChange={() => handleToggleItemChecked(item)}
                            aria-label={`Mark ${item.name} as ${item.checked ? 'unpurchased' : 'purchased'}`}
                          />

                          {item.imageData && (
                            <img
                              src={item.imageData}
                              alt={item.name}
                              className="item-thumb"
                              onClick={() => setPreviewImage(item.imageData)}
                              title="Click to enlarge attached picture"
                            />
                          )}

                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                display: 'flex',
                                gap: '0.5rem',
                                alignItems: 'center',
                                flexWrap: 'wrap',
                              }}
                            >
                              <span className="badge badge-store">🏬 {item.storeName}</span>
                              <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                                Added by {item.createdByName}
                              </span>
                            </div>

                            {item.notes && (
                              <div
                                style={{
                                  fontSize: '0.85rem',
                                  color: 'var(--text-secondary)',
                                  marginTop: '0.25rem',
                                }}
                              >
                                📝 {item.notes}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="item-actions">
                          {!item.checked ? (
                            <div
                              className="quantity-stepper"
                              role="group"
                              aria-label={`Quantity controls for ${item.name}`}
                            >
                              <button
                                type="button"
                                className="quantity-btn"
                                onClick={() => handleUpdateItemQuantity(item, -1)}
                                disabled={numericQuantity <= 1}
                                aria-label={`Decrease quantity for ${item.name}`}
                                title="Subtract 1"
                              >
                                −
                              </button>
                              <span
                                className="quantity-value"
                                aria-live="polite"
                                data-testid={`item-quantity-${item.id}`}
                              >
                                {numericQuantity}
                              </span>
                              <button
                                type="button"
                                className="quantity-btn"
                                onClick={() => handleUpdateItemQuantity(item, 1)}
                                aria-label={`Increase quantity for ${item.name}`}
                                title="Add 1"
                              >
                                +
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() => handleDeleteItem(item.id)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Add Item Section */}
          <section className="card">
            <div className="card-title">
              <span>➕ Add Item to Shopping List</span>
            </div>

            <form onSubmit={handleAddItem}>
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label" htmlFor="item-name">
                    Item Name *
                  </label>
                  <input
                    id="item-name"
                    className="input"
                    type="text"
                    placeholder="e.g., Organic Whole Milk"
                    value={itemName}
                    onChange={(e) => setItemName(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" id="add-item-quantity-label">
                    Quantity
                  </label>
                  <div
                    className="quantity-stepper-form"
                    role="group"
                    aria-labelledby="add-item-quantity-label"
                  >
                    <button
                      type="button"
                      className="quantity-btn"
                      onClick={() => setItemQuantity((prev) => Math.max(1, prev - 1))}
                      disabled={itemQuantity <= 1}
                      aria-label="Decrease quantity"
                      title="Subtract 1"
                    >
                      −
                    </button>
                    <span
                      id="item-quantity"
                      className="quantity-value"
                      aria-live="polite"
                      data-testid="add-item-quantity-value"
                    >
                      {itemQuantity}
                    </span>
                    <button
                      type="button"
                      className="quantity-btn"
                      onClick={() => setItemQuantity((prev) => prev + 1)}
                      aria-label="Increase quantity"
                      title="Add 1"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={submittingItem}
                style={{ width: '100%', marginBottom: '1rem' }}
              >
                {submittingItem ? 'Adding Item...' : 'Add Item to Shopping List'}
              </button>

              {/* Button Store Selection + Add Store Button Below */}
              <div className="form-group">
                <label className="form-label">
                  Store (Selected: <strong>{selectedStoreName}</strong>)
                </label>

                <div className="store-chips">
                  {stores.map((store) => (
                    <button
                      key={store.id}
                      type="button"
                      className={`store-chip ${
                        selectedStoreName.toLowerCase() === store.name.toLowerCase()
                          ? 'active'
                          : ''
                      }`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedStoreName(store.name);
                      }}
                    >
                      🏬 {store.name}
                    </button>
                  ))}
                </div>

                <div style={{ marginTop: '0.65rem' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCustomStoreInput('');
                      setEditingStoreId(null);
                      setEditingStoreName('');
                      setStoreModalError(null);
                      setAddStoreModalOpen(true);
                    }}
                  >
                    🏬 Manage Stores
                  </button>
                </div>
              </div>

              {/* Notes & Picture Attachment */}
              <div className="form-grid" style={{ alignItems: 'end' }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="item-notes">
                    Notes (Optional)
                  </label>
                  <input
                    id="item-notes"
                    className="input"
                    type="text"
                    placeholder="Brand preference, aisle, size..."
                    value={itemNotes}
                    onChange={(e) => setItemNotes(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Attach Picture (Camera or Photo)</label>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={openLiveCamera}
                    >
                      📷 Take Picture
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      🖼️ Upload / Camera File
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      style={{ display: 'none' }}
                      onChange={handleFileInputChange}
                    />
                  </div>
                </div>
              </div>

              {attachedImage && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    marginTop: '0.25rem',
                    padding: '0.5rem',
                    background: 'var(--bg-primary)',
                    borderRadius: 8,
                  }}
                >
                  <img
                    src={attachedImage}
                    alt="Attached preview"
                    className="item-thumb"
                  />
                  <div style={{ flex: 1, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Picture attached and ready to save with this item.
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => setAttachedImage(null)}
                  >
                    Remove Picture
                  </button>
                </div>
              )}
            </form>
          </section>
        </>
      )}

      {/* User Management Bar (Bottom of Page) */}
      <footer className="header-bar">
        <div className="brand-title">
          <span>👥 User Management</span>
          <span className={`badge ${isOnline ? 'badge-online' : 'badge-offline'}`}>
            {isOnline ? '● Online' : '⚡ Offline Cache Mode'}
          </span>
          {pendingSyncCount > 0 && (
            <span className="badge badge-offline">
              {pendingSyncCount} Pending Sync
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span className="badge badge-role">
            {currentUser.name} (
            {currentUser.role === 'admin'
              ? 'admin'
              : currentUser.canManageUsers
                ? 'Manager'
                : 'user'}
            )
          </span>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleGenerateInviteQr}
            disabled={generatingInvite}
          >
            📱 Invite User (QR Code)
          </button>

          {(currentUser.role === 'admin' || currentUser.canManageUsers) && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                const nextState = !adminTabOpen;
                setAdminTabOpen(nextState);
                if (nextState && apiKey) {
                  void fetchAllUsersForAdmin(apiKey);
                }
              }}
            >
              🛡️ {adminTabOpen ? 'Hide Users' : 'Manage Users'}
            </button>
          )}

          <button type="button" className="btn btn-danger btn-sm" onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </footer>

      {/* Admin / User Manager Management Section */}
      {(currentUser.role === 'admin' || currentUser.canManageUsers) && adminTabOpen && (
        <section className="card">
          <div className="card-title">
            <span>🛡️ System Users & Access Control</span>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => apiKey && fetchAllUsersForAdmin(apiKey)}
            >
              Refresh
            </button>
          </div>
          {loadingUsers ? (
            <p style={{ color: 'var(--text-secondary)' }}>Loading users...</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role & Permissions</th>
                    <th>API Key Prefix</th>
                    <th>Status</th>
                    <th>Last Seen</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {allUsers.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.name}</strong>
                        {u.username ? ` (${u.username})` : ''}
                      </td>
                      <td>
                        {u.role === 'admin'
                          ? 'admin (full)'
                          : u.canManageUsers
                            ? 'Manager'
                            : 'user'}
                      </td>
                      <td>
                        <code>{u.apiKeyPrefix}...</code>
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            u.status === 'active' ? 'badge-online' : 'badge-offline'
                          }`}
                        >
                          {u.status}
                        </span>
                      </td>
                      <td>
                        {u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleString() : 'Never'}
                      </td>
                      <td>
                        {u.role !== 'admin' ? (
                          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                            {u.status !== 'revoked' && (
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                onClick={() => handleUpdateUserStatus(u.id, 'revoked')}
                              >
                                Revoke Access
                              </button>
                            )}
                            {u.status === 'revoked' && (
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                onClick={() => handleDeleteUser(u.id, u.name)}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                            Primary Admin
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Manage Stores Popup Modal */}
      {addStoreModalOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setAddStoreModalOpen(false);
            setCustomStoreInput('');
            setEditingStoreId(null);
            setEditingStoreName('');
            setStoreModalError(null);
          }}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="card-title">
              <span>🏬 Manage Stores</span>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  setAddStoreModalOpen(false);
                  setCustomStoreInput('');
                  setEditingStoreId(null);
                  setEditingStoreName('');
                  setStoreModalError(null);
                }}
              >
                Close
              </button>
            </div>

            {storeModalError && <div className="alert alert-error">{storeModalError}</div>}

            <form onSubmit={handleAddCustomStore} style={{ marginBottom: '1.25rem' }}>
              <label className="form-label" htmlFor="new-store-modal-input">
                Add New Store
              </label>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.35rem' }}>
                <input
                  id="new-store-modal-input"
                  className="input"
                  type="text"
                  placeholder="e.g., Trader Joe's"
                  value={customStoreInput}
                  onChange={(e) => setCustomStoreInput(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ flexShrink: 0 }}
                  disabled={!customStoreInput.trim()}
                >
                  Add Store
                </button>
              </div>
            </form>

            <div>
              <div className="form-label" style={{ marginBottom: '0.5rem' }}>
                Current Stores ({stores.length})
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem',
                  maxHeight: '280px',
                  overflowY: 'auto',
                }}
              >
                {stores.map((store) => (
                  <div
                    key={store.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.5rem',
                      padding: '0.55rem 0.75rem',
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                    }}
                  >
                    {editingStoreId === store.id ? (
                      <form
                        onSubmit={(e) => handleUpdateStore(store, e)}
                        style={{ display: 'flex', gap: '0.4rem', width: '100%', alignItems: 'center' }}
                      >
                        <input
                          className="input"
                          type="text"
                          value={editingStoreName}
                          onChange={(e) => setEditingStoreName(e.target.value)}
                          style={{ padding: '0.4rem 0.65rem', fontSize: '0.9rem' }}
                          autoFocus
                          required
                        />
                        <button
                          type="submit"
                          className="btn btn-sm btn-primary"
                          disabled={!editingStoreName.trim()}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={() => {
                            setEditingStoreId(null);
                            setEditingStoreName('');
                            setStoreModalError(null);
                          }}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        <span style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
                          🏬 {store.name}
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={() => {
                            setEditingStoreId(store.id);
                            setEditingStoreName(store.name);
                            setStoreModalError(null);
                          }}
                        >
                          Edit
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Live Camera Modal */}
      {cameraModalOpen && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <div className="card-title">
              <span>📷 Take Item Picture</span>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={closeLiveCamera}
              >
                Close
              </button>
            </div>
            <video
              ref={videoRef}
              playsInline
              muted
              style={{
                width: '100%',
                borderRadius: 8,
                background: '#000',
                marginBottom: '1rem',
              }}
            />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={captureFrameFromVideo}
              >
                📸 Capture Photo
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeLiveCamera}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Code Invite Modal */}
      {inviteModalOpen && generatedInvite && (
        <div className="modal-backdrop">
          <div className="modal-content" style={{ textAlign: 'center' }}>
            <div className="card-title">
              <span>📱 Scan QR Code to Add User</span>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => setInviteModalOpen(false)}
              >
                Close
              </button>
            </div>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              Have the new user scan this QR code with their phone camera. This invite is valid for{' '}
              <strong>1 use only</strong> and <strong>expires in 30 minutes</strong> (at{' '}
              {new Date(generatedInvite.expiresAt).toLocaleTimeString()}).
            </p>
            <div
              style={{
                background: '#ffffff',
                padding: '1rem',
                borderRadius: 12,
                display: 'inline-block',
                marginBottom: '1rem',
              }}
            >
              <img
                src={generatedInvite.qrCodeDataUrl}
                alt="Invite QR Code"
                width={260}
                height={260}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%' }}
              onClick={() => setInviteModalOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Attached Photo Lightbox Modal */}
      {previewImage && (
        <div className="modal-backdrop" onClick={() => setPreviewImage(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="card-title">
              <span>🖼️ Attached Item Picture</span>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => setPreviewImage(null)}
              >
                Close
              </button>
            </div>
            <img
              src={previewImage}
              alt="Item full preview"
              style={{ width: '100%', borderRadius: 8 }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Service Worker for Panino PWA
const APP_VERSION = import.meta.env.VITE_APP_VERSION || "dev";
const CACHE_NAME = `panino-${APP_VERSION}`;
const RUNTIME_CACHE = `panino-runtime-${APP_VERSION}`;

function offlineResponse() {
  return new Response(
    JSON.stringify({
      error: "offline",
      message:
        "You are currently offline. Changes will sync when you reconnect.",
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    },
  );
}

// Assets to cache immediately on install
// Only cache essential files that are guaranteed to exist
const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon.svg",
  "/wa-sqlite-async.wasm", // WASM file for SQLite
];

// Install event - precache essential assets
self.addEventListener("install", (event) => {
  console.info("[SW] Installing service worker...");

  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        console.info("[SW] Precaching assets");
        // Cache assets individually to prevent one failure from blocking all
        return Promise.allSettled(
          PRECACHE_ASSETS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn(`[SW] Failed to cache ${url}:`, err);
            }),
          ),
        );
      })
      .then(() => {
        console.info("[SW] Skip waiting");
        return self.skipWaiting();
      }),
  );
});

// Activate event - clean up old caches
self.addEventListener("activate", (event) => {
  console.info("[SW] Activating service worker...");

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME && name !== RUNTIME_CACHE)
            .map((name) => {
              console.info("[SW] Deleting old cache:", name);
              return caches.delete(name);
            }),
        );
      })
      .then(() => {
        console.info("[SW] Claiming clients");
        return self.clients.claim();
      }),
  );
});

// Fetch event - implement caching strategy
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // API requests - Network First (with cache fallback for offline)
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only cache GET requests — Cache API doesn't support POST
          if (response.status === 200 && request.method === "GET") {
            const responseClone = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Offline — only try cache match for GET
          if (request.method === "GET") {
            return caches.match(request).then((cachedResponse) => {
              if (cachedResponse) {
                return cachedResponse;
              }
              return offlineResponse();
            });
          }
          return offlineResponse();
        }),
    );
    return;
  }

  // Static assets and app shell - Cache First (with network fallback)
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached version and update cache in background
        fetch(request)
          .then((response) => {
            if (response.status === 200) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, response);
              });
            }
          })
          .catch(() => {
            // Ignore fetch errors when updating cache
          });
        return cachedResponse;
      }

      // Not in cache - fetch from network
      return fetch(request)
        .then((response) => {
          // Cache successful responses
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch((error) => {
          console.error("[SW] Fetch failed:", error);

          // For navigation requests, return the cached index.html
          if (request.mode === "navigate") {
            return caches.match("/index.html");
          }

          throw error;
        });
    }),
  );
});

// Message event - handle messages from the app
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (event.data && event.data.type === "CLEAR_CACHE") {
    event.waitUntil(
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => caches.delete(cacheName)),
        );
      }),
    );
  }
});

// Periodic background sync (if supported)
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-notes") {
    console.info("[SW] Background sync requested");
    event.waitUntil(
      // The actual sync will be handled by the app when it wakes up
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: "BACKGROUND_SYNC" });
        });
      }),
    );
  }
});

// frontend/src/main.js
import { createApp } from 'vue'
import { router } from './router'
import AppShell from './AppShell.vue'
import './assets/main.css'
import { useUiStore } from '@/store/uiStore'
import { useThemeStore } from '@/store/themeStore'
import { pinia } from './pinia'

const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'dev'

// Register Service Worker for PWA functionality
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js', { scope: '/' })
      .then((registration) => {
        console.info('[PWA] Service Worker registered:', registration.scope);

        // Check for updates periodically
        setInterval(() => {
          registration.update();
        }, 60000); // Check every minute

        // Listen for updates
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.info('[PWA] New version available, updating...', APP_VERSION);
              const ui = useUiStore();
              ui.addToast('Updating to the latest version...', 'info', 5000);
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch((error) => {
        console.error('[PWA] Service Worker registration failed:', error);
      });

    // Listen for messages from service worker
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'BACKGROUND_SYNC') {
        console.info('[PWA] Background sync message received');
        // Trigger sync if applicable
        import('@/store/syncStore').then(({ useSyncStore }) => {
          const syncStore = useSyncStore(pinia);
          if (syncStore.syncEnabled && syncStore.isInitialized) {
            syncStore.sync();
          }
        });
      }
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
  });
}

// Call the function
const app = createApp(AppShell)

app.use(pinia)
app.use(router)

// Apply the browser-local preference before rendering the application shell.
useThemeStore(pinia).initializeTheme()

// grab your UI store
const ui = useUiStore(pinia)

// override native alert
window.alert = (msg) => ui.addToast(String(msg))
// and register on each component as `this.$alert(...)`
app.config.globalProperties.$alert = window.alert

app.mount('#app')

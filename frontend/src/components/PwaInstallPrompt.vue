<template>
  <transition name="fade">
    <div
      v-if="showInstallPrompt"
      class="fixed bottom-10 left-4 right-4 z-40 rounded-lg border border-gray-200 bg-white p-4 shadow-xl md:left-auto md:right-4 md:w-96"
    >
      <div class="flex items-start justify-between">
        <div class="flex-1">
          <h3 class="pn-title-modal mb-2">Install Panino</h3>
          <p class="pn-body mb-3">
            Install this app on your device for quick access and offline use.
          </p>
          <div class="flex gap-3">
            <BaseButton
              variant="primary"
              size="md"
              @click="handleInstall"
            >
              Install
            </BaseButton>
            <BaseButton
              variant="secondary"
              size="md"
              @click="dismissPrompt"
            >
              Not now
            </BaseButton>
          </div>
        </div>
        <button
          @click="dismissPrompt"
          class="-m-1.5 ml-2 shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          aria-label="Dismiss install prompt"
        >
          <X class="h-5 w-5" />
        </button>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { X } from 'lucide-vue-next';
import BaseButton from '@/components/BaseButton.vue';

const showInstallPrompt = ref(false);
const deferredPrompt = ref(null);

function handleBeforeInstallPrompt(e) {
  // Prevent the mini-infobar from appearing on mobile
  e.preventDefault();
  // Stash the event so it can be triggered later
  deferredPrompt.value = e;

  // Check if user has previously dismissed the prompt
  const dismissed = localStorage.getItem('pwa-install-dismissed');
  if (!dismissed) {
    // Show the install prompt after a short delay
    setTimeout(() => {
      showInstallPrompt.value = true;
    }, 5000); // Show after 5 seconds
  }
}

async function handleInstall() {
  if (!deferredPrompt.value) return;

  // Show the install prompt
  deferredPrompt.value.prompt();

  // Wait for the user to respond to the prompt
  const { outcome } = await deferredPrompt.value.userChoice;

  console.info(`User response to the install prompt: ${outcome}`);

  // Clear the deferredPrompt
  deferredPrompt.value = null;
  showInstallPrompt.value = false;
}

function dismissPrompt() {
  showInstallPrompt.value = false;
  // Remember that the user dismissed it (expires in 7 days)
  const dismissedUntil = Date.now() + (7 * 24 * 60 * 60 * 1000);
  localStorage.setItem('pwa-install-dismissed', dismissedUntil.toString());
}

onMounted(() => {
  // Check if already installed
  if (window.matchMedia('(display-mode: standalone)').matches) {
    console.info('[PWA] App is already installed');
    return;
  }

  // Check if previously dismissed and not yet expired
  const dismissed = localStorage.getItem('pwa-install-dismissed');
  if (dismissed && parseInt(dismissed) > Date.now()) {
    return;
  }

  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
});

onUnmounted(() => {
  window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
});
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.fade-enter-from {
  opacity: 0;
  transform: translateY(20px);
}

.fade-leave-to {
  opacity: 0;
  transform: translateY(20px);
}
</style>

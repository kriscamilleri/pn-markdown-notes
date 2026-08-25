<template>
    <!-- Notice: we do NOT do another v-if here -->
    <div class="md:hidden border-t bg-gray-50">
        <div class="px-4 py-2 space-y-2">
            <!-- Show user name if authenticated -->
            <div
                v-if="authStore.isAuthenticated"
                class="text-gray-500 py-2 px-2"
                data-testid="mobile-menu-username-display"
            >
                {{
                    authStore.user?.name.replace(/\b\w/g, char => char.toUpperCase())
                    || 'Guest'
                }}
            </div>

            <!-- Sync Button (only if authenticated and not a guest) -->
            <div
                v-if="authStore.isAuthenticated && authStore.user?.name !== 'guest'"
                class="px-2"
            >
                <BaseButton
                    :isActive="syncStore.syncEnabled"
                    :disabled="!authStore.isAuthenticated || !syncStore.isOnline"
                    @click="handleToggleSync"
                    class="w-full"
                    data-testid="mobile-menu-sync-button"
                >
                    <RefreshCw
                        :class="[
                            !syncStore.isOnline ? 'text-gray-400' : '',
                            syncStore.isSyncing ? 'animate-spin' : ''
                        ]"
                        class="w-4 h-4"
                    />
                    <span v-if="!syncStore.isOnline">Offline</span>
                    <span v-else-if="syncStore.isSyncing">Syncing...</span>
                    <span v-else>Sync {{ syncStore.syncEnabled ? 'On' : 'Off' }}</span>
                </BaseButton>
            </div>

            <!-- About link -->
            <BaseButton
                v-if="authStore.isAuthenticated"
                @click="goToImages"
                class="w-full"
                data-testid="mobile-menu-images-button"
            >
                <Image class="w-4 h-4" />
                <span>Images</span>
            </BaseButton>

            <BaseButton
                v-if="authStore.isAuthenticated"
                @click="goToRevisions"
                class="w-full"
                data-testid="mobile-menu-revisions-button"
            >
                <History class="w-4 h-4" />
                <span>Revisions</span>
            </BaseButton>

            <BaseButton
                v-if="authStore.isAuthenticated"
                @click="goToSettings"
                class="w-full"
                data-testid="mobile-menu-settings-button"
            >
                <Settings class="w-4 h-4" />
                <span>Account Settings</span>
            </BaseButton>

            <BaseButton
                v-if="authStore.isAuthenticated && syncStore.sharedSpacesAvailable"
                @click="goToSpaces"
                class="w-full"
                data-testid="mobile-menu-spaces-button"
            >
                <Users class="w-4 h-4" />
                <span>Spaces</span>
            </BaseButton>

            <BaseButton
                as="a"
                href="https://github.com/kriscamilleri/pn-markdown-notes"
                target="_blank"
                class="w-full"
                data-testid="mobile-menu-about-link"
            >
                <Info
                    class="w-4 h-4"
                    title="About"
                />
                <span>About</span>
            </BaseButton>

            <!-- Login/Logout -->
            <div class="py-2">
                <BaseButton
                    v-if="!authStore.isAuthenticated"
                    @click="goToLogin"
                    class="w-full"
                    data-testid="mobile-menu-login-button"
                >
                    <LogIn
                        class="w-4 h-4"
                        title="Login"
                    />
                    <span>Login</span>
                </BaseButton>
                <BaseButton
                    v-else
                    @click="handleLogout"
                    class="w-full"
                    data-testid="mobile-menu-logout-button"
                >
                    <LogOut
                        class="w-4 h-4"
                        title="Logout"
                    />
                    <span>Logout</span>
                </BaseButton>
            </div>
        </div>
    </div>
</template>

<script setup>
import { useAuthStore } from '@/store/authStore'
import { useSyncStore } from '@/store/syncStore'
import { useUiStore } from '@/store/uiStore'
import { useRouter } from 'vue-router'
import BaseButton from '@/components/BaseButton.vue'
import { RefreshCw, Info, LogIn, LogOut, Image, History, Settings, Users } from 'lucide-vue-next'

const emit = defineEmits(['close'])
const authStore = useAuthStore()
const syncStore = useSyncStore()
const uiStore = useUiStore()
const router = useRouter()

async function handleToggleSync() {
    // Check if offline first
    if (!syncStore.isOnline) {
        uiStore.addToast('Cannot sync while offline. Changes will sync when you reconnect.', 'warning');
        return;
    }

    // Check authentication
    if (!authStore.isAuthenticated) {
        uiStore.addToast('Please log in again to enable sync.', 'warning');
        return;
    }

    // If trying to enable sync (currently disabled)
    if (!syncStore.syncEnabled) {
        // Try refreshing the token if sync was disabled due to auth failure
        console.info('[MobileMenu] Attempting to refresh token before enabling sync...');
        const refreshed = await authStore.refreshToken();
        if (!refreshed) {
            uiStore.addToast('Session expired. Please log in again to enable sync.', 'warning');
            return;
        }

        // Enable sync and show success message
        syncStore.setSyncEnabled(true);
        uiStore.addToast('Sync enabled. Your documents will sync automatically.', 'success', 3000);
    } else {
        // Disable sync
        syncStore.setSyncEnabled(false);
        uiStore.addToast('Sync disabled. Changes will be stored locally only.', 'info', 3000);
    }
}

async function handleLogout() {
    try {
        await authStore.logout()
        router.push('/login')
    } catch (err) {
        console.error('Error logging out:', err)
    } finally {
        emit('close')
    }
}

function goToLogin() {
    router.push('/login')
    emit('close')
}

function goToImages() {
    router.push('/images')
    emit('close')
}

function goToRevisions() {
    router.push('/revisions')
    emit('close')
}

function goToSettings() {
    router.push('/settings')
    emit('close')
}

function goToSpaces() {
    router.push('/spaces')
    emit('close')
}
</script>

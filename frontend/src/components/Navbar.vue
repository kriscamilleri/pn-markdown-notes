<template>
    <nav
        class="workspace-chrome bg-gray-100 border-b"
        :class="{ 'navbar-collapsed': ui.navbarCollapsed }"
    >
        <div class="flex items-center justify-between px-4 py-2">
            <div class="flex items-center space-x-4">

                <BaseButton
                    :isActive="ui.showViewMenu"
                    @click="ui.toggleViewMenu()"
                    title="Toggle View Menu"
                    data-testid="navbar-view-button"
                >

                    <Layout class="md:w-4 md:h-4 w-5 h-5" />
                    <span class="navbar-button-text hidden md:inline">View</span>

                </BaseButton>

                <BaseButton
                    :isActive="ui.showActionBar"
                    @click="ui.toggleActionBar()"
                    title="Toggle Editor"
                    data-testid="navbar-editor-button"
                >

                    <FilePenLine class="md:w-4 md:h-4 w-5 h-5" />
                    <span class="navbar-button-text hidden md:inline">Editor</span>

                </BaseButton>

                <BaseButton
                    :isActive="ui.showFileMenu"
                    @click="ui.toggleFileMenu()"
                    title="Toggle Tools Menu"
                    data-testid="navbar-tools-button"
                >

                    <Hammer class="md:w-4 md:h-4 w-5 h-5" />
                    <span class="navbar-button-text hidden md:inline">Tools</span>

                </BaseButton>

                <BaseButton
                    v-if="authStore.isAuthenticated && authStore.user?.name !== 'guest'"
                    :isActive="syncStore.syncEnabled"
                    :disabled="!authStore.isAuthenticated || !syncStore.isOnline"
                    @click="handleToggleSync"
                    :title="!syncStore.isOnline ? 'Offline - Sync unavailable' : syncStore.isSyncing ? 'Syncing...' : 'Toggle Sync'"
                    data-testid="navbar-sync-button"
                >

                    <RefreshCw
                        :class="[
                            !syncStore.isOnline ? 'text-gray-400' : syncStore.syncEnabled ? '' : 'text-red-500',
                            syncStore.isSyncing ? 'animate-spin' : ''
                        ]"
                        class="w-4 h-4"
                    />
                    <span class="navbar-button-text hidden md:inline">
                        <span v-if="!syncStore.isOnline">Offline</span>
                        <span v-else-if="syncStore.isSyncing">Syncing...</span>
                        <span v-else>Sync {{ syncStore.syncEnabled ? 'On' : 'Off' }}</span>
                    </span>

                </BaseButton>
            </div>

            <div class="flex items-center space-x-4">
                <BaseButton
                    :aria-pressed="themeStore.theme === 'dark'"
                    :title="themeStore.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
                    @click="themeStore.toggleTheme()"
                    data-testid="navbar-theme-toggle"
                >
                    <span class="navbar-button-text hidden md:inline">
                        {{ themeStore.theme === 'dark' ? 'Light' : 'Dark' }}
                    </span>
                    <Sun
                        v-if="themeStore.theme === 'dark'"
                        class="w-4 h-4"
                    />
                    <Moon
                        v-else
                        class="w-4 h-4"
                    />
                </BaseButton>

                <div class="hidden md:flex items-center space-x-4">
                    <router-link
                        v-if="authStore.isAuthenticated"
                        to="/settings"
                        custom
                        v-slot="{ navigate }"
                    >
                        <BaseButton
                            @click="navigate"
                            data-testid="navbar-username-display"
                        >
                            <User class="w-4 h-4" />
                            <span class="navbar-button-text">{{ authStore.user?.name || authStore.user?.email ||
                                authStore.user?.id }}</span>
                        </BaseButton>
                    </router-link>

                    <BaseButton
                        as="a"
                        href="https://github.com/kriscamilleri/pn-markdown-notes"
                        target="_blank"
                        data-testid="navbar-about-link"
                    >
                        <Info
                            class="w-4 h-4"
                            title="About"
                        />
                        <span class="navbar-button-text">About</span>
                    </BaseButton>

                    <BaseButton
                        v-if="!authStore.isAuthenticated"
                        @click="goToLogin"
                        data-testid="navbar-login-button"
                    >

                        <LogIn
                            class="w-4 h-4"
                            title="Login"
                        />
                        <span class="navbar-button-text">Login</span>

                    </BaseButton>
                    <BaseButton
                        v-else
                        @click="handleLogout"
                        data-testid="navbar-logout-button"
                    >

                        <LogOut
                            class="w-4 h-4"
                            title="Logout"
                        />
                        <span class="navbar-button-text">Logout</span>

                    </BaseButton>
                </div>

                <BaseButton
                    class="hidden md:inline-flex"
                    :is-active="ui.navbarCollapsed"
                    :icon-only="ui.navbarCollapsed"
                    :title="ui.navbarCollapsed ? 'Expand navigation labels' : 'Collapse navigation labels'"
                    @click="ui.toggleNavbarCollapsed()"
                    data-testid="navbar-collapse-button"
                >
                    <PanelLeftOpen
                        v-if="ui.navbarCollapsed"
                        class="w-4 h-4"
                    />
                    <PanelLeftClose
                        v-else
                        class="w-4 h-4"
                    />
                    <span
                        v-if="!ui.navbarCollapsed"
                        class="navbar-button-text"
                    >Collapse</span>
                </BaseButton>

                <div class="md:hidden">
                    <BaseButton
                        @click="toggleMobileMenu"
                        data-testid="navbar-mobile-menu-button"
                    >

                        <Menu class="w-6 h-6" />

                    </BaseButton>
                </div>
            </div>
        </div>

        <transition
            name="fade-fast"
            mode="out-in"
        >

            <MobileMenu
                v-if="isMobileMenuOpen"
                @close="toggleMobileMenu"
                data-testid="mobile-menu-component"
            />

        </transition>
    </nav>
</template>

<script setup>
import { ref } from 'vue'
import { useUiStore } from '@/store/uiStore'
import { useAuthStore } from '@/store/authStore'
import { useSyncStore } from '@/store/syncStore'
import { useThemeStore } from '@/store/themeStore'
import { useRouter } from 'vue-router'

import BaseButton from '@/components/BaseButton.vue'
import MobileMenu from './MobileMenu.vue'

import {
    Layout,
    FilePenLine,
    Hammer,
    RefreshCw,
    Info,
    LogIn,
    LogOut,
    Menu,
    User,
    Moon,
    Sun,
    PanelLeftClose,
    PanelLeftOpen
} from 'lucide-vue-next'

const ui = useUiStore()
const authStore = useAuthStore()
const syncStore = useSyncStore()
const themeStore = useThemeStore()
const router = useRouter()

const isMobileMenuOpen = ref(false)

function toggleMobileMenu() {
    isMobileMenuOpen.value = !isMobileMenuOpen.value
}

async function handleToggleSync() {
    const uiStore = useUiStore();

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
        console.info('[Navbar] Attempting to refresh token before enabling sync...');
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
    }
}

function goToLogin() {
    router.push('/login')
}
</script>

<style scoped>
/* Ensure BaseButton styling applies correctly to the About link */
a[data-testid="navbar-about-link"] {
    display: inline-flex;
    align-items: center;
}

@media (min-width: 768px) {
    .navbar-collapsed .navbar-button-text {
        display: none;
    }
}
</style>

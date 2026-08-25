// /frontend/src/store/authStore.js
import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { useSyncStore } from './syncStore';
import { useDocStore } from './docStore';

// The single, unified API URL
const isProd = import.meta.env.PROD;
const API_SERVICE_URL = isProd ? '/api' : (import.meta.env.VITE_API_SERVICE_URL || 'http://localhost:8000');

export const useAuthStore = defineStore('authStore', () => {
    const token = ref(localStorage.getItem('jwt_token'));
    const user = ref(null);

    const isAuthenticated = computed(() => !!token.value);

    let refreshTimer = null;

    // Schedule token refresh before it expires
    function scheduleTokenRefresh() {
        if (refreshTimer) clearTimeout(refreshTimer);
        
        if (!token.value) return;
        
        try {
            const payload = JSON.parse(atob(token.value.split('.')[1]));
            const expiresAt = payload.exp * 1000; // Convert to milliseconds
            const now = Date.now();
            const timeUntilExpiry = expiresAt - now;
            
            // Refresh 5 minutes before expiry
            const refreshTime = Math.max(0, timeUntilExpiry - 5 * 60 * 1000);
            
            console.info(`[Auth] Token expires in ${Math.round(timeUntilExpiry / 1000 / 60)} minutes, will refresh in ${Math.round(refreshTime / 1000 / 60)} minutes`);
            
            refreshTimer = setTimeout(async () => {
                console.info('[Auth] Proactively refreshing token...');
                const success = await refreshToken();
                if (success) {
                    console.info('[Auth] Token refreshed successfully');
                } else {
                    console.warn('[Auth] Token refresh failed');
                }
            }, refreshTime);
        } catch (e) {
            console.error('[Auth] Failed to schedule token refresh:', e);
        }
    }

    watch(token, (newToken) => {
        const syncStore = useSyncStore();
        if (newToken) {
            localStorage.setItem('jwt_token', newToken);
            try {
                const payload = JSON.parse(atob(newToken.split('.')[1]));
                // Store basic info from token, full profile fetched separately
                user.value = { id: payload.user_id, name: payload.name, email: payload.email };
                scheduleTokenRefresh(); // Schedule refresh after setting token
            } catch (e) {
                console.error("Failed to decode JWT:", e);
                user.value = null;
                token.value = null;
            }
        } else {
            localStorage.removeItem('jwt_token');
            user.value = null;
            if (refreshTimer) {
                clearTimeout(refreshTimer);
                refreshTimer = null;
            }
            if (syncStore.isInitialized) {
                syncStore.resetDatabase();
            }
        }
    }, { immediate: true });

    async function signup(name, email, password, turnstileToken = '') {
        const response = await fetch(`${API_SERVICE_URL}/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password, 'cf-turnstile-response': turnstileToken }),
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.details || data.error || 'Signup failed');
        }
        return data;
    }

    async function login(email, password) {
        const response = await fetch(`${API_SERVICE_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Login failed');

        const syncStore = useSyncStore();
        if (syncStore.isInitialized) await syncStore.resetDatabase();

        token.value = data.token;
        syncStore.connectWebSocket();
    }

    async function logout() {
        const syncStore = useSyncStore();
        syncStore.disconnectWebSocket();

        const docStore = useDocStore();
        await docStore.resetStore();
        token.value = null;
    }

    async function checkAuth() {
        token.value = localStorage.getItem('jwt_token');
        if (isAuthenticated.value) {
            useSyncStore().connectWebSocket();
        }
    }

    async function refreshToken() {
        if (!token.value) return false;
        
        try {
            const response = await fetch(`${API_SERVICE_URL}/refresh`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token.value}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                return false;
            }

            const data = await response.json();
            token.value = data.token;
            return true;
        } catch (error) {
            console.error('Token refresh failed:', error);
            return false;
        }
    }

    async function fetchMe() {
        if (!isAuthenticated.value) return;
        const response = await fetch(`${API_SERVICE_URL}/me`, {
            headers: { Authorization: `Bearer ${token.value}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to fetch user profile');
        user.value = { ...user.value, ...data }; // Merge with existing data
        return user.value;
    }

    async function updatePassword(currentPassword, newPassword) {
        const response = await fetch(`${API_SERVICE_URL}/me/password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.value}` },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to update password');
        return data;
    }

    async function forgotPassword(email) {
        const response = await fetch(`${API_SERVICE_URL}/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    async function resetPassword(token, newPassword) {
        const response = await fetch(`${API_SERVICE_URL}/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, newPassword })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Password reset failed');
        return data;
    }

    return {
        token, user, isAuthenticated,
        signup, login, logout, checkAuth,
        fetchMe, refreshToken,
        updatePassword, forgotPassword, resetPassword
    };
});
<template>
    <AuthForm :config="loginConfig" />
</template>

<script setup>
import AuthForm from './AuthForm.vue';
import { useAuthStore } from '../store/authStore';
import { useRoute, useRouter } from 'vue-router';

const authStore = useAuthStore();
const router = useRouter();
const route = useRoute();

const loginConfig = {
    type: 'login',
    title: 'Sign In',
    fields: [
        { name: 'email', label: 'Email Address', type: 'email', required: true },
        { name: 'password', label: 'Password', type: 'password', required: true }
    ],
    submitText: 'Sign In',
    loadingText: 'Signing in...',
    submitAction: async (formData) => {
        await authStore.login(formData.email, formData.password);
        const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
            ? route.query.redirect
            : '';
        router.push({
            name: 'loading',
            params: { timestamp: Date.now() },
            query: redirect ? { redirect } : {},
        });
    },
    link: { to: '/signup', text: "Don't have an account? Sign up" },
    extraLink: { to: '/forgot-password', text: 'Forgot password?' }
};
</script>

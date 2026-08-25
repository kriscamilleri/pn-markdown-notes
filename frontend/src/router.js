import { createRouter, createWebHashHistory } from "vue-router";
import HomePage from "@/pages/HomePage.vue";
import StylesPage from "@/pages/StylesPage.vue";
import LoginForm from "@/components/LoginForm.vue";
import SignupForm from "@/components/SignupForm.vue";
import LoadingPage from "@/pages/LoadingPage.vue";
import PrintStylesPage from "@/pages/PrintStylesPage.vue";
import TermsOfServicePage from "@/pages/TermsOfServicePage.vue";
import SettingsPage from "@/pages/SettingsPage.vue";
import ForgotPasswordPage from "@/pages/ForgotPasswordPage.vue";
import ResetPasswordPage from "@/pages/ResetPasswordPage.vue";
import ImageManagerPage from "@/pages/ImageManagerPage.vue";
import TemplateManagerPage from "@/pages/TemplateManagerPage.vue";
import { pinia } from "./pinia";
import RevisionHistoryPage from "@/pages/RevisionHistoryPage.vue";
import SpacesPage from "@/pages/SpacesPage.vue";
import AcceptSpaceInvitePage from "@/pages/AcceptSpaceInvitePage.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      name: "home",
      component: HomePage,
      meta: { keepAlive: true },
    },
    {
      path: "/doc/:fileId",
      name: "doc",
      component: HomePage,
      props: true,
      meta: { keepAlive: true },
    },
    {
      path: "/folder/:folderId",
      name: "folder",
      component: HomePage,
      props: true,
      meta: { keepAlive: true },
    },
    {
      path: "/styles",
      name: "styles",
      component: StylesPage,
      meta: { keepAlive: true },
    },
    {
      path: "/print-styles",
      name: "print-styles",
      component: PrintStylesPage,
      meta: { keepAlive: true },
    },
    {
      path: "/login",
      name: "login",
      component: LoginForm,
    },
    {
      path: "/signup",
      name: "signup",
      component: SignupForm,
    },
    {
      path: "/loading/:timestamp?",
      name: "loading",
      component: LoadingPage,
    },
    {
      path: "/terms",
      name: "terms",
      component: TermsOfServicePage,
    },
    {
      path: "/settings",
      name: "settings",
      component: SettingsPage,
    },
    {
      path: "/spaces",
      name: "spaces",
      component: SpacesPage,
    },
    {
      path: "/spaces/invitations/:token?",
      name: "space-invitation",
      component: AcceptSpaceInvitePage,
    },
    {
      path: "/images",
      name: "images",
      component: ImageManagerPage,
    },
    {
      path: "/templates",
      name: "templates",
      component: TemplateManagerPage,
      meta: { keepAlive: true },
    },
    {
      path: "/revisions",
      name: "revisions",
      component: RevisionHistoryPage,
      meta: { keepAlive: true },
    },
    {
      path: "/forgot-password",
      name: "forgot-password",
      component: ForgotPasswordPage,
    },
    {
      path: "/reset-password/:token",
      name: "reset-password",
      component: ResetPasswordPage,
      props: true,
    },
  ],
});

// Global guard
router.beforeEach(async (to, from, next) => {
  // Use dynamic imports to avoid pinia activation issues
  const { useAuthStore } = await import("@/store/authStore");
  const { useSyncStore } = await import("@/store/syncStore");

  const authStore = useAuthStore(pinia);
  const syncStore = useSyncStore(pinia);

  // Attempt to check if user is logged in
  await authStore.checkAuth();

  // If NOT authenticated, redirect to login
  if (
    !authStore.isAuthenticated &&
    ![
      "login",
      "signup",
      "loading",
      "terms",
      "forgot-password",
      "reset-password",
    ].includes(to.name)
  ) {
    return next({ name: "login", query: { redirect: to.fullPath } });
  }

  // If authenticated but local DB not initialized, go to loading
  if (
    authStore.isAuthenticated &&
    !syncStore.isInitialized &&
    to.name !== "space-invitation"
  ) {
    if (to.name !== "loading") {
      return next({
        name: "loading",
        params: { timestamp: Date.now() },
      });
    }
  }

  next();
});

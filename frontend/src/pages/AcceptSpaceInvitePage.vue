<template>
  <AccountLayout title="Space invitation" max-width-class="max-w-xl">
    <div v-if="accepted" class="pn-alert pn-alert-success" data-testid="invite-accepted">
      Invitation accepted. The space is being added to this device.
    </div>
    <div v-else-if="terminalError" class="pn-alert pn-alert-error" data-testid="invite-error">
      {{ terminalError }}
    </div>
    <div v-else>
      <h2 class="pn-title-modal">Accept invitation?</h2>
      <p class="pn-body mt-2">
        Continue only if you are signed in with the email address that received this invitation.
        Visiting this page does not accept it automatically.
      </p>
      <div class="mt-5 flex justify-end gap-3">
        <BaseButton variant="secondary" size="md" @click="router.push('/spaces')">Cancel</BaseButton>
        <BaseButton
          variant="primary"
          size="md"
          :disabled="pending || !token"
          data-testid="invite-accept"
          @click="accept"
        >
          Accept invitation
        </BaseButton>
      </div>
    </div>
  </AccountLayout>
</template>

<script setup>
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AccountLayout from "@/components/AccountLayout.vue";
import BaseButton from "@/components/BaseButton.vue";
import { useSpacesStore } from "@/store/spacesStore";

const route = useRoute();
const router = useRouter();
const spacesStore = useSpacesStore();
const token = typeof route.params.token === "string" ? route.params.token : "";
const pending = ref(false);
const accepted = ref(false);
const terminalError = ref(token ? "" : "This invitation is invalid, expired, revoked, or already used.");

async function clearTokenFromAddress() {
  await router.replace({ name: "space-invitation" });
}

async function accept() {
  if (!token || pending.value) return;
  pending.value = true;
  try {
    await spacesStore.acceptInvitation(token);
    accepted.value = true;
  } catch (error) {
    terminalError.value = error.message || "This invitation is invalid, expired, revoked, or already used.";
  } finally {
    pending.value = false;
    await clearTokenFromAddress();
  }
}
</script>


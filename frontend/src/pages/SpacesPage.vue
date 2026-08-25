<template>
  <AccountLayout title="Spaces" max-width-class="max-w-6xl">
    <div v-if="!syncStore.sharedSpacesAvailable" class="pn-alert pn-alert-info">
      Shared spaces are not available on this server.
    </div>

    <template v-else>
      <section class="border-b border-gray-200 pb-6">
        <h2 class="pn-title-modal">Create a space</h2>
        <p class="pn-body mt-1">A space is a shared Document tree for owners and editors.</p>
        <form class="mt-4 flex flex-col gap-3 sm:flex-row" @submit.prevent="create">
          <label class="sr-only" for="space-name">Space name</label>
          <input
            id="space-name"
            v-model="newName"
            class="pn-input flex-1"
            maxlength="100"
            placeholder="Space name"
            required
            data-testid="space-create-name"
          />
          <BaseButton variant="primary" size="md" :disabled="pending" data-testid="space-create">
            <Plus class="h-4 w-4" />
            <span>Create space</span>
          </BaseButton>
        </form>
      </section>

      <section class="border-b border-gray-200 py-6" data-testid="pending-space-invitations">
        <h2 class="pn-title-modal">Invitations to you</h2>
        <p class="pn-body mt-1">Accept an invitation to add its space to this device.</p>
        <div v-if="spacesStore.pendingInvitationsLoading" class="pn-panel-muted mt-4 p-4 pn-body">
          Loading invitations…
        </div>
        <div v-else-if="spacesStore.pendingInvitationsError" class="pn-alert pn-alert-error mt-4">
          {{ spacesStore.pendingInvitationsError }}
        </div>
        <div v-else-if="!spacesStore.pendingInvitations.length" class="pn-panel-muted mt-4 p-4 pn-body">
          No pending invitations.
        </div>
        <div v-else class="mt-4">
          <div class="space-y-3 sm:hidden">
            <article
              v-for="invitation in spacesStore.pendingInvitations"
              :key="invitation.id"
              class="rounded-lg border border-gray-200 p-4"
            >
              <h3 class="text-sm font-semibold text-gray-900">{{ invitation.spaceName }}</h3>
              <p class="pn-meta mt-1 capitalize">
                {{ invitation.role }} · Expires {{ formatDate(invitation.expiresAt) }}
              </p>
              <BaseButton
                class="mt-3 w-full"
                variant="primary"
                size="md"
                :disabled="pending"
                :data-testid="`accept-space-invitation-${invitation.id}`"
                @click="acceptPendingInvitation(invitation)"
              >Accept invitation</BaseButton>
            </article>
          </div>
          <div class="pn-table-wrap hidden sm:block">
            <table class="pn-table">
            <thead><tr><th>Space</th><th>Role</th><th>Expires</th><th>Action</th></tr></thead>
            <tbody>
              <tr v-for="invitation in spacesStore.pendingInvitations" :key="invitation.id">
                <td class="font-medium text-gray-900">{{ invitation.spaceName }}</td>
                <td class="capitalize">{{ invitation.role }}</td>
                <td>{{ formatDate(invitation.expiresAt) }}</td>
                <td>
                  <BaseButton
                    variant="primary"
                    :disabled="pending"
                    :data-testid="`accept-space-invitation-${invitation.id}-desktop`"
                    @click="acceptPendingInvitation(invitation)"
                  >Accept</BaseButton>
                </td>
              </tr>
            </tbody>
            </table>
          </div>
        </div>
      </section>

      <div class="mt-6 grid gap-6 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,2fr)]">
        <section>
          <h2 class="pn-title-section mb-3">Your spaces</h2>
          <div v-if="!spacesStore.spaces.length" class="pn-panel-muted p-4 pn-body">
            No shared spaces yet.
          </div>
          <div v-else class="space-y-2" data-testid="spaces-list">
            <button
              v-for="space in spacesStore.spaces"
              :key="space.id"
              type="button"
              class="w-full rounded-lg border p-3 text-left transition-colors"
              :class="selectedId === space.id ? 'border-gray-500 bg-gray-100' : 'border-gray-200 hover:bg-gray-50'"
              @click="selectSpace(space.id)"
            >
              <span class="block truncate text-sm font-semibold text-gray-900">{{ space.name }}</span>
              <span class="pn-meta capitalize">{{ space.role }} · {{ space.members.length }} members</span>
            </button>
          </div>
        </section>

        <section v-if="selectedId" class="min-w-0">
          <div v-if="spacesStore.loading" class="pn-panel-muted p-4 pn-body">Loading space…</div>
          <div v-else-if="spacesStore.error" class="pn-alert pn-alert-error">{{ spacesStore.error }}</div>
          <template v-else-if="spacesStore.detail">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 class="pn-title-modal">{{ spacesStore.detail.space.name }}</h2>
                <p class="pn-meta mt-1 capitalize">Your role: {{ spacesStore.detail.space.role }}</p>
              </div>
              <AvatarStack :users="spacesStore.detail.members" :max="5" />
            </div>

            <form
              v-if="isOwner"
              class="mt-5 flex flex-col gap-3 rounded-lg border border-gray-200 p-4 sm:flex-row"
              @submit.prevent="rename"
            >
              <div class="flex-1">
                <label class="pn-label" for="space-rename">Space name</label>
                <input id="space-rename" v-model="renameName" class="pn-input mt-1" maxlength="100" required />
              </div>
              <BaseButton class="self-end" variant="secondary" size="md" :disabled="pending">
                Rename
              </BaseButton>
            </form>

            <section v-if="isOwner" class="mt-6">
              <h3 class="pn-title-section">Invite an editor</h3>
              <form class="mt-3 flex flex-col gap-3 sm:flex-row" @submit.prevent="invite">
                <div class="flex-1">
                  <label class="sr-only" for="space-invite-email">Email address</label>
                  <input
                    id="space-invite-email"
                    v-model="inviteEmail"
                    class="pn-input"
                    type="email"
                    placeholder="editor@example.com"
                    required
                    data-testid="space-invite-email"
                  />
                </div>
                <BaseButton variant="primary" size="md" :disabled="pending" data-testid="space-invite">
                  <MailPlus class="h-4 w-4" />
                  <span>Send invitation</span>
                </BaseButton>
              </form>
            </section>

            <section class="mt-6">
              <h3 class="pn-title-section mb-3">Members</h3>
              <div class="pn-table-wrap">
                <table class="pn-table" data-testid="space-members">
                  <thead><tr><th>Person</th><th>Role</th><th v-if="isOwner">Actions</th></tr></thead>
                  <tbody>
                    <tr v-for="member in spacesStore.detail.members" :key="member.id">
                      <td><div class="flex items-center gap-2"><UserAvatar :user="member" size="sm" /><span>{{ member.name }}</span></div></td>
                      <td class="capitalize">{{ member.role }}</td>
                      <td v-if="isOwner">
                        <div v-if="member.role === 'editor'" class="flex flex-wrap gap-1">
                          <BaseButton @click="confirmAction('transfer', member)">Transfer ownership</BaseButton>
                          <BaseButton variant="danger" @click="confirmAction('remove', member)">Remove</BaseButton>
                        </div>
                        <span v-else class="pn-meta">Current owner</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section v-if="isOwner" class="mt-6">
              <h3 class="pn-title-section mb-3">Pending invitations</h3>
              <div class="pn-table-wrap">
                <table class="pn-table" data-testid="space-invitations">
                  <thead><tr><th>Email</th><th>Expires</th><th>Actions</th></tr></thead>
                  <tbody>
                    <tr v-if="!spacesStore.detail.invitations.length"><td colspan="3" class="pn-table-empty">No pending invitations.</td></tr>
                    <tr v-for="invitation in spacesStore.detail.invitations" :key="invitation.id">
                      <td>{{ invitation.email }}</td>
                      <td>{{ formatDate(invitation.expiresAt) }}</td>
                      <td><div class="flex flex-wrap gap-1">
                        <BaseButton
                          v-if="invitationUrlFor(invitation)"
                          :disabled="pending"
                          @click="copyInvitationLink(invitation)"
                        >Copy link</BaseButton>
                        <BaseButton
                          :disabled="pending"
                          @click="copyNewInvitationLink(invitation)"
                        >Copy new link</BaseButton>
                        <BaseButton :disabled="pending" @click="resend(invitation)">Resend</BaseButton>
                        <BaseButton variant="danger" :disabled="pending" @click="revoke(invitation)">Revoke</BaseButton>
                      </div></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section class="mt-8 border-t border-gray-200 pt-6">
              <h3 class="pn-title-section">Danger zone</h3>
              <p class="pn-body mt-1">
                Revoking access stops future server access, but copies already stored on a member's device cannot be recalled.
              </p>
              <div class="mt-3">
                <BaseButton v-if="isOwner" variant="danger" data-testid="space-delete-request" @click="confirmAction('delete')">
                  Request space deletion
                </BaseButton>
                <BaseButton v-else variant="danger" data-testid="space-leave" @click="confirmAction('leave')">
                  Leave space
                </BaseButton>
              </div>
            </section>
          </template>
        </section>
      </div>
    </template>
  </AccountLayout>

  <BaseModal
    :show="Boolean(confirm.kind)"
    :title="confirmTitle"
    size="sm"
    :close-on-backdrop="false"
    @close="closeConfirm"
  >
    <p class="pn-body">{{ confirmMessage }}</p>
    <div v-if="confirm.kind === 'delete'" class="mt-4">
      <label class="pn-label" for="confirm-space-name">Type the space name to confirm</label>
      <input id="confirm-space-name" v-model="confirmationName" class="pn-input mt-1" data-testid="space-delete-confirm-name" />
      <p class="pn-help">Access ends immediately. Data is retained for 30 days before background deletion.</p>
    </div>
    <template #footer>
      <BaseButton variant="secondary" size="md" :disabled="pending" @click="closeConfirm">Cancel</BaseButton>
      <BaseButton variant="danger" size="md" :disabled="!canConfirm || pending" data-testid="space-confirm-action" @click="runConfirmedAction">
        Confirm
      </BaseButton>
    </template>
  </BaseModal>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { MailPlus, Plus } from "lucide-vue-next";
import { useRoute } from "vue-router";
import AccountLayout from "@/components/AccountLayout.vue";
import AvatarStack from "@/components/AvatarStack.vue";
import BaseButton from "@/components/BaseButton.vue";
import BaseModal from "@/components/BaseModal.vue";
import UserAvatar from "@/components/UserAvatar.vue";
import { useSpacesStore } from "@/store/spacesStore";
import { useSyncStore } from "@/store/syncStore";
import { useUiStore } from "@/store/uiStore";
import { isSpaceOwner, normalizeInvitationEmail } from "@/utils/spaceLifecycle";

const spacesStore = useSpacesStore();
const syncStore = useSyncStore();
const uiStore = useUiStore();
const route = useRoute();
const selectedId = ref(null);
const newName = ref("");
const renameName = ref("");
const inviteEmail = ref("");
const invitationUrls = ref(new Map());
const confirmationName = ref("");
const pending = ref(false);
const confirm = reactive({ kind: "", member: null });

const isOwner = computed(() => isSpaceOwner(spacesStore.detail?.space));
const confirmTitle = computed(() => ({
  transfer: "Transfer ownership?",
  remove: "Remove this member?",
  leave: "Leave this space?",
  delete: "Request space deletion?",
})[confirm.kind] || "Confirm action");
const confirmMessage = computed(() => ({
  transfer: `Ownership will move to ${confirm.member?.name || "this editor"}. You will become an editor.`,
  remove: `${confirm.member?.name || "This member"} will immediately lose future access. Existing device copies cannot be remotely erased.`,
  leave: "You will immediately lose future access. Existing copies on this device will be removed from Panino's active registry.",
  delete: "Everyone will lose access immediately. This cannot recall copies already stored on members' devices.",
})[confirm.kind] || "");
const canConfirm = computed(() => (
  confirm.kind !== "delete" || confirmationName.value === spacesStore.detail?.space?.name
));

watch(() => spacesStore.detail?.space?.name, (name) => { renameName.value = name || ""; });

onMounted(() => {
  void spacesStore.loadPendingInvitations().catch(() => {});
  const requested = typeof route.query.space === "string" ? route.query.space : "";
  selectedId.value = spacesStore.spaces.some((space) => space.id === requested)
    ? requested
    : (spacesStore.spaces[0]?.id || null);
  if (selectedId.value) void selectSpace(selectedId.value);
});

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString() : "Unknown";
}

async function perform(action, successMessage) {
  pending.value = true;
  try {
    const result = await action();
    if (successMessage) uiStore.addToast(successMessage, "success");
    return result;
  } catch (error) {
    uiStore.addToast(error.message || "Unable to complete the space action.", "error");
    return null;
  } finally {
    pending.value = false;
  }
}

async function selectSpace(spaceId) {
  selectedId.value = spaceId;
  await perform(() => spacesStore.loadDetail(spaceId));
}

async function acceptPendingInvitation(invitation) {
  const result = await perform(
    () => spacesStore.acceptPendingInvitation(invitation.id),
    `Invitation to ${invitation.spaceName} accepted.`,
  );
  if (!result?.spaceId) return;
  await selectSpace(result.spaceId);
}

async function create() {
  const created = await perform(() => spacesStore.createSpace(newName.value), "Space created.");
  if (!created) return;
  newName.value = "";
  await selectSpace(created.id);
}

async function rename() {
  await perform(() => spacesStore.renameSpace(selectedId.value, renameName.value), "Space renamed.");
}

async function invite() {
  const result = await perform(
    () => spacesStore.invite(selectedId.value, normalizeInvitationEmail(inviteEmail.value)),
    "Invitation created.",
  );
  if (!result) return;
  inviteEmail.value = "";
  rememberInvitationUrl(result);
  if (!result.emailSent) uiStore.addToast("The invitation is saved, but email delivery failed. Try Resend.", "warning");
}

async function revoke(invitation) {
  await perform(() => spacesStore.revokeInvite(selectedId.value, invitation.id), "Invitation revoked.");
}

async function resend(invitation) {
  const result = await perform(() => spacesStore.resendInvite(selectedId.value, invitation.id), "A new invitation link was created.");
  if (result) rememberInvitationUrl(result);
  if (result && !result.emailSent) uiStore.addToast("Email delivery failed. Try Resend again.", "warning");
}

async function copyNewInvitationLink(invitation) {
  const result = await perform(
    () => spacesStore.resendInvite(selectedId.value, invitation.id),
    "A new invitation link was created.",
  );
  if (!result) return;
  rememberInvitationUrl(result);
  await copyInvitationUrl(result.invitationUrl);
  if (!result.emailSent) uiStore.addToast("Email delivery failed. Try Resend again.", "warning");
}

function rememberInvitationUrl(result) {
  const invitationId = result?.invitation?.id;
  if (!invitationId || !result.invitationUrl) return;
  invitationUrls.value = new Map([[invitationId, result.invitationUrl]]);
}

function invitationUrlFor(invitation) {
  return invitationUrls.value.get(invitation.id) || "";
}

async function copyInvitationLink(invitation) {
  const invitationUrl = invitationUrlFor(invitation);
  if (!invitationUrl) return;
  await copyInvitationUrl(invitationUrl);
}

async function copyInvitationUrl(invitationUrl) {
  try {
    await navigator.clipboard.writeText(invitationUrl);
    uiStore.addToast("Invitation link copied. Send it only to the invited email address.", "success");
  } catch {
    uiStore.addToast("Could not copy the invitation link. Try again or resend the invitation.", "error");
  }
}

function confirmAction(kind, member = null) {
  confirm.kind = kind;
  confirm.member = member;
  confirmationName.value = "";
}

function closeConfirm() {
  confirm.kind = "";
  confirm.member = null;
  confirmationName.value = "";
}

async function runConfirmedAction() {
  const kind = confirm.kind;
  const member = confirm.member;
  let result;
  if (kind === "transfer") {
    result = await perform(() => spacesStore.transferOwnership(selectedId.value, member.id), "Ownership transferred.");
  } else if (kind === "remove") {
    result = await perform(() => spacesStore.removeMember(selectedId.value, member.id), "Member removed.");
  } else if (kind === "leave") {
    result = await perform(() => spacesStore.leaveSpace(selectedId.value), "You left the space.");
    if (result !== null) selectedId.value = spacesStore.spaces[0]?.id || null;
  } else if (kind === "delete") {
    result = await perform(() => spacesStore.requestDeletion(selectedId.value), "Space deletion requested.");
    if (result) selectedId.value = spacesStore.spaces[0]?.id || null;
  }
  if (result !== null) closeConfirm();
}
</script>

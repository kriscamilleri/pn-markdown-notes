<template>
  <section
    v-if="store.recoverable.length"
    class="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
    data-testid="document-transfer-recovery"
  >
    <p class="font-medium">Document transfer needs attention</p>
    <p class="mt-1 text-xs">
      The destination copy is preserved. Revision history remains in the source database.
    </p>
    <div
      v-for="transfer in store.recoverable"
      :key="transfer.id"
      class="mt-3 border-t border-amber-200 pt-3"
    >
      <p>{{ transfer.lastError || 'The transfer can be resumed safely.' }}</p>
      <ul v-if="transfer.warnings?.length" class="mt-1 list-disc pl-5 text-xs">
        <li v-for="warning in transfer.warnings" :key="`${transfer.id}:${warning.imageId}`">
          {{ warning.message }}
        </li>
      </ul>
      <div class="mt-2 flex flex-wrap gap-2">
        <BaseButton
          variant="primary"
          :disabled="store.working"
          data-testid="document-transfer-retry"
          @click="run(transfer.id, 'retry')"
        >Retry</BaseButton>
        <BaseButton
          v-if="canResolveDuplicate(transfer)"
          variant="secondary"
          :disabled="store.working"
          data-testid="document-transfer-keep-both"
          @click="run(transfer.id, 'keepBoth')"
        >Keep both</BaseButton>
        <BaseButton
          v-if="canResolveDuplicate(transfer)"
          variant="danger"
          :disabled="store.working"
          data-testid="document-transfer-delete-source"
          @click="run(transfer.id, 'deleteSource')"
        >Delete source</BaseButton>
      </div>
    </div>
  </section>

  <BaseModal
    :show="Boolean(store.pending)"
    title="Move Document to another database?"
    subtitle="This changes who can read the Document."
    :dismissible="!store.working"
    :close-on-backdrop="!store.working"
    data-testid="document-transfer-confirmation"
    @close="store.cancel"
  >
    <div class="space-y-3 text-sm text-gray-700">
      <p>
        Move <strong>{{ store.pending?.documentName || 'this Document' }}</strong>
        from <strong>{{ store.pending?.sourceName }}</strong> to
        <strong>{{ store.pending?.destinationName }}</strong>?
      </p>
      <p class="rounded-md bg-amber-50 px-3 py-2 text-amber-900">
        Revision history stays in the source database and will not appear on the moved copy.
      </p>
      <p>
        Canonical images will be copied and verified first. Missing or noncanonical source images
        are preserved in the Markdown and shown as warnings.
      </p>
      <p v-if="store.error" class="text-red-600" role="alert">{{ store.error }}</p>
    </div>
    <template #footer>
      <BaseButton variant="secondary" :disabled="store.working" @click="store.cancel">
        Cancel
      </BaseButton>
      <BaseButton
        variant="primary"
        :disabled="store.working"
        data-testid="document-transfer-confirm"
        @click="confirmTransfer"
      >
        {{ store.working ? 'Moving…' : 'Move Document' }}
      </BaseButton>
    </template>
  </BaseModal>
</template>

<script setup>
import { onMounted } from "vue";
import BaseButton from "./BaseButton.vue";
import BaseModal from "./BaseModal.vue";
import { useSpaceTransferStore } from "@/store/spaceTransferStore";
import { useStructureStore } from "@/store/structureStore";
import { useUiStore } from "@/store/uiStore";

const store = useSpaceTransferStore();
const structureStore = useStructureStore();
const ui = useUiStore();

onMounted(() => store.loadRecoverable());

async function refreshTree() {
  await structureStore.loadRootItems();
}

async function confirmTransfer() {
  try {
    const transfer = await store.confirm();
    await refreshTree();
    const warnings = transfer?.warnings?.length || 0;
    ui.addToast(
      warnings ? `Document moved with ${warnings} image warning${warnings === 1 ? '' : 's'}.` : "Document moved.",
      warnings ? "warning" : "success",
    );
  } catch (error) {
    ui.addToast(error?.message || "Transfer interrupted; retry is safe.", "warning");
  }
}

async function run(id, action) {
  try {
    await store[action](id);
    await refreshTree();
    ui.addToast(action === "keepBoth" ? "Both Documents were kept." : "Document transfer recovered.", "success");
  } catch (error) {
    ui.addToast(error?.message || "Transfer recovery did not finish.", "warning");
  }
}

function canResolveDuplicate(transfer) {
  return ["destination_confirmed", "recoverable_duplicate"].includes(transfer.status);
}
</script>

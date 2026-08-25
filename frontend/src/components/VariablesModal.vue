<template>
    <BaseModal
        :show="show"
        title="Global Variables"
        size="lg"
        close-testid="variables-modal-close-button"
        @close="$emit('close')"
    >
        <p class="pn-body mb-5">
            Define variables available in all documents. Local front-matter variables override these values.
        </p>

        <div class="space-y-4">
            <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div class="md:col-span-1">
                    <label
                        class="pn-label"
                        for="variables-modal-name"
                    >Name</label>
                    <input
                        id="variables-modal-name"
                        v-model="nameInput"
                        type="text"
                        placeholder="Company Name"
                        class="pn-input"
                        data-testid="variables-modal-name-input"
                    />
                </div>
                <div class="md:col-span-2">
                    <label
                        class="pn-label"
                        for="variables-modal-value"
                    >Value</label>
                    <input
                        id="variables-modal-value"
                        v-model="valueInput"
                        type="text"
                        placeholder="Acme Inc."
                        class="pn-input"
                        data-testid="variables-modal-value-input"
                    />
                </div>
            </div>

            <div class="flex items-center justify-between gap-3">
                <p
                    v-if="error"
                    class="text-sm text-red-600"
                    data-testid="variables-modal-error"
                >
                    {{ error }}
                </p>
                <div class="ml-auto flex gap-3">
                    <BaseButton
                        v-if="isEditing"
                        variant="secondary"
                        size="md"
                        data-testid="variables-modal-cancel-button"
                        @click="cancelEdit"
                    >
                        Cancel
                    </BaseButton>
                    <BaseButton
                        variant="primary"
                        size="md"
                        data-testid="variables-modal-save-button"
                        @click="saveVariable"
                    >
                        <Plus class="h-4 w-4" />
                        <span>{{ isEditing ? 'Save' : 'Add' }}</span>
                    </BaseButton>
                </div>
            </div>
        </div>

        <div class="mt-6">
            <div class="mb-3 flex items-center justify-between">
                <h4 class="pn-title-sub">Existing Variables</h4>
                <span class="pn-meta">{{ globals.length }} total</span>
            </div>

            <p
                v-if="!globals.length"
                class="rounded-lg border border-dashed border-gray-300 p-4 pn-body"
                data-testid="variables-modal-empty"
            >
                No global variables yet.
            </p>

            <ul
                v-else
                class="space-y-2"
                data-testid="variables-modal-list"
            >
                <li
                    v-for="item in globals"
                    :key="item.id"
                    class="pn-panel flex items-center justify-between gap-3 px-3 py-2"
                >
                    <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-medium text-gray-900">{{ item.displayKey }}</p>
                        <p class="truncate pn-meta">{{ item.value }}</p>
                    </div>
                    <div class="flex items-center gap-2">
                        <BaseButton
                            variant="ghost"
                            size="sm"
                            data-testid="variables-modal-edit-button"
                            @click="startEdit(item)"
                        >
                            <Pencil class="h-4 w-4" />
                            <span>Edit</span>
                        </BaseButton>
                        <BaseButton
                            variant="danger"
                            size="sm"
                            data-testid="variables-modal-delete-button"
                            @click="removeVariable(item)"
                        >
                            <Trash2 class="h-4 w-4" />
                            <span>Delete</span>
                        </BaseButton>
                    </div>
                </li>
            </ul>
        </div>

        <template #footer>
            <BaseButton
                variant="secondary"
                size="md"
                data-testid="variables-modal-done-button"
                @click="$emit('close')"
            >
                Done
            </BaseButton>
        </template>
    </BaseModal>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { Plus, Pencil, Trash2 } from 'lucide-vue-next';
import { useGlobalVariablesStore } from '@/store/globalVariablesStore';
import { useUiStore } from '@/store/uiStore';
import { useDocStore } from '@/store/docStore';
import BaseModal from '@/components/BaseModal.vue';
import BaseButton from '@/components/BaseButton.vue';

const props = defineProps({
    show: Boolean,
});

defineEmits(['close']);

const globalsStore = useGlobalVariablesStore();
const uiStore = useUiStore();
const docStore = useDocStore();
const dbKey = computed(() => docStore.selectedDbKey || docStore.syncStore.personalDbKey);

const nameInput = ref('');
const valueInput = ref('');
const error = ref('');
const editingKey = ref('');

const globals = computed(() => globalsStore.globals);
const isEditing = computed(() => Boolean(editingKey.value));

function resetForm() {
    nameInput.value = '';
    valueInput.value = '';
    error.value = '';
    editingKey.value = '';
}

function startEdit(item) {
    nameInput.value = item.displayKey || item.key;
    valueInput.value = item.value || '';
    editingKey.value = item.key;
    error.value = '';
}

function cancelEdit() {
    resetForm();
}

async function saveVariable() {
    error.value = '';
    const normalized = globalsStore.normalizeVariableName(nameInput.value);
    if (!normalized) {
        error.value = 'Name is required.';
        return;
    }
    const success = await globalsStore.saveGlobalVariable(dbKey.value, nameInput.value, valueInput.value || '');
    if (success) {
        if (editingKey.value && editingKey.value !== normalized) {
            await globalsStore.deleteGlobalVariable(dbKey.value, editingKey.value);
        }
        uiStore.addToast(isEditing.value ? 'Variable updated.' : 'Variable added.', 'success');
        resetForm();
    }
}

async function removeVariable(item) {
    const success = await globalsStore.deleteGlobalVariable(dbKey.value, item.key);
    if (success) {
        uiStore.addToast('Variable deleted.', 'success');
        if (editingKey.value === item.key) {
            resetForm();
        }
    }
}

watch(() => props.show, (show) => {
    if (show && dbKey.value) globalsStore.loadGlobals(dbKey.value);
}, { immediate: true });
</script>

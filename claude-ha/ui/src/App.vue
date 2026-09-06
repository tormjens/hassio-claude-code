<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  connect,
  currentSession,
  currentView,
  interrupt,
  newSession,
  respondPermission,
  selectSession,
  sendMessage,
  setPermissionMode,
  state,
} from './store';
import type { PermissionModeUi } from '../../server/src/protocol';

const draft = ref('');
const scroller = ref<HTMLElement | null>(null);

const busy = computed(() => currentView.value?.status === 'running' || currentView.value?.status === 'waiting_permission');

const modes: Array<{ value: PermissionModeUi; label: string }> = [
  { value: 'ask', label: 'Ask every time' },
  { value: 'acceptEdits', label: 'Auto-approve edits' },
  { value: 'plan', label: 'Plan only' },
];

function submit() {
  const text = draft.value.trim();
  if (!text) return;
  sendMessage(text);
  draft.value = '';
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

function fmtInput(input: unknown, partial?: string): string {
  if (partial) return partial;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

watch(
  () => currentView.value?.items.length,
  async () => {
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  },
);

onMounted(connect);
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <button class="primary" @click="newSession()">New chat</button>
      <ul class="sessions">
        <li v-for="s in state.sessions" :key="s.id" :class="{ active: s.id === state.currentId }" @click="selectSession(s.id)">
          {{ s.title }}
        </li>
      </ul>
      <p class="status">{{ state.connection }}</p>
    </aside>

    <main class="chat">
      <div v-if="state.settings && !state.settings.hasApiKey" class="banner">
        No Anthropic API key configured. Add it under Settings, Add-ons, Claude for Home Assistant, Configuration, then
        restart the add-on.
      </div>

      <div ref="scroller" class="items">
        <template v-if="currentView">
          <div v-for="item in currentView.items" :key="item.id" :class="['item', item.kind]">
            <template v-if="item.kind === 'user'">
              <div class="bubble user">{{ item.text }}</div>
            </template>
            <template v-else-if="item.kind === 'assistant_text'">
              <div class="bubble assistant">{{ item.text }}<span v-if="item.partial" class="cursor">▍</span></div>
            </template>
            <template v-else-if="item.kind === 'thinking'">
              <details class="thinking">
                <summary>Thinking</summary>
                <pre>{{ item.text }}</pre>
              </details>
            </template>
            <template v-else-if="item.kind === 'tool_use'">
              <details class="tool">
                <summary>
                  <code>{{ item.name.replace('mcp__ha__', '') }}</code>
                  <span class="badge">{{ item.status }}</span>
                </summary>
                <pre>{{ fmtInput(item.input, item.inputPartial) }}</pre>
                <pre v-if="item.result" class="result">{{ item.result }}</pre>
              </details>
            </template>
            <template v-else-if="item.kind === 'system'">
              <div :class="['system', item.level]">{{ item.text }}</div>
            </template>
            <template v-else-if="item.kind === 'result'">
              <div class="meta">
                {{ (item.durationMs / 1000).toFixed(1) }}s, {{ item.numTurns }} turns, ${{ item.costUsd.toFixed(4) }}
              </div>
            </template>
          </div>

          <div v-for="p in currentView.pending" :key="p.requestId" class="permission">
            <strong>{{ p.title ?? `Claude wants to use ${p.toolName}` }}</strong>
            <pre>{{ fmtInput(p.input) }}</pre>
            <div class="actions">
              <button class="primary" @click="respondPermission(p.requestId, 'allow')">Approve</button>
              <button @click="respondPermission(p.requestId, 'deny')">Deny</button>
              <button v-if="p.canAlwaysAllow" @click="respondPermission(p.requestId, 'allow_always')">
                Always allow {{ p.toolName.replace('mcp__ha__', '') }} this session
              </button>
            </div>
          </div>
        </template>
        <p v-else class="empty">Start a new chat to talk to Claude about your Home Assistant configuration.</p>
      </div>

      <form class="composer" @submit.prevent="submit">
        <textarea v-model="draft" rows="2" placeholder="Ask Claude about your Home Assistant setup…" @keydown="onKey" />
        <div class="row">
          <select
            :value="currentSession?.permissionMode ?? 'ask'"
            @change="setPermissionMode(($event.target as HTMLSelectElement).value as PermissionModeUi)"
          >
            <option v-for="m in modes" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select>
          <span class="spacer" />
          <button v-if="busy" type="button" @click="interrupt">Stop</button>
          <button class="primary" type="submit" :disabled="!draft.trim()">Send</button>
        </div>
      </form>
    </main>

    <div class="toasts">
      <div v-for="e in state.errors" :key="e.id" class="toast">{{ e.message }}</div>
    </div>
  </div>
</template>

<style scoped>
.layout { display: flex; height: 100%; }
.sidebar { width: 240px; border-right: 1px solid var(--divider); padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.sessions { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; }
.sessions li { padding: 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sessions li.active { background: var(--accent-soft); }
.chat { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.items { flex: 1; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.bubble { padding: 10px 14px; border-radius: 12px; white-space: pre-wrap; max-width: 80ch; }
.bubble.user { align-self: flex-end; background: var(--accent-soft); }
.bubble.assistant { align-self: flex-start; background: var(--card); }
.tool, .thinking { background: var(--card); border-radius: 8px; padding: 6px 10px; }
.tool pre, .thinking pre, .permission pre { white-space: pre-wrap; font-size: 12px; max-height: 240px; overflow: auto; }
.badge { margin-left: 8px; font-size: 11px; opacity: 0.7; }
.system { font-size: 13px; opacity: 0.8; }
.system.error { color: var(--error); }
.meta, .status, .empty { font-size: 12px; opacity: 0.6; }
.permission { border: 1px solid var(--accent); border-radius: 8px; padding: 10px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.composer { border-top: 1px solid var(--divider); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.composer textarea { width: 100%; box-sizing: border-box; resize: vertical; font: inherit; padding: 8px; border-radius: 8px; border: 1px solid var(--divider); background: var(--card); color: inherit; }
.row { display: flex; gap: 8px; align-items: center; }
.spacer { flex: 1; }
.banner { background: var(--warning-soft); padding: 10px 16px; font-size: 14px; }
button { font: inherit; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--divider); background: var(--card); color: inherit; cursor: pointer; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button:disabled { opacity: 0.5; cursor: default; }
select { font: inherit; padding: 6px; border-radius: 8px; background: var(--card); color: inherit; border: 1px solid var(--divider); }
.cursor { animation: blink 1s steps(2) infinite; }
@keyframes blink { to { visibility: hidden; } }
.toasts { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; }
.toast { background: var(--error); color: #fff; padding: 10px 14px; border-radius: 8px; max-width: 360px; }
</style>

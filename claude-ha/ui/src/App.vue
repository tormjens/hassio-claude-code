<script setup lang="ts">
import { onMounted, ref } from 'vue';

const status = ref('connecting…');
const health = ref<Record<string, unknown> | null>(null);

function wsUrl(): string {
  // Relative to the page so it works under the ingress prefix.
  const base = new URL('ws', window.location.href);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return base.toString();
}

onMounted(async () => {
  try {
    health.value = await (await fetch('api/health')).json();
  } catch (err) {
    health.value = { error: String(err) };
  }
  const ws = new WebSocket(wsUrl());
  ws.onopen = () => (status.value = 'websocket open');
  ws.onmessage = (e) => (status.value = `websocket: ${e.data}`);
  ws.onclose = () => (status.value = 'websocket closed');
  ws.onerror = () => (status.value = 'websocket error');
});
</script>

<template>
  <main style="padding: 2rem; max-width: 40rem; margin: 0 auto;">
    <h1>Claude for Home Assistant</h1>
    <p>Skeleton is running. Ingress and WebSocket check:</p>
    <p><strong>{{ status }}</strong></p>
    <pre>{{ JSON.stringify(health, null, 2) }}</pre>
  </main>
</template>

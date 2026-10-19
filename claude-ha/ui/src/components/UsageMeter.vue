<script setup lang="ts">
/**
 * Claude subscription usage limits (the numbers behind Claude Code's /usage),
 * shown compactly in the sidebar footer. Hidden for API-key logins.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Gauge, RefreshCw, TriangleAlert } from '@lucide/vue';
import { refreshUsage, state } from '@/store';
import type { UsageWindow } from '../../../server/src/protocol';

const now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 30_000);
onBeforeUnmount(() => clearInterval(timer));

const refreshing = ref(false);
watch(
  () => state.usageSeq,
  () => (refreshing.value = false),
);

const isOauth = computed(() => state.settings?.auth?.method === 'oauth');
const usage = computed(() => (isOauth.value && state.usage?.available ? state.usage : null));
const windows = computed(() => usage.value?.windows ?? []);

/** A warning or rejection only matters until the window it names resets. */
const alert = computed(() => {
  const u = usage.value;
  if (!u?.status || u.status === 'allowed') return null;
  const w = u.windows.find((x) => x.key === u.limitType);
  if (w?.resetsAt && Date.parse(w.resetsAt) <= now.value) return null;
  const when = w?.resetsAt ? ` Resets ${resetText(w.resetsAt)}.` : '';
  return u.status === 'rejected' ? `Usage limit reached.${when}` : `Approaching your usage limit.${when}`;
});

const extra = computed(() => {
  const e = usage.value?.extraUsage;
  if (!e?.enabled || e.usedCredits == null) return null;
  const fmt = (minor: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: e.currency || 'USD' }).format(minor / 100);
  return e.monthlyLimit != null ? `${fmt(e.usedCredits)} of ${fmt(e.monthlyLimit)}` : fmt(e.usedCredits);
});

function percent(w: UsageWindow): number {
  return Math.round(w.utilization ?? 0);
}

function barClass(w: UsageWindow): string {
  const p = w.utilization ?? 0;
  if (p >= 90) return 'bg-destructive';
  if (p >= 75) return 'bg-warning';
  return 'bg-primary';
}

function resetText(iso: string | null): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const mins = Math.round((at - now.value) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)} h ${mins % 60} min`;
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

const updatedText = computed(() => {
  const t = usage.value?.updatedAt;
  if (!t) return '';
  const mins = Math.round((now.value - t) / 60_000);
  return mins < 1 ? 'Updated just now' : mins < 60 ? `Updated ${mins} min ago` : `Updated ${new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
});

function refresh(): void {
  refreshing.value = true;
  refreshUsage();
  // The server always answers with a `usage` message; this is a backstop
  // for a dropped connection.
  setTimeout(() => (refreshing.value = false), 60_000);
}
</script>

<template>
  <div v-if="isOauth" class="space-y-2 px-2 pb-2">
    <div class="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      <Gauge class="size-3.5" />
      <span>Usage limits</span>
      <button
        class="ml-auto grid size-6 place-items-center rounded-md transition-colors hover:bg-accent hover:text-foreground"
        :title="updatedText || 'Refresh'"
        :disabled="refreshing"
        @click="refresh"
      >
        <RefreshCw class="size-3.5" :class="refreshing && 'animate-spin'" />
      </button>
    </div>

    <p v-if="alert" class="flex items-start gap-1.5 rounded-md bg-warning/15 px-2 py-1.5 text-xs text-foreground">
      <TriangleAlert class="mt-px size-3.5 shrink-0 text-warning" />
      <span>{{ alert }}</span>
    </p>

    <template v-if="windows.length">
      <div v-for="w in windows" :key="w.key" class="space-y-1">
        <div class="flex items-baseline justify-between gap-2 text-xs">
          <span class="truncate">{{ w.label }}</span>
          <span class="shrink-0 tabular-nums text-muted-foreground">{{ w.utilization == null ? '–' : `${percent(w)}%` }}</span>
        </div>
        <div
          class="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          :aria-label="w.label"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent(w)"
        >
          <div class="h-full rounded-full transition-[width] duration-500" :class="barClass(w)" :style="{ width: `${percent(w)}%` }" />
        </div>
        <p v-if="w.resetsAt" class="text-[11px] text-muted-foreground">Resets {{ resetText(w.resetsAt) }}</p>
      </div>
      <p v-if="extra" class="flex justify-between text-xs">
        <span>Extra usage</span>
        <span class="tabular-nums text-muted-foreground">{{ extra }}</span>
      </p>
      <p class="text-[11px] text-muted-foreground">{{ refreshing ? 'Updating…' : updatedText }}</p>
    </template>
    <p v-else class="text-xs text-muted-foreground">
      {{ refreshing ? 'Fetching usage…' : "Shown after Claude's next reply, or press refresh." }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import {
  ArrowUp,
  Bot,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  FilePlus,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Info,
  Lightbulb,
  Menu,
  MessageSquarePlus,
  MessageSquareText,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  Trash2,
  Undo2,
  Wrench,
  X,
} from '@lucide/vue';
import {
  connect,
  currentSession,
  currentView,
  deleteSession,
  interrupt,
  newSession,
  renameSession,
  respondPermission,
  answerQuestion,
  revertSession,
  selectSession,
  sendMessage,
  setModel,
  setPermissionMode,
  state,
} from './store';
import type { PermissionModeUi, QuestionRequest, TranscriptItem } from '../../server/src/protocol';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { Toaster } from '@/components/ui/sonner';
import Markdown from '@/components/Markdown.vue';
import { FILE_EDIT_TOOLS, fileEditView, type FileEditView } from '@/lib/diff';

const DEFAULT_MODEL = '__default__';

const draft = ref('');
const scroller = ref<HTMLElement | null>(null);
const sidebarOpen = ref(false); // drawer state on mobile; the sidebar is always visible from md up
const setupOpen = ref(false);

// AskUserQuestion state, keyed by request id: current step and per-question picks.
const askStep = reactive<Record<string, number>>({});
const askSel = reactive<Record<string, Record<number, string[]>>>({});

const busy = computed(
  () => currentView.value?.status === 'running' || currentView.value?.status === 'waiting_permission',
);

const awaitingReply = computed(() => {
  const v = currentView.value;
  if (!v || v.status !== 'running') return false;
  const last = v.items[v.items.length - 1];
  return !last || last.kind === 'user';
});

const modes: Array<{ label: string; value: PermissionModeUi }> = [
  { value: 'ask', label: 'Ask every time' },
  { value: 'acceptEdits', label: 'Auto-approve edits' },
  { value: 'plan', label: 'Plan only' },
];
const modeLabel = (v?: string) => modes.find((m) => m.value === v)?.label ?? 'Ask every time';

const auth = computed(() => state.settings?.auth ?? null);
const authConfigured = computed(() => auth.value?.configured ?? false);
const isOauth = computed(() => auth.value?.method === 'oauth');

const models = computed(() => state.settings?.models ?? []);
const currentModel = computed(() => currentSession.value?.model ?? DEFAULT_MODEL);
const currentModelLabel = computed(() => {
  const m = currentSession.value?.model;
  if (!m) return 'Default model';
  return models.value.find((x) => x.value === m)?.label ?? m;
});
function onModelChange(v: unknown) {
  const value = String(v);
  setModel(value === DEFAULT_MODEL ? undefined : value);
}

const greeting = computed(() => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
});

const examples = [
  'List all my lights and whether they are on',
  'Show my automations and what triggers them',
  'Check my configuration for errors',
];

function submit() {
  const text = draft.value.trim();
  if (!text) return;
  sendMessage(text);
  draft.value = '';
}
function useExample(text: string) {
  sendMessage(text);
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

const toolLabel = (name: string) => name.replace('mcp__ha__', '').replace('mcp__homeassistant__', '');
const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const editViewCache = new Map<string, FileEditView | null>();
function editView(item: TranscriptItem): FileEditView | null {
  if (item.kind !== 'tool_use') return null;
  const settled = item.status !== 'streaming';
  if (settled && editViewCache.has(item.id)) return editViewCache.get(item.id) ?? null;
  const view = fileEditView(item.name, item.input);
  if (settled) editViewCache.set(item.id, view);
  return view;
}

// ---- AskUserQuestion (rendered as a step-by-step card) ----
const stepOf = (req: QuestionRequest) => askStep[req.requestId] ?? 0;
const picksFor = (req: QuestionRequest, qi: number) => askSel[req.requestId]?.[qi] ?? [];
const isPicked = (req: QuestionRequest, qi: number, label: string) => picksFor(req, qi).includes(label);
function pick(req: QuestionRequest, qi: number, label: string, multi: boolean) {
  const per = (askSel[req.requestId] ??= {});
  const cur = per[qi] ?? [];
  if (multi) per[qi] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
  else per[qi] = [label];
}
const stepAnswered = (req: QuestionRequest) => picksFor(req, stepOf(req)).length > 0;
const isLastStep = (req: QuestionRequest) => stepOf(req) >= req.questions.length - 1;
function nextStep(req: QuestionRequest) {
  if (!stepAnswered(req)) return;
  if (isLastStep(req)) submitQuestion(req);
  else askStep[req.requestId] = stepOf(req) + 1;
}
function prevStep(req: QuestionRequest) {
  askStep[req.requestId] = Math.max(0, stepOf(req) - 1);
}
function submitQuestion(req: QuestionRequest) {
  const answers = req.questions.map((_, i) => askSel[req.requestId]?.[i] ?? []);
  answerQuestion(req.requestId, answers);
}

function pickSession(id: string) {
  selectSession(id);
  sidebarOpen.value = false;
}
function startChat() {
  newSession();
  sidebarOpen.value = false;
}
function promptRename(id: string, current: string) {
  const title = window.prompt('Rename chat', current);
  if (title && title.trim()) renameSession(id, title.trim());
}
function confirmDelete(id: string, title: string) {
  if (window.confirm(`Delete "${title}"? This cannot be undone.`)) deleteSession(id);
}

watch(
  () => [currentView.value?.items.length, awaitingReply.value] as const,
  async () => {
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' });
  },
);

connect();
</script>

<template>
  <div class="relative flex h-full overflow-hidden bg-background text-foreground text-sm">
    <!-- Mobile drawer backdrop -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden"
      @click="sidebarOpen = false"
    />

    <!-- Sidebar -->
    <aside
      class="fixed inset-y-0 left-0 z-40 flex w-[17rem] shrink-0 flex-col border-r bg-background transition-transform duration-200 ease-out md:static md:z-auto md:w-64 md:translate-x-0"
      :class="sidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'"
    >
      <div class="flex items-center gap-2.5 px-4 py-3.5">
        <div class="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Bot class="size-5" />
        </div>
        <div class="min-w-0 leading-tight">
          <p class="font-semibold">Claude</p>
          <p class="truncate text-xs text-muted-foreground">for Home Assistant</p>
        </div>
        <Button size="icon" variant="ghost" class="ml-auto md:hidden" @click="sidebarOpen = false">
          <X class="size-4" />
        </Button>
      </div>

      <div class="px-3">
        <Button variant="outline" class="w-full justify-start gap-2 shadow-sm" @click="startChat">
          <MessageSquarePlus class="size-4" /> New chat
        </Button>
      </div>

      <p v-if="state.sessions.length" class="px-4 pb-1.5 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Recent
      </p>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2" :class="state.sessions.length ? '' : 'flex items-center justify-center'">
        <ul v-if="state.sessions.length" class="space-y-0.5">
          <li v-for="s in state.sessions" :key="s.id">
            <div
              class="group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition-colors"
              :class="s.id === state.currentId ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'"
              @click="pickSession(s.id)"
            >
              <MessageSquareText class="size-4 shrink-0 opacity-70" />
              <span class="flex-1 truncate">{{ s.title }}</span>
              <span class="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                <Button size="icon" variant="ghost" class="size-6" @click.stop="promptRename(s.id, s.title)">
                  <Pencil class="size-3.5" />
                </Button>
                <Button size="icon" variant="ghost" class="size-6 text-muted-foreground hover:text-destructive" @click.stop="confirmDelete(s.id, s.title)">
                  <Trash2 class="size-3.5" />
                </Button>
              </span>
            </div>
          </li>
        </ul>
        <div v-else class="px-4 text-center text-xs text-muted-foreground">
          <MessageSquareText class="mx-auto mb-2 size-6 opacity-40" />
          No chats yet
        </div>
      </div>

      <div class="border-t p-3">
        <button
          class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
          @click="setupOpen = true"
        >
          <div
            class="grid size-8 shrink-0 place-items-center rounded-lg"
            :class="authConfigured ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'"
          >
            <component :is="authConfigured ? ShieldCheck : ShieldAlert" class="size-4" />
          </div>
          <div class="min-w-0 flex-1 leading-tight">
            <p class="truncate text-[13px] font-medium">{{ isOauth ? 'Claude subscription' : 'API key' }}</p>
            <p class="truncate text-xs text-muted-foreground">{{ authConfigured ? 'Connected' : 'Not signed in' }}</p>
          </div>
          <span class="shrink-0 text-[11px] text-muted-foreground">v{{ state.settings?.version ?? '' }}</span>
        </button>
      </div>
    </aside>

    <!-- Main -->
    <main class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-14 items-center gap-2 border-b px-3 sm:px-4">
        <Button size="icon" variant="ghost" class="md:hidden" @click="sidebarOpen = true">
          <Menu class="size-5" />
        </Button>
        <div class="min-w-0 leading-tight">
          <p class="truncate font-semibold">{{ currentSession?.title ?? 'New chat' }}</p>
          <p class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              class="inline-block size-1.5 rounded-full"
              :class="state.connection === 'open' ? 'bg-success' : state.connection === 'connecting' ? 'bg-warning' : 'bg-destructive'"
            />
            {{ state.connection === 'open' ? 'Connected' : state.connection === 'connecting' ? 'Connecting…' : 'Reconnecting…' }}
          </p>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <Button
            v-if="state.git?.isRepo && state.git.dirty && currentSession"
            size="sm"
            variant="outline"
            class="gap-1.5"
            @click="revertSession(currentSession.id)"
          >
            <Undo2 class="size-3.5" /> <span class="hidden sm:inline">Revert changes</span><span class="sm:hidden">Revert</span>
          </Button>
          <Button size="icon" variant="ghost" class="rounded-full" title="New chat" @click="startChat">
            <Plus class="size-5" />
          </Button>
        </div>
      </header>

      <Alert
        v-if="!authConfigured"
        class="mx-3 mt-3 w-auto border-warning/40 bg-warning/5 text-warning [&>svg]:text-warning"
      >
        <ShieldAlert />
        <AlertTitle>{{ isOauth ? 'Not signed in' : 'No Anthropic API key configured' }}</AlertTitle>
        <AlertDescription class="text-warning/90">
          <span v-if="isOauth">
            Run <code class="rounded bg-warning/10 px-1">claude setup-token</code> on a computer signed in to your Claude
            subscription, paste the token into the add-on options, then restart the add-on.
          </span>
          <span v-else>
            Add an API key under Settings → Add-ons → Claude for Home Assistant → Configuration, then restart the add-on.
          </span>
          <Button size="sm" variant="outline" class="mt-2 w-fit border-warning/40" @click="setupOpen = true">
            How to set up
          </Button>
        </AlertDescription>
      </Alert>

      <!-- Transcript -->
      <div ref="scroller" class="flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-6">
        <template v-if="currentView && currentView.items.length">
          <div class="mx-auto flex max-w-3xl flex-col gap-5">
            <template v-for="item in currentView.items" :key="item.id">
              <div v-if="item.kind === 'user'" class="flex animate-message-in justify-end">
                <div class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground shadow-sm sm:max-w-[75%]">
                  {{ item.text }}
                </div>
              </div>

              <div v-else-if="item.kind === 'assistant_text'" class="flex animate-message-in gap-3">
                <div class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <Sparkles class="size-4" />
                </div>
                <div class="min-w-0 flex-1 pt-0.5">
                  <Markdown :text="item.text" />
                  <span v-if="item.partial" class="ml-0.5 inline-block h-4 w-[2px] -translate-y-0.5 animate-pulse bg-foreground align-middle" />
                </div>
              </div>

              <Collapsible v-else-if="item.kind === 'thinking'" :default-open="item.partial" class="animate-message-in overflow-hidden rounded-xl border bg-muted/40">
                <CollapsibleTrigger class="group flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-accent/50">
                  <ChevronRight class="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                  <Lightbulb class="size-3.5" />
                  Thinking<span v-if="item.partial" class="animate-pulse">…</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre class="max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-3 text-xs text-muted-foreground">{{ item.text }}</pre>
                </CollapsibleContent>
              </Collapsible>

              <!-- File edit diff (Edit / Write / MultiEdit) -->
              <Collapsible
                v-else-if="item.kind === 'tool_use' && !item.hidden && FILE_EDIT_TOOLS.has(item.name)"
                :default-open="true"
                class="animate-message-in overflow-hidden rounded-xl border bg-muted/40"
              >
                <CollapsibleTrigger class="group flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-accent/50">
                  <ChevronRight class="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                  <component :is="item.name === 'Write' ? FilePlus : FilePenLine" class="size-3.5 shrink-0 text-primary" />
                  <code class="truncate font-medium" :title="editView(item)?.file">{{
                    editView(item) ? baseName(editView(item)!.file) : toolLabel(item.name)
                  }}</code>
                  <span v-if="editView(item)" class="ml-auto shrink-0 font-mono text-[11px]">
                    <span v-if="editView(item)!.adds" class="text-success">+{{ editView(item)!.adds }}</span>
                    <span v-if="editView(item)!.dels" class="ml-1 text-destructive">-{{ editView(item)!.dels }}</span>
                    <span
                      v-if="item.status === 'error' || item.status === 'denied'"
                      class="ml-1.5 rounded bg-destructive/15 px-1 text-destructive"
                    >{{ item.status }}</span>
                  </span>
                  <Badge v-else variant="secondary" class="ml-auto shrink-0">{{ item.status }}</Badge>
                </CollapsibleTrigger>
                <CollapsibleContent class="space-y-2 px-3 pb-3 text-xs">
                  <template v-if="editView(item)">
                    <div
                      v-for="(blk, bi) in editView(item)!.blocks"
                      :key="bi"
                      class="overflow-hidden rounded-lg border bg-background"
                    >
                      <p v-if="blk.title" class="border-b px-2 py-1 text-[11px] font-medium text-muted-foreground">
                        {{ blk.title }}
                      </p>
                      <div class="max-h-80 overflow-auto py-1 font-mono text-[12px] leading-relaxed">
                        <div
                          v-for="(ln, li) in blk.lines"
                          :key="li"
                          class="flex whitespace-pre px-2"
                          :class="ln.type === 'add' ? 'bg-success/10' : ln.type === 'del' ? 'bg-destructive/10' : ''"
                        >
                          <span
                            class="mr-2 shrink-0 select-none"
                            :class="ln.type === 'add' ? 'text-success' : ln.type === 'del' ? 'text-destructive' : 'text-muted-foreground/40'"
                          >{{ ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' ' }}</span><span class="hljs-line" v-html="ln.html || ' '" />
                        </div>
                      </div>
                    </div>
                    <p v-if="item.status === 'denied'" class="text-muted-foreground">Change was not applied.</p>
                    <pre
                      v-if="item.isError && item.result"
                      class="max-h-40 overflow-auto rounded-lg bg-destructive/10 p-2.5 text-destructive"
                    >{{ item.result }}</pre>
                  </template>
                  <pre v-else class="max-h-64 overflow-auto rounded-lg bg-background p-2.5">{{ fmtInput(item.input, item.inputPartial) }}</pre>
                </CollapsibleContent>
              </Collapsible>

              <Collapsible v-else-if="item.kind === 'tool_use' && !item.hidden" class="animate-message-in overflow-hidden rounded-xl border bg-muted/40">
                <CollapsibleTrigger class="group flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-accent/50">
                  <ChevronRight class="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                  <Wrench class="size-3.5 shrink-0 text-muted-foreground" />
                  <code class="truncate font-medium">{{ toolLabel(item.name) }}</code>
                  <Badge
                    variant="secondary"
                    class="ml-auto shrink-0"
                    :class="{
                      'bg-destructive/15 text-destructive': item.status === 'error' || item.status === 'denied',
                      'bg-success/15 text-success': item.status === 'done',
                    }"
                  >
                    {{ item.status }}
                  </Badge>
                </CollapsibleTrigger>
                <CollapsibleContent class="space-y-2 px-3 pb-3 text-xs">
                  <pre class="max-h-64 overflow-auto rounded-lg bg-background p-2.5">{{ fmtInput(item.input, item.inputPartial) }}</pre>
                  <pre v-if="item.result" class="max-h-64 overflow-auto rounded-lg bg-background p-2.5">{{ item.result }}</pre>
                </CollapsibleContent>
              </Collapsible>

              <Alert
                v-else-if="item.kind === 'system'"
                class="animate-message-in"
                :variant="item.level === 'error' ? 'destructive' : 'default'"
              >
                <component :is="item.level === 'error' ? TriangleAlert : Info" />
                <AlertDescription>{{ item.text }}</AlertDescription>
              </Alert>

              <p v-else-if="item.kind === 'result'" class="text-center text-[11px] text-muted-foreground">
                {{ (item.durationMs / 1000).toFixed(1) }}s · {{ item.numTurns }} {{ item.numTurns === 1 ? 'turn' : 'turns' }} · ${{ item.costUsd.toFixed(4) }}
              </p>
            </template>

            <div v-if="awaitingReply" class="flex animate-message-in gap-3">
              <div class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Sparkles class="size-4" />
              </div>
              <div class="flex items-center gap-1 pt-2.5">
                <span class="typing-dot size-1.5 rounded-full bg-muted-foreground" style="animation-delay: 0ms" />
                <span class="typing-dot size-1.5 rounded-full bg-muted-foreground" style="animation-delay: 150ms" />
                <span class="typing-dot size-1.5 rounded-full bg-muted-foreground" style="animation-delay: 300ms" />
              </div>
            </div>

            <!-- AskUserQuestion (step-by-step) -->
            <Card
              v-for="req in currentView.questions"
              :key="req.requestId"
              class="animate-message-in gap-0 overflow-hidden border-primary/40 py-0 shadow-md"
            >
              <div class="flex items-center gap-2 border-b bg-primary/5 px-4 py-2.5 text-sm font-medium">
                <CircleHelp class="size-4 text-primary" /> Claude needs your input
                <span v-if="req.questions.length > 1" class="ml-auto text-xs font-normal text-muted-foreground">
                  Question {{ stepOf(req) + 1 }} of {{ req.questions.length }}
                </span>
              </div>

              <template v-for="(q, qi) in req.questions" :key="qi">
                <div v-show="qi === stepOf(req)" class="space-y-3 p-4">
                  <div class="flex items-center gap-2">
                    <Badge variant="secondary" class="bg-primary/10 text-primary">{{ q.header }}</Badge>
                    <span v-if="q.multiSelect" class="text-[11px] text-muted-foreground">Select all that apply</span>
                  </div>
                  <p class="font-medium">{{ q.question }}</p>
                  <div class="grid gap-2">
                    <button
                      v-for="opt in q.options"
                      :key="opt.label"
                      class="flex items-start gap-3 rounded-xl border p-3 text-left transition-colors"
                      :class="isPicked(req, qi, opt.label)
                        ? 'border-primary bg-primary/5 ring-1 ring-primary'
                        : 'hover:border-primary/40 hover:bg-accent'"
                      @click="pick(req, qi, opt.label, !!q.multiSelect)"
                    >
                      <span
                        class="mt-0.5 grid size-4 shrink-0 place-items-center border"
                        :class="[
                          q.multiSelect ? 'rounded' : 'rounded-full',
                          isPicked(req, qi, opt.label) ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                        ]"
                      >
                        <Check v-if="isPicked(req, qi, opt.label)" class="size-3" />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block font-medium">{{ opt.label }}</span>
                        <span v-if="opt.description" class="block text-xs text-muted-foreground">{{ opt.description }}</span>
                      </span>
                    </button>
                  </div>
                </div>
              </template>

              <CardFooter class="items-center gap-2 border-t px-4 py-3">
                <Button v-if="stepOf(req) > 0" size="sm" variant="ghost" @click="prevStep(req)">
                  <ChevronLeft class="size-4" /> Back
                </Button>
                <div v-if="req.questions.length > 1" class="flex items-center gap-1">
                  <span
                    v-for="(_, i) in req.questions"
                    :key="i"
                    class="size-1.5 rounded-full"
                    :class="i === stepOf(req) ? 'bg-primary' : 'bg-muted-foreground/30'"
                  />
                </div>
                <Button size="sm" class="ml-auto" :disabled="!stepAnswered(req)" @click="nextStep(req)">
                  {{ isLastStep(req) ? 'Submit answer' : 'Next' }}
                  <ChevronRight v-if="!isLastStep(req)" class="size-4" />
                </Button>
              </CardFooter>
            </Card>

            <Card v-for="p in currentView.pending" :key="p.requestId" class="animate-message-in gap-3 border-primary/60 py-4 shadow-md">
              <CardHeader class="px-4">
                <div class="flex items-center gap-2 font-medium">
                  <ShieldAlert class="size-4 text-primary" />
                  {{ p.title ?? `Claude wants to use ${toolLabel(p.toolName)}` }}
                </div>
              </CardHeader>
              <CardContent class="px-4">
                <pre class="max-h-64 overflow-auto rounded-lg bg-muted p-2.5 text-xs">{{ fmtInput(p.input) }}</pre>
              </CardContent>
              <CardFooter class="flex-wrap gap-2 px-4">
                <Button size="sm" @click="respondPermission(p.requestId, 'allow')">
                  <Check class="size-4" /> Approve
                </Button>
                <Button size="sm" variant="secondary" @click="respondPermission(p.requestId, 'deny')">
                  <X class="size-4" /> Deny
                </Button>
                <Button v-if="p.canAlwaysAllow" size="sm" variant="ghost" @click="respondPermission(p.requestId, 'allow_always')">
                  <CheckCheck class="size-4" /> Always allow
                </Button>
              </CardFooter>
            </Card>
          </div>
        </template>

        <!-- Empty state -->
        <div v-else class="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-4 text-center">
          <div class="grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground shadow-inner">
            <Bot class="size-7" />
          </div>
          <div class="space-y-1.5">
            <h2 class="text-2xl font-semibold tracking-tight">{{ greeting }}</h2>
            <p class="text-muted-foreground">Ask Claude about your Home Assistant configuration, automations and entities.</p>
          </div>
          <div class="mt-2 flex w-full flex-col gap-2">
            <button
              v-for="ex in examples"
              :key="ex"
              class="flex items-center gap-2.5 rounded-xl border bg-muted/30 px-3.5 py-2.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!authConfigured"
              @click="useExample(ex)"
            >
              <Lightbulb class="size-4 shrink-0 text-primary" />
              <span class="flex-1">{{ ex }}</span>
              <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
            </button>
          </div>
        </div>
      </div>

      <!-- Composer -->
      <div class="px-3 pb-3 sm:px-4 sm:pb-4">
        <div class="mx-auto w-full max-w-3xl">
          <div class="rounded-2xl border bg-muted/40 shadow-sm transition-colors focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/25">
            <Textarea
              v-model="draft"
              :rows="1"
              placeholder="Ask Claude about your Home Assistant setup…"
              class="min-h-[52px] max-h-52 resize-none border-0 bg-transparent px-4 pt-3.5 text-base shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
              @keydown="onKey"
            />
            <div class="flex items-center gap-1 px-2.5 pb-2.5">
              <div class="flex min-w-0 flex-1 items-center gap-1">
                <Select :model-value="currentModel" @update:model-value="onModelChange">
                  <SelectTrigger
                    size="sm"
                    class="h-8 min-w-0 max-w-[45%] gap-1.5 border-0 bg-transparent text-muted-foreground shadow-none hover:bg-accent focus-visible:ring-0 data-[state=open]:bg-accent"
                    title="Model"
                  >
                    <Sparkles class="size-3.5 shrink-0" />
                    <span class="truncate">{{ currentModelLabel }}</span>
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectItem v-for="m in models" :key="m.value" :value="m.value">{{ m.label }}</SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  :model-value="currentSession?.permissionMode ?? 'ask'"
                  @update:model-value="(v) => setPermissionMode(v as PermissionModeUi)"
                >
                  <SelectTrigger
                    size="sm"
                    class="h-8 min-w-0 gap-1.5 border-0 bg-transparent text-muted-foreground shadow-none hover:bg-accent focus-visible:ring-0 data-[state=open]:bg-accent"
                    title="Permission mode"
                  >
                    <ShieldAlert class="size-3.5 shrink-0" />
                    <span class="hidden truncate sm:inline">{{ modeLabel(currentSession?.permissionMode) }}</span>
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectItem v-for="m in modes" :key="m.value" :value="m.value">{{ m.label }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div class="flex shrink-0 items-center gap-2">
                <Button v-if="busy" size="icon" variant="secondary" class="size-9 rounded-full" title="Stop" @click="interrupt">
                  <Square class="size-4 fill-current" />
                </Button>
                <Button
                  size="icon"
                  class="size-9 rounded-full transition-transform active:scale-95 disabled:opacity-40"
                  :disabled="!draft.trim() || busy"
                  title="Send"
                  @click="submit"
                >
                  <ArrowUp class="size-5" />
                </Button>
              </div>
            </div>
          </div>
          <p class="mt-1.5 text-center text-[11px] text-muted-foreground">Enter to send · Shift + Enter for a new line</p>
        </div>
      </div>
    </main>

    <!-- Setup / authentication dialog -->
    <Dialog v-model:open="setupOpen">
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>Authentication</DialogTitle>
          <DialogDescription>{{ isOauth ? 'Claude subscription (OAuth token)' : 'Static API key' }}</DialogDescription>
        </DialogHeader>

        <div v-if="isOauth" class="space-y-4 text-sm">
          <p>This add-on signs in with a Claude subscription. Generate a token once and paste it into the add-on options.</p>
          <ol class="list-decimal space-y-2 pl-5 marker:text-muted-foreground">
            <li>On any computer with Claude Code, signed in to your Claude Pro, Max, Team or Enterprise account, run:</li>
          </ol>
          <pre class="overflow-auto rounded-lg bg-muted p-2.5 text-xs">claude setup-token</pre>
          <ol class="list-decimal space-y-2 pl-5 marker:text-muted-foreground" start="2">
            <li>Approve the browser login. It prints a long-lived token (valid about a year).</li>
            <li>In Home Assistant, open Settings → Add-ons → Claude for Home Assistant → Configuration, set the OAuth token, then restart the add-on.</li>
          </ol>
          <Alert
            :variant="authConfigured ? 'default' : 'destructive'"
            :class="authConfigured ? 'border-success/40 text-success [&>svg]:text-success' : ''"
          >
            <component :is="authConfigured ? CircleCheck : CircleAlert" />
            <AlertTitle>{{ authConfigured ? 'A token is configured' : 'No token configured yet' }}</AlertTitle>
          </Alert>
        </div>

        <div v-else class="space-y-3 text-sm">
          <p>This add-on is using a static Anthropic API key, billed to your API account.</p>
          <p class="text-muted-foreground">
            To use your Claude subscription instead, set the authentication method to <code>oauth</code> in the add-on
            options and follow the <code>claude setup-token</code> steps.
          </p>
          <Alert
            :variant="authConfigured ? 'default' : 'destructive'"
            :class="authConfigured ? 'border-success/40 text-success [&>svg]:text-success' : ''"
          >
            <component :is="authConfigured ? CircleCheck : CircleAlert" />
            <AlertTitle>{{ authConfigured ? 'An API key is configured' : 'No API key configured yet' }}</AlertTitle>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="secondary" @click="setupOpen = false">Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Toaster rich-colors position="top-center" />
  </div>
</template>

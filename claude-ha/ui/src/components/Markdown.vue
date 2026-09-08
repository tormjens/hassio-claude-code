<script setup lang="ts">
import { computed } from 'vue';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { highlightToHtml } from '@/lib/highlight';

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang?.trim().toLowerCase();
      const body = highlightToHtml(text, language);
      return `<pre><code class="hljs${language ? ` language-${language}` : ''}">${body}</code></pre>`;
    },
  },
});

// Open links in a new tab (the app runs inside the Home Assistant ingress frame).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

const props = defineProps<{ text: string }>();

const html = computed(() =>
  DOMPurify.sanitize(marked.parse(props.text ?? '', { async: false }) as string, {
    ADD_ATTR: ['target', 'rel'],
  }),
);
</script>

<template>
  <div class="md" v-html="html" />
</template>

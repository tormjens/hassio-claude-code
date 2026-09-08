<script setup lang="ts">
import { computed } from 'vue';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import yaml from 'highlight.js/lib/languages/yaml';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import ini from 'highlight.js/lib/languages/ini';
import xml from 'highlight.js/lib/languages/xml';

hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('python', python);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('toml', ini);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : '';
      const body = language ? hljs.highlight(text, { language }).value : escapeHtml(text);
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

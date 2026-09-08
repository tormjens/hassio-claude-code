/**
 * Shared syntax highlighting (highlight.js) for both Markdown code blocks and
 * the file-edit diff view. Only the languages relevant to a Home Assistant
 * configuration are registered, to keep the bundle small.
 */
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
hljs.registerLanguage('py', python);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('toml', ini);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Highlight `text` as `lang` (if supported), returning safe HTML. */
export function highlightToHtml(text: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(text);
}

const EXT_LANG: Record<string, string> = {
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  ini: 'ini',
  conf: 'ini',
  toml: 'toml',
  xml: 'xml',
  html: 'xml',
};

/** Best-effort language for a file path, by extension. */
export function languageForFile(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? '';
}

export { hljs };

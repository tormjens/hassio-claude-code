/**
 * Minimal UI translations.
 *
 * Each language is one JSON file in ./locales, named by its BCP 47 tag
 * (en.json, fr.json, pt-BR.json, ...). en.json is the source of truth: any key
 * missing from another language falls back to English, so a partial
 * translation still works. Adding a language is just adding a file.
 *
 * Strings use {name} placeholders. A plural string is an object keyed by
 * Intl.PluralRules categories ("one", "other", and "few"/"many" where the
 * language needs them) and is picked with the `count` parameter.
 */
import { ref } from 'vue';
import en from './locales/en.json';

type Catalog = { [key: string]: string | Catalog };
type PluralForms = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;

/** Every dotted key in en.json, so a typo in t('...') fails the typecheck. */
type Keys<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends { other: string }
      ? `${P}${K}`
      : Keys<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Keys<typeof en>;

const catalogs: Record<string, Catalog> = {};
for (const [path, mod] of Object.entries(
  import.meta.glob<{ default: Catalog }>('./locales/*.json', { eager: true }),
)) {
  catalogs[path.replace(/^.*\/|\.json$/g, '')] = mod.default;
}

export const availableLocales = Object.keys(catalogs).sort();

/** Languages that should borrow a close catalog when they have none of their own. */
const FALLBACKS: Record<string, string> = { no: 'nb', nn: 'nb' };

/** Best catalog for a language tag: exact match, then the base language, then a close one. */
function match(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const want = tag.replace('_', '-').toLowerCase();
  const find = (l: string) => availableLocales.find((x) => x.toLowerCase() === l) ?? null;
  const base = want.split('-')[0];
  return find(want) ?? find(base) ?? (FALLBACKS[base] ? find(FALLBACKS[base]) : null);
}

/**
 * The language Home Assistant shows, else the browser's.
 *
 * The panel is served through ingress on Home Assistant's own origin, so the
 * frontend's <html lang> and its stored "selectedLanguage" are readable. Both
 * reads are guarded: in local dev or a cross-origin frame they throw or are
 * absent, and the browser languages are used instead.
 */
function detect(): string {
  const candidates: Array<string | null | undefined> = [];
  try {
    const stored = window.localStorage.getItem('selectedLanguage');
    if (stored) candidates.push(JSON.parse(stored) as string);
  } catch {
    /* unavailable */
  }
  try {
    if (window.parent !== window) candidates.push(window.parent.document.documentElement.lang);
  } catch {
    /* cross-origin */
  }
  candidates.push(...(navigator.languages ?? []), navigator.language);
  for (const c of candidates) {
    const m = match(typeof c === 'string' ? c : null);
    if (m) return m;
  }
  return 'en';
}

/** The active language tag; also usable as the locale for Intl formatting. */
export const locale = ref(detect());

export function setLocale(tag: string): void {
  locale.value = match(tag) ?? 'en';
  document.documentElement.lang = locale.value;
}
setLocale(locale.value);

function lookup(catalog: Catalog | undefined, key: string): string | Catalog | undefined {
  let node: string | Catalog | undefined = catalog;
  for (const part of key.split('.')) {
    if (!node || typeof node === 'string') return undefined;
    node = node[part];
  }
  return node;
}

function resolve(key: string, count: number | undefined): string | undefined {
  for (const tag of [locale.value, 'en']) {
    const node = lookup(catalogs[tag], key);
    if (typeof node === 'string') return node;
    if (node && typeof node.other === 'string') {
      const forms = node as PluralForms;
      const cat = count == null ? 'other' : new Intl.PluralRules(tag).select(count);
      return forms[cat] ?? forms.other;
    }
  }
  return undefined;
}

export type Params = Record<string, string | number>;

/** Translate a key. Unknown keys render as the key itself, so they are easy to spot. */
export function t(key: MessageKey, params?: Params): string {
  return tr(key, params) ?? key;
}

/** Like t() but for a computed key; returns undefined when it does not exist. */
export function tr(key: string, params?: Params): string | undefined {
  const count = typeof params?.count === 'number' ? params.count : undefined;
  const s = resolve(key, count);
  if (s == null) return undefined;
  return params ? s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : s;
}

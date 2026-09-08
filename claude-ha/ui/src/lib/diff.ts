/**
 * Line-level diffs for the file-editing tools (Edit / Write / MultiEdit), so the
 * transcript shows a red/green diff instead of a raw JSON tool dump.
 */
export type DiffLine = { type: 'add' | 'del' | 'ctx'; text: string };

/** LCS line diff of two strings. Falls back to a plain remove-then-add for very
 *  large inputs to keep the O(n*m) table bounded. */
export function lineDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr.length ? oldStr.split('\n') : [];
  const b = newStr.length ? newStr.split('\n') : [];
  if (a.length === 0) return b.map((text) => ({ type: 'add', text }));
  if (b.length === 0) return a.map((text) => ({ type: 'del', text }));
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ];
  }
  const m = a.length;
  const n = b.length;
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });
  return out;
}

export interface EditBlock {
  title?: string;
  lines: DiffLine[];
}
export interface FileEditView {
  file: string;
  kind: 'edit' | 'write' | 'multiedit';
  blocks: EditBlock[];
  adds: number;
  dels: number;
}

export const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** Build a diff view from an Edit/Write/MultiEdit tool input, or null if the
 *  input is not yet complete enough (e.g. still streaming). */
export function fileEditView(name: string, input: unknown): FileEditView | null {
  const obj = (input ?? {}) as Record<string, unknown>;
  const file = typeof obj.file_path === 'string' ? obj.file_path : '';
  if (!file) return null;

  let blocks: EditBlock[] = [];
  let kind: FileEditView['kind'];

  if (name === 'Write') {
    kind = 'write';
    if (typeof obj.content !== 'string') return null;
    const content = obj.content;
    blocks = [{ lines: content.length ? content.split('\n').map((text) => ({ type: 'add' as const, text })) : [] }];
  } else if (name === 'MultiEdit') {
    kind = 'multiedit';
    const edits = Array.isArray(obj.edits) ? obj.edits : [];
    blocks = edits
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e, idx) => ({
        title: edits.length > 1 ? `Edit ${idx + 1}` : undefined,
        lines: lineDiff(String(e.old_string ?? ''), String(e.new_string ?? '')),
      }));
    if (!blocks.length) return null;
  } else {
    kind = 'edit';
    if (typeof obj.old_string !== 'string' || typeof obj.new_string !== 'string') return null;
    blocks = [{ lines: lineDiff(obj.old_string, obj.new_string) }];
  }

  let adds = 0;
  let dels = 0;
  for (const b of blocks) {
    for (const l of b.lines) {
      if (l.type === 'add') adds++;
      else if (l.type === 'del') dels++;
    }
  }
  return { file, kind, blocks, adds, dels };
}

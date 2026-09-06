import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { touchesProtectedFile, isProtectedPath, touchesAddonData } from '../src/hooks.ts';
import { redact } from '../src/audit.ts';

const CONFIG = '/config';

describe('secrets guard', () => {
  test('blocks Read/Edit/Write on secrets.yaml by absolute and relative path', () => {
    assert.ok(touchesProtectedFile(CONFIG, 'Read', { file_path: '/config/secrets.yaml' }));
    assert.ok(touchesProtectedFile(CONFIG, 'Edit', { file_path: 'secrets.yaml', old_string: 'a', new_string: 'b' }));
    assert.ok(touchesProtectedFile(CONFIG, 'Write', { file_path: '/config/./secrets.yaml', content: '' }));
    assert.equal(touchesProtectedFile(CONFIG, 'Read', { file_path: '/config/configuration.yaml' }), undefined);
    assert.equal(touchesProtectedFile(CONFIG, 'Read', { file_path: '/config/packages/secrets_backup.yaml' }), undefined);
  });

  test('blocks the auth store under .storage', () => {
    assert.ok(isProtectedPath(CONFIG, '/config/.storage/auth'));
    assert.ok(isProtectedPath(CONFIG, '.storage/auth_provider.homeassistant'));
    assert.equal(isProtectedPath(CONFIG, '/config/.storage/core.area_registry'), false);
  });

  test('blocks Bash and Grep commands that mention protected files', () => {
    assert.ok(touchesProtectedFile(CONFIG, 'Bash', { command: 'cat secrets.yaml' }));
    assert.ok(touchesProtectedFile(CONFIG, 'Bash', { command: 'grep -r token /config/.storage/auth' }));
    assert.ok(touchesProtectedFile(CONFIG, 'Grep', { pattern: 'password', path: '/config/secrets.yaml' }));
    assert.equal(touchesProtectedFile(CONFIG, 'Bash', { command: 'ls /config' }), undefined);
    assert.equal(touchesProtectedFile(CONFIG, 'Grep', { pattern: 'secret', path: '/config' }), undefined);
  });
});

describe('add-on data / credential guard', () => {
  const DATA = '/data';
  test('blocks reads of the add-on data dir and credential files', () => {
    assert.ok(touchesAddonData(DATA, 'Read', { file_path: '/data/options.json' }));
    assert.ok(touchesAddonData(DATA, 'Read', { file_path: '/data/.credentials.json' }));
    assert.ok(touchesAddonData(DATA, 'Bash', { command: 'cat /data/options.json' }));
    assert.ok(touchesAddonData(DATA, 'Bash', { command: 'ls /data/claude' }));
  });
  test('blocks Bash commands that dump credential tokens', () => {
    assert.ok(touchesAddonData(DATA, 'Bash', { command: 'printenv SUPERVISOR_TOKEN' }));
    assert.ok(touchesAddonData(DATA, 'Bash', { command: 'echo $CLAUDE_CODE_OAUTH_TOKEN' }));
    assert.ok(touchesAddonData(DATA, 'Bash', { command: 'env | grep ANTHROPIC_API_KEY' }));
  });
  test('allows normal work in the config dir', () => {
    assert.equal(touchesAddonData(DATA, 'Read', { file_path: '/config/configuration.yaml' }), undefined);
    assert.equal(touchesAddonData(DATA, 'Bash', { command: 'ls /config' }), undefined);
    assert.equal(touchesAddonData(DATA, 'Grep', { pattern: 'light', path: '/config' }), undefined);
  });
});

describe('audit redaction', () => {
  test('replaces secret-looking keys and truncates long strings', () => {
    const out = redact({
      api_key: 'sk-ant-123',
      Authorization: 'Bearer x',
      command: 'x'.repeat(1000),
      nested: { password: 'p', ok: 'fine' },
    }) as Record<string, unknown>;
    assert.equal(out.api_key, '[redacted]');
    assert.equal(out.Authorization, '[redacted]');
    assert.ok((out.command as string).length < 500);
    assert.deepEqual(out.nested, { password: '[redacted]', ok: 'fine' });
  });
});

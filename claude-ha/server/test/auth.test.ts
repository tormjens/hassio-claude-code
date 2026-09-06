import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCredentialEnv,
  buildCredentialEnv,
  credentialsConfigured,
  type AuthConfig,
} from '../src/auth.ts';

const cfg = (over: Partial<AuthConfig> = {}): AuthConfig => ({
  method: 'oauth',
  oauthToken: '',
  anthropicApiKey: '',
  anthropicBaseUrl: '',
  ...over,
});

describe('buildCredentialEnv', () => {
  test('oauth sets the OAuth token and strips the variables that outrank it', () => {
    const env = buildCredentialEnv(cfg({ oauthToken: 'oat-123' }));
    assert.equal(env.set.CLAUDE_CODE_OAUTH_TOKEN, 'oat-123');
    assert.ok(env.unset.includes('ANTHROPIC_API_KEY'));
    assert.ok(env.unset.includes('ANTHROPIC_AUTH_TOKEN'));

    const applied = applyCredentialEnv(
      { ANTHROPIC_API_KEY: 'sk-host', ANTHROPIC_AUTH_TOKEN: 'bearer', PATH: '/bin' },
      env,
    );
    assert.equal(applied.ANTHROPIC_API_KEY, undefined);
    assert.equal(applied.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(applied.CLAUDE_CODE_OAUTH_TOKEN, 'oat-123');
    assert.equal(applied.PATH, '/bin');
  });

  test('api_key sets the key and strips the OAuth token and bearer token', () => {
    const env = buildCredentialEnv(cfg({ method: 'api_key', anthropicApiKey: 'sk-ant-1', anthropicBaseUrl: 'https://gw' }));
    assert.deepEqual(env.set, { ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_API_KEY: 'sk-ant-1' });
    assert.ok(env.unset.includes('CLAUDE_CODE_OAUTH_TOKEN'));
    assert.ok(env.unset.includes('ANTHROPIC_AUTH_TOKEN'));

    const applied = applyCredentialEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' }, env);
    assert.equal(applied.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(applied.ANTHROPIC_API_KEY, 'sk-ant-1');
  });

  test('an empty OAuth token is not set, so the CLI does not select an empty credential', () => {
    const env = buildCredentialEnv(cfg());
    assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env.set, false);
  });
});

describe('credentialsConfigured', () => {
  test('oauth needs a token, api_key needs a key, a base URL satisfies either', () => {
    assert.equal(credentialsConfigured(cfg()), false);
    assert.equal(credentialsConfigured(cfg({ oauthToken: 'oat' })), true);
    assert.equal(credentialsConfigured(cfg({ method: 'api_key' })), false);
    assert.equal(credentialsConfigured(cfg({ method: 'api_key', anthropicApiKey: 'sk' })), true);
    assert.equal(credentialsConfigured(cfg({ anthropicBaseUrl: 'https://gw' })), true);
    assert.equal(credentialsConfigured(cfg({ method: 'api_key', anthropicBaseUrl: 'https://gw' })), true);
  });
});

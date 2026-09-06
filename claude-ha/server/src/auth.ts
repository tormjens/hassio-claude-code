/**
 * Authentication for the Claude Code subprocess the Agent SDK spawns.
 *
 * Two methods:
 *
 *   oauth    (default) a long-lived subscription OAuth token from
 *            `claude setup-token`, passed as CLAUDE_CODE_OAUTH_TOKEN. It
 *            authenticates against the user's Claude Pro/Max/Team/Enterprise
 *            subscription. No API billing, no static API key.
 *
 *   api_key  a static Anthropic API key (ANTHROPIC_API_KEY), billed to the
 *            user's API account. The legacy fallback.
 *
 * The CLI resolves credentials in this order (first wins): cloud provider,
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, apiKeyHelper, CLAUDE_CODE_OAUTH_TOKEN,
 * profiles, then interactive /login. So for the OAuth token to be used, both
 * ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY must be unset (they win even when
 * empty); for the API key, CLAUDE_CODE_OAUTH_TOKEN must not shadow anything
 * above it, but the key already outranks it, so it is removed for cleanliness.
 *
 * A base URL that points at a gateway which authenticates itself counts as
 * configured on its own; the gateway supplies the credential.
 */

export type AuthMethod = 'oauth' | 'api_key';

export interface AuthConfig {
  method: AuthMethod;
  /** Subscription OAuth token from `claude setup-token`. */
  oauthToken: string;
  /** Static API key, only for the api_key method. */
  anthropicApiKey: string;
  /** Optional gateway or custom endpoint. */
  anthropicBaseUrl: string;
}

export interface CredentialEnv {
  /** Variables to set on the subprocess. */
  set: Record<string, string>;
  /** Variables to remove from the inherited environment. */
  unset: string[];
}

/** Build the credential environment for the Claude Code subprocess. */
export function buildCredentialEnv(a: AuthConfig): CredentialEnv {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  if (a.anthropicBaseUrl) set.ANTHROPIC_BASE_URL = a.anthropicBaseUrl;

  if (a.method === 'api_key') {
    if (a.anthropicApiKey) set.ANTHROPIC_API_KEY = a.anthropicApiKey;
    unset.push('ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN');
    return { set, unset };
  }

  // oauth
  if (a.oauthToken) set.CLAUDE_CODE_OAUTH_TOKEN = a.oauthToken;
  unset.push('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN');
  return { set, unset };
}

/** Apply a CredentialEnv to a copy of `base`. */
export function applyCredentialEnv(
  base: NodeJS.ProcessEnv,
  cred: CredentialEnv,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const k of cred.unset) delete env[k];
  Object.assign(env, cred.set);
  return env;
}

/** True when enough is configured to attempt a request. */
export function credentialsConfigured(a: AuthConfig): boolean {
  if (a.anthropicBaseUrl) return true;
  return a.method === 'api_key' ? Boolean(a.anthropicApiKey) : Boolean(a.oauthToken);
}

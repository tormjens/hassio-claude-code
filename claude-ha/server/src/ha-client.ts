/**
 * Thin client for the Home Assistant Supervisor and Core APIs.
 *
 * Inside an add-on both are reached through http://supervisor using the
 * SUPERVISOR_TOKEN environment variable:
 *
 *   Supervisor API   http://supervisor/<endpoint>            (hassio_api: true)
 *   Core REST API    http://supervisor/core/api/<path>       (homeassistant_api: true)
 *   Core WebSocket   ws://supervisor/core/websocket          (homeassistant_api: true)
 *
 * Supervisor responses are wrapped in {"result": "ok"|"error", "data"|"message"}.
 * Core responses are passed through unchanged.
 *
 * The `fetch` and WebSocket implementations are injectable so the unit tests
 * can run without a Supervisor.
 */

export interface HaClientOptions {
  baseUrl?: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Factory for a WebSocket, injectable for tests. */
  webSocketFactory?: (url: string) => WebSocketLike;
  timeoutMs?: number;
}

/** The subset of the WebSocket API we use, compatible with `ws` and the DOM. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
}

export class HaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HaApiError';
  }
}

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HaServiceDomain {
  domain: string;
  services: Record<
    string,
    {
      name?: string;
      description?: string;
      fields?: Record<string, unknown>;
      target?: unknown;
      response?: { optional?: boolean };
    }
  >;
}

export interface ConfigCheckResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Which endpoint produced the result. */
  source: 'core' | 'supervisor';
  raw?: string;
}

export interface HaArea {
  area_id: string;
  name: string;
  floor_id?: string | null;
  icon?: string | null;
  aliases?: string[];
  labels?: string[];
}

export interface HaDevice {
  id: string;
  name: string | null;
  name_by_user: string | null;
  manufacturer: string | null;
  model: string | null;
  area_id: string | null;
  disabled_by: string | null;
  sw_version?: string | null;
}

export interface HaEntityRegistryEntry {
  entity_id: string;
  name: string | null;
  original_name: string | null;
  platform: string;
  area_id: string | null;
  device_id: string | null;
  disabled_by: string | null;
  hidden_by: string | null;
  labels?: string[];
}

export interface HaFloor {
  floor_id: string;
  name: string;
  level?: number | null;
  icon?: string | null;
}

interface SupervisorEnvelope<T> {
  result: 'ok' | 'error';
  data?: T;
  message?: string;
}

export class HaClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly wsFactory: (url: string) => WebSocketLike;
  private readonly timeoutMs: number;

  constructor(opts: HaClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'http://supervisor').replace(/\/$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsFactory =
      opts.webSocketFactory ??
      ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get configured(): boolean {
    return this.token.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Low level
  // ---------------------------------------------------------------------------

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      ...extra,
    };
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new HaApiError(`Request to ${path} timed out after ${timeoutMs} ms`, 0);
      }
      throw new HaApiError(`Request to ${path} failed: ${(err as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Call a Supervisor endpoint and unwrap the {result, data} envelope. */
  async supervisor<T = unknown>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const res = await this.request(path, init, timeoutMs);
    const text = await res.text();
    let parsed: SupervisorEnvelope<T> | undefined;
    try {
      parsed = text ? (JSON.parse(text) as SupervisorEnvelope<T>) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok || parsed?.result === 'error') {
      const message = parsed?.message ?? text ?? `HTTP ${res.status}`;
      throw new HaApiError(message, res.status, parsed ?? text);
    }
    return (parsed?.data ?? ({} as T)) as T;
  }

  /** Call a Core REST endpoint via the Supervisor proxy. Returns parsed JSON or text. */
  async core<T = unknown>(
    path: string,
    init: RequestInit = {},
    opts: { text?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const p = path.startsWith('/') ? path : `/${path}`;
    const res = await this.request(`/core/api${p}`, init, opts.timeoutMs);
    const body = await res.text();
    if (!res.ok) {
      let message = body;
      try {
        const j = JSON.parse(body) as { message?: string };
        if (j.message) message = j.message;
      } catch {
        // plain text error
      }
      if (res.status === 502) {
        message = `Home Assistant Core API is not reachable (${message || 'bad gateway'}). Core may be starting or stopped.`;
      }
      throw new HaApiError(message || `HTTP ${res.status}`, res.status, body);
    }
    if (opts.text) return body as unknown as T;
    if (!body) return undefined as unknown as T;
    try {
      return JSON.parse(body) as T;
    } catch {
      return body as unknown as T;
    }
  }

  private corePost<T = unknown>(path: string, data: unknown, opts?: { text?: boolean; timeoutMs?: number }): Promise<T> {
    return this.core<T>(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data ?? {}),
      },
      opts,
    );
  }

  // ---------------------------------------------------------------------------
  // States and services
  // ---------------------------------------------------------------------------

  async getStates(filter: { entityId?: string; domain?: string } = {}): Promise<HaState[]> {
    if (filter.entityId) {
      const one = await this.core<HaState>(`/states/${encodeURIComponent(filter.entityId)}`);
      return one ? [one] : [];
    }
    const all = await this.core<HaState[]>('/states');
    if (filter.domain) {
      const prefix = `${filter.domain}.`;
      return all.filter((s) => s.entity_id.startsWith(prefix));
    }
    return all;
  }

  async getServices(domain?: string): Promise<HaServiceDomain[]> {
    const all = await this.core<HaServiceDomain[]>('/services');
    return domain ? all.filter((d) => d.domain === domain) : all;
  }

  async callService(
    domain: string,
    service: string,
    data: Record<string, unknown> = {},
    target?: Record<string, unknown>,
    returnResponse = false,
  ): Promise<unknown> {
    const body: Record<string, unknown> = { ...data };
    if (target && Object.keys(target).length > 0) body.target = target;
    const query = returnResponse ? '?return_response' : '';
    return this.corePost(`/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}${query}`, body, {
      timeoutMs: 120_000,
    });
  }

  async renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string> {
    return this.corePost<string>('/template', { template, variables }, { text: true });
  }

  async getCoreConfig(): Promise<Record<string, unknown> & { components?: string[]; version?: string }> {
    return this.core('/config');
  }

  // ---------------------------------------------------------------------------
  // Config check, reload, restart
  // ---------------------------------------------------------------------------

  /**
   * Validate the YAML configuration.
   *
   * Preferred: Core's `POST /api/config/core/check_config`, which returns
   * structured errors and warnings. Fallback: Supervisor `POST /core/check`,
   * which runs `hass --script check_config` in the Core container and works
   * even when Core is down, but only returns raw text.
   */
  async checkConfig(): Promise<ConfigCheckResult> {
    try {
      const res = await this.corePost<{ result: 'valid' | 'invalid'; errors: string | null; warnings: string | null }>(
        '/config/core/check_config',
        {},
        { timeoutMs: 180_000 },
      );
      return {
        valid: res.result === 'valid',
        errors: splitLines(res.errors),
        warnings: splitLines(res.warnings),
        source: 'core',
      };
    } catch (err) {
      const e = err as HaApiError;
      // 404: config integration missing; 502: core down. Fall back to Supervisor.
      if (!(e instanceof HaApiError) || (e.status !== 404 && e.status !== 502 && e.status !== 0)) {
        throw err;
      }
    }
    try {
      await this.supervisor('/core/check', { method: 'POST' }, 300_000);
      return { valid: true, errors: [], warnings: [], source: 'supervisor' };
    } catch (err) {
      const e = err as HaApiError;
      if (e instanceof HaApiError && e.status === 400) {
        return { valid: false, errors: splitLines(e.message), warnings: [], source: 'supervisor', raw: e.message };
      }
      throw err;
    }
  }

  /** Reload a domain's YAML via its `<domain>.reload` service, or everything via homeassistant.reload_all. */
  async reload(domain: string): Promise<unknown> {
    if (domain === 'all' || domain === 'homeassistant') {
      return this.callService('homeassistant', 'reload_all');
    }
    if (domain === 'core_config') {
      return this.callService('homeassistant', 'reload_core_config');
    }
    return this.callService(domain, 'reload');
  }

  /** Domains that currently expose a `reload` service. */
  async reloadableDomains(): Promise<string[]> {
    const services = await this.getServices();
    return services.filter((d) => 'reload' in d.services).map((d) => d.domain).sort();
  }

  async restartCore(): Promise<void> {
    await this.supervisor('/core/restart', { method: 'POST' }, 300_000);
  }

  // ---------------------------------------------------------------------------
  // Logs and info
  // ---------------------------------------------------------------------------

  /** Tail the Core log from journald through the Supervisor. */
  async getCoreLogs(lines = 100): Promise<string> {
    const n = Math.max(2, Math.min(2000, Math.floor(lines)));
    const res = await this.request(`/core/logs?lines=${n}&no_colors`, {
      headers: { Accept: 'text/plain' },
    });
    const text = await res.text();
    if (!res.ok) throw new HaApiError(text || `HTTP ${res.status}`, res.status, text);
    return text;
  }

  async coreInfo(): Promise<Record<string, unknown>> {
    return this.supervisor('/core/info');
  }

  async selfInfo(): Promise<Record<string, unknown> & { ingress_entry?: string | null; version?: string }> {
    return this.supervisor('/addons/self/info');
  }

  // ---------------------------------------------------------------------------
  // WebSocket-only registries (areas, devices, entities, floors)
  // ---------------------------------------------------------------------------

  private wsUrl(): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/core/websocket`;
  }

  /**
   * Run several WebSocket commands over one authenticated connection and
   * return the results in order.
   */
  async wsCommands<T = unknown>(commands: Array<Record<string, unknown>>, timeoutMs = 30_000): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      const ws = this.wsFactory(this.wsUrl());
      const results = new Map<number, T>();
      let nextId = 1;
      let finished = false;
      const timer = setTimeout(() => fail(new HaApiError('WebSocket request timed out', 0)), timeoutMs);

      const finish = (fn: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore
        }
        fn();
      };
      const fail = (err: Error) => finish(() => reject(err));

      ws.addEventListener('error', (ev) => fail(new HaApiError(`WebSocket error: ${describe(ev)}`, 0)));
      ws.addEventListener('close', () => {
        if (!finished) fail(new HaApiError('WebSocket closed before all results arrived', 0));
      });
      ws.addEventListener('message', (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        switch (msg.type) {
          case 'auth_required':
            ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
            break;
          case 'auth_ok':
            for (const cmd of commands) {
              ws.send(JSON.stringify({ id: nextId++, ...cmd }));
            }
            break;
          case 'auth_invalid':
            fail(new HaApiError(`WebSocket auth failed: ${String(msg.message)}`, 401));
            break;
          case 'result': {
            const id = Number(msg.id);
            if (msg.success) {
              results.set(id, msg.result as T);
            } else {
              const err = msg.error as { code?: string; message?: string } | undefined;
              fail(new HaApiError(`${err?.code ?? 'error'}: ${err?.message ?? 'unknown'}`, 400, msg));
              return;
            }
            if (results.size === commands.length) {
              finish(() => resolve(commands.map((_, i) => results.get(i + 1) as T)));
            }
            break;
          }
          default:
            break;
        }
      });
    });
  }

  async getRegistries(): Promise<{
    areas: HaArea[];
    devices: HaDevice[];
    entities: HaEntityRegistryEntry[];
    floors: HaFloor[];
  }> {
    const [areas, devices, entities, floors] = await this.wsCommands<unknown[]>([
      { type: 'config/area_registry/list' },
      { type: 'config/device_registry/list' },
      { type: 'config/entity_registry/list' },
      { type: 'config/floor_registry/list' },
    ]);
    return {
      areas: areas as HaArea[],
      devices: devices as HaDevice[],
      entities: entities as HaEntityRegistryEntry[],
      floors: floors as HaFloor[],
    };
  }
}

function splitLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

function describe(ev: unknown): string {
  if (ev && typeof ev === 'object' && 'message' in ev) return String((ev as { message: unknown }).message);
  return 'unknown';
}

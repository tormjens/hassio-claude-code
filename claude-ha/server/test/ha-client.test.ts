import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HaClient, HaApiError, type WebSocketLike } from '../src/ha-client.ts';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function mockFetch(routes: Record<string, Handler>): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.replace('http://supervisor', '').startsWith(k));
    if (!key) return new Response('not found', { status: 404 });
    return routes[key](url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('HaClient core proxy', () => {
  test('sends the Supervisor token as a bearer header and hits /core/api', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/core/api/states': () => json([{ entity_id: 'light.a', state: 'on', attributes: {} }]),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    const states = await ha.getStates();
    assert.equal(states.length, 1);
    assert.equal(calls[0].url, 'http://supervisor/core/api/states');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer tok');
  });

  test('filters states by domain and fetches a single entity by id', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/core/api/states/light.kitchen': () => json({ entity_id: 'light.kitchen', state: 'off', attributes: {} }),
      '/core/api/states': () =>
        json([
          { entity_id: 'light.a', state: 'on', attributes: {} },
          { entity_id: 'sensor.b', state: '1', attributes: {} },
        ]),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    const lights = await ha.getStates({ domain: 'light' });
    assert.deepEqual(lights.map((s) => s.entity_id), ['light.a']);
    const one = await ha.getStates({ entityId: 'light.kitchen' });
    assert.equal(one[0].state, 'off');
    assert.ok(calls.some((c) => c.url.endsWith('/states/light.kitchen')));
  });

  test('callService posts JSON with target and honours return_response', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/core/api/services/light/turn_on': () => json([]),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    await ha.callService('light', 'turn_on', { brightness_pct: 50 }, { entity_id: 'light.a' }, true);
    assert.equal(calls[0].url, 'http://supervisor/core/api/services/light/turn_on?return_response');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { brightness_pct: 50, target: { entity_id: 'light.a' } });
  });

  test('surfaces Core error messages and maps 502 to a readable error', async () => {
    const { fetchImpl } = mockFetch({
      '/core/api/template': () => json({ message: 'Error rendering template: boom' }, 400),
      '/core/api/states': () => new Response('Bad Gateway', { status: 502 }),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    await assert.rejects(ha.renderTemplate('{{ x'), (err: unknown) => {
      assert.ok(err instanceof HaApiError);
      assert.equal(err.status, 400);
      assert.match(err.message, /Error rendering template: boom/);
      return true;
    });
    await assert.rejects(ha.getStates(), /not reachable/);
  });

  test('renderTemplate returns plain text', async () => {
    const { fetchImpl } = mockFetch({
      '/core/api/template': () => new Response('21.5', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    assert.equal(await ha.renderTemplate('{{ states("sensor.t") }}'), '21.5');
  });
});

describe('HaClient supervisor endpoints', () => {
  test('unwraps the {result, data} envelope and throws on result=error', async () => {
    const { fetchImpl } = mockFetch({
      '/core/info': () => json({ result: 'ok', data: { version: '2026.9.1' } }),
      '/core/restart': () => json({ result: 'error', message: 'Offline database migration in progress' }, 400),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    const info = await ha.coreInfo();
    assert.equal(info.version, '2026.9.1');
    await assert.rejects(ha.restartCore(), /database migration/);
  });

  test('getCoreLogs clamps lines, asks for text and returns the raw log', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/core/logs': () => new Response('line1\nline2\n', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    const log = await ha.getCoreLogs(1);
    assert.equal(log, 'line1\nline2\n');
    assert.equal(calls[0].url, 'http://supervisor/core/logs?lines=2&no_colors');
    assert.equal((calls[0].init.headers as Record<string, string>).Accept, 'text/plain');
  });
});

describe('HaClient.checkConfig', () => {
  test('uses the Core endpoint and splits errors and warnings', async () => {
    const { fetchImpl } = mockFetch({
      '/core/api/config/core/check_config': () =>
        json({ result: 'invalid', errors: 'Invalid config for automation at automations.yaml, line 3\nsecond', warnings: null }),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    const res = await ha.checkConfig();
    assert.equal(res.valid, false);
    assert.equal(res.source, 'core');
    assert.deepEqual(res.errors, ['Invalid config for automation at automations.yaml, line 3', 'second']);
    assert.deepEqual(res.warnings, []);
  });

  test('falls back to Supervisor /core/check when Core is unavailable', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/core/api/config/core/check_config': () => new Response('Bad Gateway', { status: 502 }),
      '/core/check': () => json({ result: 'error', message: 'Testing configuration at /config\nFailed config\n  automation: bad' }, 400),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    const res = await ha.checkConfig();
    assert.equal(res.valid, false);
    assert.equal(res.source, 'supervisor');
    assert.ok(res.errors.some((l) => l.includes('automation: bad')));
    assert.equal(calls[1].url, 'http://supervisor/core/check');
    assert.equal(calls[1].init.method, 'POST');
  });

  test('Supervisor fallback reports valid on result=ok', async () => {
    const { fetchImpl } = mockFetch({
      '/core/api/config/core/check_config': () => new Response('', { status: 404 }),
      '/core/check': () => json({ result: 'ok', data: {} }),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    const res = await ha.checkConfig();
    assert.equal(res.valid, true);
    assert.equal(res.source, 'supervisor');
  });
});

describe('HaClient.reload', () => {
  test('maps "all" to homeassistant.reload_all and domains to <domain>.reload', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/core/api/services/': () => json([]),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    await ha.reload('all');
    await ha.reload('automation');
    await ha.reload('core_config');
    assert.deepEqual(
      calls.map((c) => c.url.replace('http://supervisor/core/api/services/', '')),
      ['homeassistant/reload_all', 'automation/reload', 'homeassistant/reload_core_config'],
    );
  });

  test('reloadableDomains lists domains exposing a reload service', async () => {
    const { fetchImpl } = mockFetch({
      '/core/api/services': () =>
        json([
          { domain: 'automation', services: { reload: {}, trigger: {} } },
          { domain: 'light', services: { turn_on: {} } },
          { domain: 'script', services: { reload: {} } },
        ]),
    });
    const ha = new HaClient({ token: 'tok', fetchImpl });
    assert.deepEqual(await ha.reloadableDomains(), ['automation', 'script']);
  });
});

/** Scripted fake of the Core WebSocket behind the Supervisor proxy. */
class FakeSocket implements WebSocketLike {
  sent: Array<Record<string, unknown>> = [];
  private listeners: Record<string, Array<(ev: { data: unknown }) => void>> = {};
  constructor(private readonly results: Record<string, unknown>, private readonly rejectAuth = false) {
    queueMicrotask(() => this.fire('message', { type: 'auth_required', ha_version: '2026.9.1' }));
  }
  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    if (msg.type === 'auth') {
      if (this.rejectAuth) this.fire('message', { type: 'auth_invalid', message: 'Invalid access' });
      else this.fire('message', { type: 'auth_ok', ha_version: '2026.9.1' });
      return;
    }
    const type = msg.type as string;
    if (type in this.results) {
      this.fire('message', { id: msg.id, type: 'result', success: true, result: this.results[type] });
    } else {
      this.fire('message', { id: msg.id, type: 'result', success: false, error: { code: 'unknown_command', message: `Unknown command ${type}` } });
    }
  }
  close(): void {
    this.fire('close', {});
  }
  addEventListener(type: string, listener: (ev: { data: unknown }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  private fire(type: string, payload: unknown): void {
    for (const l of this.listeners[type] ?? []) l({ data: JSON.stringify(payload) });
  }
}

describe('HaClient websocket registries', () => {
  test('authenticates with the Supervisor token and returns results in order', async () => {
    let socket: FakeSocket | undefined;
    const ha = new HaClient({
      token: 'tok',
      fetchImpl: fetch,
      webSocketFactory: (url) => {
        assert.equal(url, 'ws://supervisor/core/websocket');
        socket = new FakeSocket({
          'config/area_registry/list': [{ area_id: 'garage', name: 'Garage' }],
          'config/device_registry/list': [],
          'config/entity_registry/list': [{ entity_id: 'cover.garage', area_id: 'garage' }],
          'config/floor_registry/list': [],
        });
        return socket;
      },
    });
    const reg = await ha.getRegistries();
    assert.equal(reg.areas[0].name, 'Garage');
    assert.equal(reg.entities[0].entity_id, 'cover.garage');
    assert.deepEqual(socket!.sent[0], { type: 'auth', access_token: 'tok' });
  });

  test('rejects on auth_invalid and on command errors', async () => {
    const bad = new HaClient({ token: 'tok', webSocketFactory: () => new FakeSocket({}, true) });
    await assert.rejects(bad.getRegistries(), /auth failed/);
    const unknown = new HaClient({ token: 'tok', webSocketFactory: () => new FakeSocket({}) });
    await assert.rejects(unknown.getRegistries(), /unknown_command/);
  });
});

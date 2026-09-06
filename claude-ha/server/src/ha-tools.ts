/**
 * In-process MCP server exposing Home Assistant to the model.
 *
 * Built with the Agent SDK's `tool()` + `createSdkMcpServer()`. The server is
 * registered under the name "ha", so the fully-qualified tool names the SDK
 * uses for permissions and hooks are `mcp__ha__<tool>`.
 *
 * Read-only tools carry `readOnlyHint: true` so the permission layer can
 * auto-approve them when the user opts in. Write tools are marked
 * destructive and always go through the permission flow.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HaClient, HaState } from './ha-client.js';

export const HA_SERVER_NAME = 'ha';

export function qualified(toolName: string): string {
  return `mcp__${HA_SERVER_NAME}__${toolName}`;
}

const READ_ONLY_TOOL_NAMES = [
  'ha_get_states',
  'ha_get_services',
  'ha_check_config',
  'ha_get_logs',
  'ha_list_integrations',
  'ha_get_areas_devices',
  'ha_render_template',
  'ha_list_secret_keys',
] as const;

export const WRITE_TOOL_NAMES = ['ha_call_service', 'ha_reload', 'ha_restart_core'] as const;

/** Fully qualified names of tools that only read state. */
export const READ_ONLY_TOOLS = new Set(READ_ONLY_TOOL_NAMES.map(qualified));

const MAX_RESULT_CHARS = 60_000;

function text(value: unknown): CallToolResult {
  let out = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (out.length > MAX_RESULT_CHARS) {
    out = `${out.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${out.length - MAX_RESULT_CHARS} characters, narrow the query]`;
  }
  return { content: [{ type: 'text', text: out }] };
}

function error(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Trim a state object to what the model usually needs. */
function compactState(s: HaState, full: boolean): unknown {
  if (full) return s;
  const a = s.attributes ?? {};
  const keep: Record<string, unknown> = {};
  for (const key of ['friendly_name', 'device_class', 'unit_of_measurement', 'id', 'last_triggered', 'mode', 'current', 'icon']) {
    if (key in a) keep[key] = a[key];
  }
  return { entity_id: s.entity_id, state: s.state, attributes: keep, last_changed: s.last_changed };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const writes = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

export interface HaToolsOptions {
  ha: HaClient;
  configDir: string;
}

export function createHaTools({ ha, configDir }: HaToolsOptions): McpSdkServerConfigWithInstance {
  const getStates = tool(
    'ha_get_states',
    'Get current entity states and attributes from Home Assistant. Filter by a full entity_id (for example light.kitchen) or by domain (for example automation). Returns compact records unless full=true. Use search to keep results small: it matches entity_id and friendly_name case-insensitively.',
    {
      entity_id: z.string().optional().describe('Exact entity id, for example automation.garage_door_open'),
      domain: z.string().optional().describe('Restrict to a domain such as light, sensor, automation'),
      search: z.string().optional().describe('Case-insensitive substring to match against entity_id and friendly_name'),
      full: z.boolean().optional().describe('Return all attributes instead of a compact summary'),
      limit: z.number().int().min(1).max(500).optional().describe('Maximum entities to return, default 100'),
    },
    async (args) => {
      try {
        let states = await ha.getStates({ entityId: args.entity_id, domain: args.domain });
        if (args.search) {
          const q = args.search.toLowerCase();
          states = states.filter(
            (s) =>
              s.entity_id.toLowerCase().includes(q) ||
              String(s.attributes?.friendly_name ?? '').toLowerCase().includes(q),
          );
        }
        const limit = args.limit ?? 100;
        const total = states.length;
        const page = states.slice(0, limit).map((s) => compactState(s, Boolean(args.full)));
        return text({ total, returned: page.length, states: page });
      } catch (err) {
        return error(`ha_get_states failed: ${errMessage(err)}`);
      }
    },
    { annotations: { ...readOnly, title: 'Get entity states' } },
  );

  const getServices = tool(
    'ha_get_services',
    'List the services (actions) Home Assistant currently exposes, with their fields. Filter by domain to keep the output small, for example light or automation.',
    {
      domain: z.string().optional().describe('Only return services of this domain'),
    },
    async (args) => {
      try {
        const services = await ha.getServices(args.domain);
        if (!args.domain) {
          // Without a filter the full list is huge; return domain -> service names.
          return text(
            services.map((d) => ({ domain: d.domain, services: Object.keys(d.services) })),
          );
        }
        return text(services);
      } catch (err) {
        return error(`ha_get_services failed: ${errMessage(err)}`);
      }
    },
    { annotations: { ...readOnly, title: 'List services' } },
  );

  const callService = tool(
    'ha_call_service',
    'Call a Home Assistant service (action), for example domain=light service=turn_on with target {entity_id: "light.kitchen"} and data {brightness_pct: 50}. This changes the state of the home; explain what you are about to do before calling it. Use return_response=true only for services that return data.',
    {
      domain: z.string().describe('Service domain, for example light'),
      service: z.string().describe('Service name, for example turn_on'),
      target: z
        .object({
          entity_id: z.union([z.string(), z.array(z.string())]).optional(),
          device_id: z.union([z.string(), z.array(z.string())]).optional(),
          area_id: z.union([z.string(), z.array(z.string())]).optional(),
          label_id: z.union([z.string(), z.array(z.string())]).optional(),
          floor_id: z.union([z.string(), z.array(z.string())]).optional(),
        })
        .optional()
        .describe('Entities, devices, areas, labels or floors to target'),
      data: z.record(z.string(), z.unknown()).optional().describe('Service data fields'),
      return_response: z.boolean().optional().describe('Ask the service for a response payload'),
    },
    async (args) => {
      try {
        const result = await ha.callService(args.domain, args.service, args.data ?? {}, args.target, args.return_response);
        return text({ ok: true, result });
      } catch (err) {
        return error(`ha_call_service ${args.domain}.${args.service} failed: ${errMessage(err)}`);
      }
    },
    { annotations: { ...writes, title: 'Call service' } },
  );

  const checkConfig = tool(
    'ha_check_config',
    'Validate the Home Assistant YAML configuration without applying it. Always run this after editing YAML and before reloading or restarting. Returns errors and warnings verbatim.',
    {},
    async () => {
      try {
        const res = await ha.checkConfig();
        return { ...text(res), isError: !res.valid };
      } catch (err) {
        return error(`ha_check_config failed: ${errMessage(err)}`);
      }
    },
    { annotations: { ...readOnly, title: 'Check configuration' } },
  );

  const reload = tool(
    'ha_reload',
    'Reload YAML configuration for one domain without restarting Home Assistant, for example automation, script, scene, template, group, input_boolean. Use "all" for homeassistant.reload_all or "core_config" for the homeassistant: section. The configuration check must pass first; a hook blocks this call otherwise.',
    {
      domain: z.string().describe('Domain to reload, or "all" / "core_config"'),
    },
    async (args) => {
      try {
        const result = await ha.reload(args.domain);
        return text({ ok: true, domain: args.domain, result });
      } catch (err) {
        const msg = errMessage(err);
        if (/not found|does not exist|Service .* not found/i.test(msg)) {
          try {
            const domains = await ha.reloadableDomains();
            return error(`ha_reload failed: ${msg}. Domains with a reload service: ${domains.join(', ')}`);
          } catch {
            // fall through
          }
        }
        return error(`ha_reload failed: ${msg}`);
      }
    },
    { annotations: { ...writes, title: 'Reload configuration' } },
  );

  const restartCore = tool(
    'ha_restart_core',
    'Restart Home Assistant Core. Only needed for changes that cannot be reloaded (new integrations, changes to the http: or recorder: sections, and so on). The configuration check must pass first; a hook blocks this call otherwise. The UI will be unavailable for a minute or two.',
    {},
    async () => {
      try {
        await ha.restartCore();
        return text({ ok: true, message: 'Home Assistant Core is restarting.' });
      } catch (err) {
        return error(`ha_restart_core failed: ${errMessage(err)}`);
      }
    },
    { annotations: { ...writes, title: 'Restart Home Assistant' } },
  );

  const getLogs = tool(
    'ha_get_logs',
    'Tail the Home Assistant Core log. Optionally filter lines with a case-insensitive substring or regular expression, for example "error" or "automation.garage".',
    {
      lines: z.number().int().min(2).max(2000).optional().describe('Number of most recent lines, default 200'),
      filter: z.string().optional().describe('Only return lines matching this substring or regex'),
    },
    async (args) => {
      try {
        const raw = await ha.getCoreLogs(args.lines ?? 200);
        let lines = raw.split('\n');
        if (args.filter) {
          let re: RegExp | undefined;
          try {
            re = new RegExp(args.filter, 'i');
          } catch {
            re = undefined;
          }
          const q = args.filter.toLowerCase();
          lines = lines.filter((l) => (re ? re.test(l) : l.toLowerCase().includes(q)));
        }
        return text(lines.join('\n') || '(no matching log lines)');
      } catch (err) {
        return error(`ha_get_logs failed: ${errMessage(err)}`);
      }
    },
    { annotations: { ...readOnly, title: 'Read Core log' } },
  );

  const listIntegrations = tool(
    'ha_list_integrations',
    'List the integrations (components) currently loaded in Home Assistant together with the Core version and basic instance info.',
    {},
    async () => {
      try {
        const cfg = await ha.getCoreConfig();
        const components = (cfg.components ?? []).slice().sort();
        return text({
          version: cfg.version,
          location_name: cfg.location_name,
          time_zone: cfg.time_zone,
          config_dir: cfg.config_dir,
          unit_system: cfg.unit_system,
          integrations: components,
        });
      } catch (err) {
        return error(`ha_list_integrations failed: ${errMessage(err)}`);
      }
    },
    { annotations: { ...readOnly, title: 'List integrations' } },
  );

  const getAreasDevices = tool(
    'ha_get_areas_devices',
    'Inventory of floors, areas, devices and which entities belong to them. Use this to translate names like "the garage" into entity ids. Optionally filter by a case-insensitive search term matched against area, device and entity names.',
    {
      search: z.string().optional().describe('Filter areas, devices and entities by name substring'),
      include_entities: z.boolean().optional().describe('Include the entity registry, default true'),
    },
    async (args) => {
      try {
        const reg = await ha.getRegistries();
        const q = args.search?.toLowerCase();
        const match = (...values: Array<string | null | undefined>) =>
          !q || values.some((v) => v && v.toLowerCase().includes(q));
        const areas = reg.areas.filter((a) => match(a.name, a.area_id));
        const areaIds = new Set(areas.map((a) => a.area_id));
        const devices = reg.devices.filter(
          (d) => !d.disabled_by && (match(d.name_by_user, d.name, d.manufacturer, d.model) || (d.area_id && areaIds.has(d.area_id))),
        );
        const deviceIds = new Set(devices.map((d) => d.id));
        const entities =
          args.include_entities === false
            ? []
            : reg.entities.filter(
                (e) =>
                  !e.disabled_by &&
                  (match(e.entity_id, e.name, e.original_name) ||
                    (e.area_id && areaIds.has(e.area_id)) ||
                    (e.device_id && deviceIds.has(e.device_id))),
              );
        return text({
          floors: reg.floors.map((f) => ({ floor_id: f.floor_id, name: f.name, level: f.level })),
          areas: areas.map((a) => ({ area_id: a.area_id, name: a.name, floor_id: a.floor_id })),
          devices: devices.map((d) => ({
            id: d.id,
            name: d.name_by_user ?? d.name,
            manufacturer: d.manufacturer,
            model: d.model,
            area_id: d.area_id,
          })),
          entities: entities.map((e) => ({
            entity_id: e.entity_id,
            name: e.name ?? e.original_name,
            platform: e.platform,
            area_id: e.area_id,
            device_id: e.device_id,
          })),
        });
      } catch (err) {
        return error(`ha_get_areas_devices failed: ${errMessage(err)}`);
      }
    },
    { annotations: { ...readOnly, title: 'Areas and devices' } },
  );

  const renderTemplate = tool(
    'ha_render_template',
    'Render a Home Assistant Jinja2 template against the live state, for example "{{ states(\'sensor.temperature\') }}" or "{{ states.automation | selectattr(\'attributes.friendly_name\', \'search\', \'garage\') | map(attribute=\'entity_id\') | list }}". Great for testing template sensors before writing them to YAML.',
    {
      template: z.string().describe('Jinja2 template source'),
      variables: z.record(z.string(), z.unknown()).optional().describe('Optional template variables'),
    },
    async (args) => {
      try {
        const rendered = await ha.renderTemplate(args.template, args.variables);
        return text(rendered);
      } catch (err) {
        return error(`Template error: ${errMessage(err)}`);
      }
    },
    { annotations: { ...readOnly, title: 'Render template' } },
  );

  const listSecretKeys = tool(
    'ha_list_secret_keys',
    'List the key names defined in secrets.yaml so you can reference them with !secret. The values are never exposed; reading secrets.yaml directly is blocked.',
    {},
    async () => {
      try {
        const file = path.join(configDir, 'secrets.yaml');
        const raw = await fs.readFile(file, 'utf8');
        const keys: string[] = [];
        for (const line of raw.split('\n')) {
          const m = /^([A-Za-z0-9_.-]+)\s*:/.exec(line);
          if (m && !line.trimStart().startsWith('#')) keys.push(m[1]);
        }
        return text({ file: 'secrets.yaml', keys });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') return text({ file: 'secrets.yaml', keys: [], note: 'secrets.yaml does not exist yet' });
        return error(`ha_list_secret_keys failed: ${errMessage(err)}`);
      }
    },
    { annotations: { ...readOnly, title: 'List secret keys' } },
  );

  return createSdkMcpServer({
    name: HA_SERVER_NAME,
    version: '0.1.0',
    instructions:
      'Tools for inspecting and controlling the Home Assistant instance this add-on runs in. Prefer ha_get_areas_devices and ha_get_states to resolve names to entity ids, ha_check_config after every YAML edit, and ha_reload over ha_restart_core whenever the domain supports reloading.',
    alwaysLoad: true,
    tools: [
      getStates,
      getServices,
      callService,
      checkConfig,
      reload,
      restartCore,
      getLogs,
      listIntegrations,
      getAreasDevices,
      renderTemplate,
      listSecretKeys,
    ],
  });
}

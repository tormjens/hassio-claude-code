# Implementation notes and open questions

This file records every place where a judgement call was made or where the
documentation was ambiguous or contradicted the original brief. Docs were
checked on 2026-09-06 against the Agent SDK reference, the Home Assistant
add-on (now "apps") developer docs and the Supervisor and Core source code.

## Status and handoff

Implemented and committed so far:

- Phase 1, skeleton: repository manifest, `config.yaml`, Dockerfile, s6 service,
  static + WebSocket server reachable through ingress.
- Phase 2, agent loop: Agent SDK `query()` in streaming-input mode, live text
  and tool streaming to the browser, permission prompts round-tripped to the UI,
  per-session permission mode, sessions persisted under `/data/sessions` and
  resumable after a restart, bare-bones Vue UI.
- Phase 3, HA tools and hooks: in-process MCP server with all requested tools,
  config-check guard before reload and restart, secrets guard, git checkpoint
  before the first edit, audit log, unit tests with mocked HTTP and WebSocket.

Remaining (planned for a local machine, see the brief):

- Phase 4, UI polish: sidebar actions (rename, delete, revert), Markdown and
  code highlighting, tool cards, unified diffs for Edit and Write, inline
  permission cards, HA theme polish, companion-app check.
- Phase 5, packaging and docs: GitHub Actions workflow with the new
  `home-assistant/builder` composite actions, DOCS.md, README.md, CHANGELOG.md,
  icon.png and logo.png.

Verified in this environment: server typecheck and unit tests, Vue build, an
end-to-end chat against the real Agent SDK (file write with permission prompt,
secrets guard denial, git checkpoint, audit log, restart and resume).
Not verified here: the Docker image build. The sandbox's egress policy blocks
ghcr.io blob storage, Docker Hub and the Alpine package mirror. Build it
locally with `docker build` in `claude-ha/` or let the Supervisor build it.

## Agent SDK

- **V2 session API is removed, not just unstable.** The docs page is titled
  "TypeScript SDK V2 session API (removed)"; 0.3.142 dropped
  `unstable_v2_createSession` and friends. The add-on therefore uses `query()`
  with an `AsyncIterable<SDKUserMessage>` prompt (the documented, preferred
  multi-turn pattern). One long-lived `query()` per chat session; a pushable
  async queue feeds it user turns.
- **The SDK bundles the Claude Code CLI as a native binary** via optional
  platform packages, including `linux-x64-musl` and `linux-arm64-musl`. The
  brief asked to install `@anthropic-ai/claude-code` globally; that would
  duplicate a 200 MB binary and pin a second version. Decision: rely on the
  SDK's bundled binary, install nothing globally. `npm ci` on the target
  platform picks the right optional package (npm uses `process.report` libc
  detection, so Alpine gets the musl build).
- **Node version.** The SDK declares `node >= 18`; the standalone CLI package
  declares `node >= 22`. The image uses Alpine 3.24's Node 24. The server
  itself targets Node 22+.
- **`env` replaces the subprocess environment** instead of merging. The agent
  spreads `process.env` and then sets `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`.
- **Permission flow order** is hooks, deny rules, ask rules, permission mode,
  allow rules, then `canUseTool`. Tools auto-approved by the mode never reach
  `canUseTool`, which is why the secrets guard and the config-check guard are
  PreToolUse hooks (they apply in every mode) rather than permission logic.
- **`acceptEdits` and MCP tools.** `acceptEdits` only auto-approves file edits.
  HA write tools (`ha_call_service`, `ha_reload`, `ha_restart_core`) still
  prompt in that mode, which is the conservative reading of "auto-approve
  edits".
- **Read-only HA tools** are annotated `readOnlyHint: true`. The SDK does not
  auto-approve on that annotation by itself, so `canUseTool` allows the
  read-only set when the `auto_approve_readonly_tools` option is on (default
  on). Rationale: Claude Code's built-in Read/Grep never prompt either, and
  asking before every `ha_get_states` made the "list my garage automations"
  flow unusable. Turn the option off to be asked for everything.
- **"Always allow"** records the tool name on the session and returns a
  session-scoped `addRules` permission update. The SDK's own `suggestions`
  are not used because they can widen to path prefixes the user did not see.
- **`settingSources: ['project']`** so a `CLAUDE.md` or `.claude/settings.json`
  in `/config` is honoured (power users can steer the model). User and local
  settings from the container's home are not loaded. `strictMcpConfig: true`
  so a `.mcp.json` in `/config` cannot silently add MCP servers.
- **System prompt**: preset `claude_code` with an appended Home Assistant
  section rather than a fully custom prompt, so file tools keep their tuned
  instructions.
- **Session transcripts live in two places**: the add-on's own compact
  transcript in `/data/sessions/<id>.json` (what the UI renders) and the SDK's
  JSONL under `CLAUDE_CONFIG_DIR=/data/claude` (what `resume` needs). Both
  are on the persistent volume. Deleting a session deletes both.
- **Other auth methods the SDK supports** (documented, not implemented):
  `ANTHROPIC_AUTH_TOKEN` (bearer token for gateways), `CLAUDE_CODE_OAUTH_TOKEN`
  from `claude setup-token`, Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`), Vertex
  (`CLAUDE_CODE_USE_VERTEX=1`), Foundry (`CLAUDE_CODE_USE_FOUNDRY=1`),
  `apiKeyHelper` in settings. The SDK overview states third parties may not
  offer claude.ai login without approval, so no OAuth flow in v1. Users who
  set `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` via a gateway can
  leave the API key empty; the server only refuses to send when none of the
  three is present.
- **Thinking blocks**: the SDK streams `thinking` content blocks; the UI shows
  them collapsed. Display defaults follow the model.
- **`stream_event` typing**: the SDK types the event as the Anthropic SDK's
  `BetaRawMessageStreamEvent`; the agent narrows it structurally to keep the
  add-on independent of Anthropic SDK type churn.

## Home Assistant add-on packaging

- **Add-ons were renamed "Apps"** in HA 2026.2. Config keys are unchanged.
  The image label is `io.hass.type="app"`.
- **`build.yaml` is deprecated.** The docs say it "is no longer used" and the
  Supervisor warns when it is present. The brief asked for one; docs win, so
  the base image is set in the Dockerfile with `ARG BUILD_FROM=<default>` +
  `FROM ${BUILD_FROM}`. Since Supervisor 2026.04 `BUILD_FROM` is no longer
  injected, hence the default value.
- **Base image**: `ghcr.io/home-assistant/base:3.24` (multi-arch Alpine). The
  Claude Code native binary supports musl since 1.0.73 and needs `libgcc`,
  `libstdc++` and a system `ripgrep` with `USE_BUILTIN_RIPGREP=0`. A past
  musl regression (claude-code #29559) is closed. If a future SDK release
  breaks on musl, switch `BUILD_FROM` to `ghcr.io/home-assistant/base-debian:trixie`
  and replace `apk add` with `apt-get install nodejs npm git ripgrep`.
- **Build stages** use `--platform=$BUILDPLATFORM node:22-alpine` so tsc and
  Vite run natively during aarch64 cross builds. The runtime stage installs
  production deps for the target platform so the correct musl binary lands.
- **`map` syntax**: the string form `config:rw` is deprecated (`config` now
  means the app's own config folder). The object form is used:
  `type: homeassistant_config, read_only: false, path: /config`. Without
  `path` it would mount at `/homeassistant`; `/config` keeps the model's cwd
  matching every HA tutorial. `ssl` is mounted read-only.
- **`init: false`** is mandatory with the s6 v3 base image.
- **`hassio_role: homeassistant`** is the minimum role for `/core/check`,
  `/core/restart` and `/core/logs`. `/addons/self/info` needs no role.
- **Ingress**: WebSockets work through ingress with no extra option;
  `ingress_stream` only affects POST body streaming and is left off. The
  server binds 0.0.0.0:8099 and only accepts requests from the ingress
  gateway 172.30.32.2 (or loopback) unless running outside the Supervisor.
- **`image:` is commented out** in `config.yaml` so a fresh install builds
  locally until the GitHub Actions workflow has published
  `ghcr.io/tormjens/claude-ha`. Uncomment it in the same release that first
  publishes images.
- **Options schema**: `anthropic_api_key` is `password?` (optional) so the
  add-on can start and show a clear message instead of failing validation.
  Optional options are omitted from `options:` because a default value makes
  a schema key required.
- **Persistent HOME**: `HOME=/data/home` and `CLAUDE_CONFIG_DIR=/data/claude`
  so Claude Code state survives add-on updates. `home/.cache` and `home/.npm`
  are excluded from backups.
- **s6 `finish` script** halts the container on a non-zero exit so the
  Supervisor watchdog and the user see failures instead of a silent restart
  loop.

## Home Assistant APIs

- **Config check**: Core `POST /api/config/core/check_config` returns
  structured `errors` / `warnings` and is used first. Supervisor
  `POST /core/check` (runs `hass --script check_config` in the Core container)
  is the fallback when Core is down (502) or the `config` integration is
  missing (404); it returns the whole script output as the error message.
- **Reload**: there is no WebSocket "reload" command; reloads are service
  calls (`<domain>.reload`, `homeassistant.reload_all`,
  `homeassistant.reload_core_config`). `reload_all` runs its own config check
  and refuses if invalid. Our PreToolUse hook checks before any reload so the
  errors reach the model verbatim.
- **Logs**: Core `GET /api/error_log` only exists when file logging is on
  (not on stock HA OS). `ha_get_logs` uses Supervisor `GET /core/logs?lines=N`
  (journald, `text/plain`, minimum 2 lines).
- **Registries** (areas, devices, entities, floors) are WebSocket-only:
  `ws://supervisor/core/websocket`, auth with `{"type":"auth","access_token":
  SUPERVISOR_TOKEN}`, commands `config/*_registry/list`.
- **`GET /api/services`** returns `services` as an object keyed by service
  name, not a list as the REST docs example shows.
- The Supervisor proxy only forwards GET, POST and DELETE to Core.

## Safety

- **Protected files**: `secrets.yaml` plus `.storage/auth`,
  `.storage/auth_provider.homeassistant`, `.storage/onboarding`,
  `.storage/cloud`, `.storage/hassio`. The brief named only `secrets.yaml`;
  the `.storage` auth files hold refresh tokens and password hashes, so they
  are treated the same. Read, Edit, Write, Grep, Glob and Bash inputs are
  checked (Bash by substring match on the command, which is deliberately
  strict).
- **Git checkpoint**: one commit before the first file edit of a session
  (`git add -A && git commit`). Revert is implemented as `git revert
  --no-commit <checkpoint>..HEAD` after snapshotting uncommitted changes, so
  history is preserved and nothing is ever discarded. The `.gitignore` written
  by "enable change tracking" excludes secrets, databases, logs and the auth
  store. Git identity is set per command (`-c user.name=...`) and
  `safe.directory=*` handles the uid mismatch between the add-on and HA.
- **Audit log** at `/data/audit.log`: JSON lines with timestamp, session,
  tool, redacted args (secret-looking keys replaced, strings truncated to 400
  chars) and outcome (`ok`, `error`, `denied`, `blocked`).

## Open questions

- Whether the Supervisor honours `path: /config` on `homeassistant_config` on
  every supported Supervisor version. The docs list `path` as optional; the
  fallback is to drop `path` and set `configDir` to `/homeassistant`.
- Whether HA's ingress passes the `X-Ingress-Path` header on WebSocket
  upgrades. The UI does not depend on it (relative URLs only).
- The Agent SDK's `PostToolUseFailure` hook input shape for the error field
  was not documented; the audit hook stores `String(error)` defensively.

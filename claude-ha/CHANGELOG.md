# Changelog

## 0.1.12

- Plan mode works again. Claude saved its plan into the add-on's private data
  folder, which the add-on blocks, so every plan was refused. Plans are now
  saved in `.claude/plans/` in your configuration folder, and that folder is
  left out of the add-on's git checkpoints.

## 0.1.11

- Fix the usage limits refresh button doing nothing. It asked the Agent SDK's
  usage endpoint, which `claude setup-token` tokens are not allowed to read
  (they only have the inference scope), and which took 30 seconds to say so.
  Refresh now sends a one-token request and reads the usage from the
  response's rate-limit headers, like Claude Code's own quota check. If that
  fails, the error is shown instead of nothing happening.
- Error messages appear as proper toasts again; their stylesheet was not
  loaded, so they rendered as unstyled text.

## 0.1.10

- See your Claude plan's usage limits in the sidebar: how much of the current
  5-hour session and the weekly limits (overall and per model) is used, and
  when each resets, like Claude Code's `/usage`. The numbers update after each
  reply and on the refresh button, survive a restart, and turn amber then red
  as a limit gets close; a banner warns when you are about to hit one.
  Subscription logins only; hidden for API keys.

## 0.1.9

- Send messages while Claude is working. The message box used to lock until
  the reply finished; now a message sent mid-turn is picked up at Claude's
  next step (for example, between two tool calls) or runs right after the
  current reply. The chat stays marked as busy until every queued message has
  been handled. Turn the new `send_while_working` option off to keep the old
  behaviour.
- The version in the sidebar footer is the add-on's own version. It showed
  v0.1.0, the server package's version, which nothing bumps at release.

## 0.1.8

- Update the Claude Agent SDK to 0.3.281, which bundles Claude Code 2.1.281.
  This adds Claude Opus 5.5 (`claude-opus-5-5`) to the model picker; it is
  also what the `opus` alias now resolves to. The previous SDK (0.3.263)
  predates Opus 5.5, so it could not be selected.

## 0.1.7

- Attach screenshots and files to a message: paste a screenshot straight into
  the message box, drag and drop files onto it, or pick them with the paperclip
  button. Images (PNG, JPEG, GIF, WebP) and PDFs are shown to Claude directly;
  text files (YAML, logs, JSON, ...) are included as text. Attachments appear
  as thumbnails in the chat and are removed when the chat is deleted.
- Validate YAML before Home Assistant's config check: the image now ships
  Python, PyYAML and yamllint, plus an `ha-yaml-check` command that parses
  files like Home Assistant does (understands `!include`, `!include_dir_*`,
  `!secret`, `!env_var`, `!input`) and reports syntax errors, duplicate keys,
  missing include targets and unknown `!secret` names with file:line:column,
  without ever printing secret values. `--lint` adds yamllint style checks
  with HA-friendly defaults. Claude runs it after every YAML edit; plain
  validator runs inside /config are auto-approved when
  `auto_approve_readonly_tools` is on.

## 0.1.6

- Syntax-highlight YAML (and JSON/INI/etc.) in the file-edit diff view, on top of
  the red/green diff.
- Fix the aarch64 image build: runtime dependencies are now cross-installed on
  the build host instead of under QEMU emulation, which was crashing (SIGILL).

## 0.1.5

- Render Claude's replies as Markdown, with syntax-highlighted code blocks.
- Add an add-on icon and logo.
- Add in-app documentation (Documentation tab).
- Install prebuilt multi-arch images from ghcr.io instead of building on-device.

## 0.1.4

- Show file changes as a red/green diff. Edit, Write and MultiEdit now render a
  GitHub-style diff (with +/- line counts) instead of a raw JSON tool card.

## 0.1.3

- Show Claude's reasoning: a summary of the model's thinking now streams into a
  "Thinking" panel above each answer (auto-expands while it thinks, then stays
  collapsible). Only the summary is shown, never the raw chain of thought, and
  the model still decides when deeper reasoning is warranted.

## 0.1.2

- Security: the model's subprocess no longer receives the Supervisor token, and
  the add-on's private `/data` directory (credentials, sessions, audit log) plus
  credential environment variables are blocked from all tools. This prevents a
  shell command from reading tokens and calling the Supervisor API directly,
  bypassing the tool guards.
- Add a GitHub Actions workflow that builds and publishes multi-arch images, so
  installs can use a prebuilt image instead of building on-device.

## 0.1.1

- Fix: the Home Assistant tools (states, services, config check, reload, …) are
  now actually available to Claude. A tool-schema issue previously caused the
  `ha` MCP server to expose no tools, so Claude reported it couldn't query your
  entities.
- Tools now load directly (no tool-search step) and are referenced by their real
  names, so Claude uses them without prompting to "reconnect".
- A fresh tool connection is created per chat, fixing intermittent failures in
  the second and later chats of a session.

## 0.1.0

- Initial release: Claude chat panel in the Home Assistant sidebar.
- Read, edit and validate your configuration with the standard Claude Code file
  tools plus Home Assistant tools (states, services, areas/devices, logs,
  templates, config check, reload, guarded restart).
- Subscription sign-in with `claude setup-token`, or a static API key.
- Per-chat permission modes and model selection, interactive multiple-choice
  questions, secrets guard, config check before reload/restart, git checkpoint
  and audit log.

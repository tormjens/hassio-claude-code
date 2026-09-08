# Changelog

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

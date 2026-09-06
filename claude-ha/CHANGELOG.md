# Changelog

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

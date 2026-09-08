# Claude for Home Assistant

Chat with Claude directly inside Home Assistant to read, explain, write and
validate your configuration. Claude works on your real `/config` directory with
the same file tools as Claude Code, plus a set of Home Assistant tools — and it
asks before it changes anything, refuses to read your secrets, and takes a git
checkpoint before its first edit so you can roll back.

## Requirements

- Home Assistant OS or Supervised (this runs as a Supervisor add-on).
- One of:
  - A **Claude subscription** (Pro, Max, Team or Enterprise) — recommended.
  - An **Anthropic API key** (usage-based billing).

## Authentication

Set `auth_method` in the **Configuration** tab.

### Subscription (recommended)

1. On any computer with [Claude Code](https://code.claude.com/) installed and
   signed in to your Claude account, run:

   ```bash
   claude setup-token
   ```

2. Approve the browser login. It prints a token valid for about a year.
3. Set `auth_method: oauth`, paste the token into `oauth_token`, and restart the
   add-on.

### API key

Set `auth_method: api_key` and paste your key into `anthropic_api_key`, then
restart. Usage is billed to your Anthropic account.

## Using it

Open **Claude** from the sidebar and type a request, for example:

- "List all my lights and which ones are on."
- "Create an automation that turns off all lights at 23:00 and validate the config."
- "Why isn't my `binary_sensor.front_door` automation firing? Check the logs."

**Permission modes** (bottom-left of the composer):

- **Ask every time** — Claude asks before every write, service call, reload or restart.
- **Auto-approve edits** — file edits run without asking; Home Assistant writes still ask.
- **Plan only** — Claude plans without changing anything.

You can also pick a **model** per chat, and file changes are shown as a
red/green **diff** before you approve them. When Claude needs to choose between
options it asks with a short multiple-choice card instead of a wall of text, and
a summary of its **reasoning** streams into a collapsible "Thinking" panel.

## Configuration options

| Option                        | Default  | Description                                                                                     |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `auth_method`                 | `oauth`  | `oauth` (subscription token) or `api_key`.                                                       |
| `oauth_token`                 | —        | Token from `claude setup-token` (when `auth_method: oauth`).                                     |
| `anthropic_api_key`           | —        | Anthropic API key (when `auth_method: api_key`).                                                |
| `model`                       | —        | Optional default model id/alias (e.g. `opus`, `sonnet`). Switchable per chat.                    |
| `anthropic_base_url`          | —        | Optional. Route requests through an Anthropic-compatible gateway.                               |
| `log_level`                   | `info`   | `debug`, `info`, `warning`, `error`.                                                            |
| `auto_approve_readonly_tools` | `true`   | Run read-only Home Assistant tools (states, services, areas, logs, templates) without a prompt. |

## Safety

- **Secrets guard** — `secrets.yaml`, the auth store, the add-on's own `/data`
  (which holds your token) and credential environment variables are blocked from
  every tool. Claude can see secret *names* but never their values.
- **Config check** — `Reload` and `Restart Core` run a configuration check first
  and refuse if it fails.
- **Git checkpoint** — before its first edit in a session, the add-on commits a
  checkpoint of `/config`, and you can revert it from the header.
- **Audit log** — every tool call is recorded (secrets redacted) under `/data`.
- The Supervisor token is never exposed to the model's shell.

## Troubleshooting

- **"Not signed in" banner** — no credential configured. Follow
  [Authentication](#authentication) and restart the add-on.
- **A tool call fails** — check the add-on **Log**; set `log_level: debug` for
  detail. The startup log shows `mcp=ha:connected` when the Home Assistant tools
  are ready.
- **Nothing happens on send** — usually a missing or expired token. Re-run
  `claude setup-token` and update the option.

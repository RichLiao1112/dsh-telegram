---
description: "Telegram Bot API adapter for configured live DSH agents."
kind: "package-reference"
---

# @richliao1112/dsh-telegram

English | [中文](README.zh.md)

This repository is the source of truth for the plugin. A DSH deployment consumes
it directly: point the profile dependency at this checkout (or install from the
Git URL) and mount the row below.

## Install

The plugin runs inside a DeepSeek Harness `dsh` deployment. Add it to a profile and mount one row in that profile's `cordis.patch.yml`:

```sh
cd ~/.dsh/profiles/web
pnpm add github:RichLiao1112/dsh-telegram
```

```yaml
- insert:
    - id: telegram
      name: '@richliao1112/dsh-telegram'
      config:
        token: !!js process.env.DSH_TELEGRAM_BOT_TOKEN
        chats:
          - chatId: '123456789'
            workspacePath: !!js process.cwd()
            agentPreset: standard
```

Keep the bot token in an environment variable or private configuration. The profile row is required because the package ships no `dsh.bundle` metadata.

## Development

```sh
pnpm install     # install the published @deepseek-ai/dsh-* peers
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # tsc emits lib/types, tsdown bundles lib/index.js
```

The published `lib/index.js` is the single bundle a DSH profile row imports.

## Summary

`dsh-telegram` connects explicit private Telegram chats to DSH agents. It creates a configured root agent on first use when needed, switches among live root sessions, forwards chat text as normal follow-up messages, sends committed assistant text back to the mapped chat, and presents approval and `ask_user_question` interactions through Telegram controls.

## Composition

Install the package in a profile, then add this row to its `cordis.patch.yml`. Keep the bot token out of committed files.

```yaml
- insert:
    - id: telegram
      name: '@richliao1112/dsh-telegram'
      config:
        token: !!js process.env.DSH_TELEGRAM_BOT_TOKEN
        chats:
          - chatId: '123456789'
            workspacePath: !!js process.cwd()
            agentPreset: standard
            # Optional: start on an already-live root session.
            # agentId: 'your-live-session-id'
```

Without `agentId`, the first ordinary chat message creates and selects a root agent using `workspacePath` and `agentPreset`. `/new` creates another session, `/sessions` lists live root sessions, and `/use <sessionId>` selects one. The Host registers persistent `telegram` settings (`token`, `chatId`, `workspacePath`, and `agentPreset`); saved values override the configured token and first route at the next process start. The plugin accepts only configured `private` chat ids; it ignores groups, channels, and every unknown sender.

## Interaction

- Plain text starts an ordinary DSH follow-up turn.
- `/new` creates a session; `/sessions` opens a card of the live roots that marks the selected one and switches on a tap, with a **＋ session** button; `/use <sessionId>` remains the typed equivalent; `/status` reports the selected session and carries the **sessions / model / new** quick actions; `/cancel` aborts the running command and requests turn cancellation.
- `/help`, `/start`, and `/commands` list every command the selected session resolves, including host-registered commands. Unknown slash commands are rejected before reaching the model.
- The adapter publishes its own chat commands through `setMyCommands`, so Telegram clients show them in the native `/` menu beside the message box. That menu is bot-wide and carries only the adapter's commands; host-registered commands stay in `/help`, because their set follows the selected session's scope.
- Every registered slash command that needs no attachment input runs through the Host command registry, so `/compact`, `/goal`, `/plan`, `/permission`, `/feedback`, and `/export` behave as they do in the Web composer.
- `/model` opens a card that steps provider → model → reasoning effort and applies the tapped selection through the same validated Session operation the Web picker uses; the typed form `/model <provider> <model> [reasoning-effort]` stays available, and a host-registered `model` command wins over the fallback. `/rename <title>` pins the session title through the same operation the Web title editor uses.
- `/export` sends the produced ZIP archive to the chat as a document, up to Telegram's 50 MB upload ceiling, instead of only reporting a download intent.
- Photos, documents, audio, video, voice notes, and stickers are accepted. A message's media becomes image or file content on the next turn; a caption that starts with a slash instead runs that command with the media attached, and a command that declares no attachment input rejects it.
- Model Markdown renders as Telegram's supported HTML subset (bold, italic, strikethrough, links, inline and fenced code, headings, lists, quotes); a rejected parse falls back to plain text, and a fenced block is never cut across messages.
- One merged message per turn lists tool activity as `Bash · <description>` / `Read · <path>` lines driven by each tool's own `presentCall` intent, settling in place; the interactive `ask_user_question` prompt is excluded because its own prompt is the UI. A restart resumes the chat's persisted session instead of starting a new one; only `/new` starts another.
- The chat shows Telegram's typing indicator from `turn/start` to `turn/end`, refreshed below its five-second expiry and paused while an approval or question waits on the human.
- Assistant text is forwarded after its durable `assistant/message` commit. While a turn runs, the reply streams into one message that the committed text then replaces, and each tool call appears as its own line that its result edits in place.
- Approval prompts have **Allow once** and **Reject** buttons. Telegram delivery failure or cancellation fails closed.
- `ask_user_question` asks every question in order and settles all answers together. Options become buttons — including the plan-mode review — a `multiSelect` question toggles options until **Done**, and without options the next text reply becomes the custom answer. `/answer <text>` answers a pending question with text that itself starts with a slash.

## Configuration

Beyond `token` and `chats`, the row accepts three visibility switches:

| field | default | effect |
|---|---|---|
| `typingIndicator` | `true` | Telegram's typing state from `turn/start` to `turn/end` |
| `streamReplies` | `true` | the reply streams into one message the committed text then replaces |
| `toolProgress` | `false` | one merged tool-activity message per turn |

## Settings page

The package ships a browser half alongside the Host plugin. When the profile row is
mounted, the Web **Settings → Plugins → Plugin configuration** page gains a Telegram
card that edits the same `telegram` namespace, staged behind Save. The card only
appears on a loopback page, because DSH exposes settings persistence to loopback
clients only.

## Known Limitations and Deferred Work

- The adapter uses long polling and stores only process-local pending interactions; restart cancels them.
- Selection is process-local. Restarting loses the selected session; the adapter creates a new session on the next ordinary message unless `agentId` names a live session.
- The Bot API serves downloads up to 20 MB, so larger media is refused before any download starts. Reasoning text and tool result content are not rendered; only assistant message text is streamed.
- `toolProgress`, `streamReplies`, and `typingIndicator` trade message volume for visibility and can be turned off per deployment.
- A command result that identifies richer output reports the session event that owns it; Telegram does not render that output.

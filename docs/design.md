# Design notes: the Telegram agent channel

## Problem

DSH has browser interaction adapters, but an operator away from the Web GUI cannot send a follow-up, receive the completed answer, or resolve an approval through Telegram. Exposing the local Web control plane to a bot would widen its trust boundary and make a chat identity implicit.

## Decision

`@richliao1112/dsh-telegram` is a Host-only Bot API adapter that accepts long-poll updates only from configured private chat ids. A route may name an already-live root agent, or declare a workspace and preset for creation on first message. `/new` creates a root agent, `/sessions` lists each live root's title, id, and state, `/use <sessionId>` selects one, and inbound text becomes the selected agent's normal follow-up message. Durable assistant text is delivered to the mapped chat; `/status`, `/cancel`, and `/help` are transport-local controls.

Interactive cards carry the two choices that are awkward to type: `/sessions` renders the live roots as a tap-to-switch card (marking the selected one and offering a new session), and a bare `/model` renders provider → model → reasoning effort, because Telegram callbacks cap their payload at 64 bytes and position payloads stay inside that. A card selection re-enters the same registered command line (`/model <provider> <model> [effort]`), so the session log records it exactly as the typed form; a host-registered command of that name is never shadowed. `/status` carries the sessions/model/new quick actions.

Every other slash command resolves through `ctx.commands`, so a chat runs the same registered commands the Web composer does, whether they come from the Host registry or from the agent's own scope. `/model` and `/rename` are text equivalents of the Web pickers: the adapter registers each into the selected agent's scope only when that name is unregistered there, and both call the same validated Session operations (`selectModel`, `rename`) instead of writing selection or title state directly. `/export` runs the registered command and then uploads the produced ZIP through `sendDocument`, bounded by the Bot API's document ceiling, because the Web command only records a download intent. Live `deliverables/presented` events are also consumed: small videos use `sendVideo`, other files use `sendDocument`, and files above the Bot API ceiling are split into ordered 49 MB document parts.

Telegram's own command menu beside the message box lists the adapter's commands: `setMyCommands` publishes the transport-local set from `src/command-menu.ts` once at startup. Host-registry commands stay out of that menu, because one bot-wide list cannot follow the selected agent's scope; `/help` remains their per-session listing. A rejected publication is logged and leaves every command typed-usable.

The plugin participates in the existing scoped `approval/request` and `user-questions/request` waterfalls. Telegram buttons answer a pending request only when they arrive from the route that owns the requesting agent. Cancellation and failed outbound delivery settle approvals fail-closed. The adapter holds no bot token, session, or pending interaction in durable DSH state.

Inbound media is admitted through the same Host attachment path the Web composer uses: photos and supported image documents become durable image references, every other file becomes a durable file reference the model opens by path, and a caption beginning with `/` instead runs that command with the media as registry submissions — encoded images directly, files as Agent-scoped upload receipts from `fileUploads`. A `questions` array is asked one message at a time and settles all answers together; a `multiSelect` question carries a toggle keyboard that the callback edits in place and confirms with **Done**, so multi-question and multi-select requests no longer fall back to another channel.

Tool activity is opt-in (`toolProgress`, default false) and even then is one merged message per turn rather than a message per call: each `tool/call` contributes a line titled from the tool's own `presentCall` intent (`Bash · <description>`, `Read · <path>`) and each `tool/result` settles that line in place. The `ask_user_question` prompt stays out of the board because its own prompt is the interactive UI, and that prompt now lists every option with its description beside the buttons that select labels.

Model output renders: Markdown is converted to Telegram's supported HTML subset with a plain-text fallback when Telegram rejects the entities, and fenced blocks are never split across messages. The chat's selected session is persisted in the `telegram` settings section, so a restart resumes it through `agents.resume` instead of starting a new conversation; only `/new` starts one.

The chat also carries Telegram's own liveness signal: `turn/start` opens the typing indicator, `turn/end` retires it, refreshes stay below the five-second action expiry, and an approval or question pauses it while the human is the blocker. Chat visibility of a running turn is the same event stream the Web projects. `agent/assistant-stream` text accumulates into a single message that the committed `assistant/message` replaces instead of duplicating. `toolProgress`, `streamReplies`, `typingIndicator`, and `streamEditIntervalSeconds` are deployment configuration because both the message volume and the Bot API edit rate vary by deployment.

## Alternatives considered

- **Creating or selecting sessions from Telegram.** The adapter would need an authenticated session-management protocol and durable chat-to-session ownership. Explicit routes keep the first integration limited to an existing trusted DSH session.
- **Treating all bot users as authorized.** Telegram chat ids are an authentication input, not presentation metadata. The configured allowlist denies unknown private chats and all groups.
- **Routing through the Web API.** The Host plugin can invoke the existing agent and interaction capabilities directly, avoiding another externally reachable API and browser dependency.
- **Reimplementing the Web pickers as model prompts.** `/model` and `/rename` could have been described to the model in chat text, which would make selection nondeterministic and bypass Session validation. Registering real command definitions keeps the Web and chat write paths identical.
- **Registering the fallbacks globally.** A global `model` or `rename` registration would collide with a deployment's own command and fail the plugin load; per-agent registration lets the host definition win.

The card face lives in this repository's browser half (`src/client/`), not in the
harness client packages: the plugin configuration section keys each card by the
settings namespace it edits, which is the extension point a plugin distributed
outside the harness repository uses. The browser half builds as a
`window.__ModuleLoader__.load` closure factory over the shell's platform modules
(`lib/client.js`), declared through `dsh.client` and the `./client` export.

## Consequences

A deployment adds the plugin to its own profile patch and keeps the bot token in an environment expression or private configuration. Restarting the process cancels outstanding prompts; the plugin does not replay Bot API updates or persist a session mapping. The inbound Bot API download ceiling remains 20 MB. Outbound files use the cloud Bot API's 50 MB per-file ceiling and split larger `present` deliveries into 49 MB parts; reasoning text and tool result content are not rendered, and a command result that names richer output reports the session event that owns it.

## Testing

Focused typechecking and a package build verify the plugin's Host composition. `tests/service-commands.host.spec.ts` drives the real Bot API poll loop with scripted updates and asserts session-title listings, registry command execution and reply, unknown-command rejection, `/model` fallback installation and selection, host-command precedence, `/export` document delivery, photo and document intake, the oversize refusal, ordered multi-question answers, multi-select toggling, custom text answers, the merged tool board and its titles, resumed-session continuation, Markdown rendering, the typing indicator's refresh and retirement, streamed reply replacement, the session and model card steps, one-tap selection through the registered command, an expired-card report, the published command menu with its Bot API name and description constraints, and chat survival when the Bot API rejects that publication. `tests/model-command.host.spec.ts` and `tests/export-command.spec.ts` cover the picker and archive units. A live bot token and configured private chat remain operator acceptance testing because Telegram's Bot API is external.

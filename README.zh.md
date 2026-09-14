---
description: "为已配置的存活 DSH agent 提供 Telegram Bot API 适配。"
kind: "package-reference"
---

# @deepseek-ai/dsh-telegram

[English](README.md) | 中文

## 安装

插件运行在 DeepSeek Harness（`dsh`）部署内。把它加入某个 profile，并在该 profile 的 `cordis.patch.yml` 中挂载一行：

```sh
cd ~/.dsh/profiles/web
pnpm add github:RichLiao1112/dsh-telegram
```

```yaml
- insert:
    - id: telegram
      name: '@deepseek-ai/dsh-telegram'
      config:
        token: !!js process.env.DSH_TELEGRAM_BOT_TOKEN
        chats:
          - chatId: '123456789'
            workspacePath: !!js process.cwd()
            agentPreset: standard
```

把 bot token 放在环境变量或私有配置中。由于包不提供 `dsh.bundle` 元数据，profile 中的这一行是必需的。

## 开发

```sh
pnpm install     # 安装已发布的 @deepseek-ai/dsh-* peer 依赖
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # tsc 产出 lib/types，tsdown 打包 lib/index.js
```

发布产物 `lib/index.js` 就是 profile 行所导入的单一 bundle。

## 摘要

`dsh-telegram` 将明确配置的 Telegram 私聊连接到 DSH agent。需要时它会在首次使用时创建配置的根 agent，可以在存活根会话间切换，把聊天文本转发为普通 follow-up 消息，将完成的 assistant 文本发回映射聊天，并通过 Telegram 控件处理审批和 `ask_user_question` 交互。

## 组合

将包安装到 profile 后，在其 `cordis.patch.yml` 添加此行。不要将 bot token 提交到仓库。

```yaml
- insert:
    - id: telegram
      name: '@deepseek-ai/dsh-telegram'
      config:
        token: !!js process.env.DSH_TELEGRAM_BOT_TOKEN
        chats:
          - chatId: '123456789'
            workspacePath: !!js process.cwd()
            agentPreset: standard
            # Optional: start on an already-live root session.
            # agentId: 'your-live-session-id'
```

省略 `agentId` 时，第一条普通聊天消息会使用 `workspacePath` 和 `agentPreset` 创建并选择根 agent。`/new` 创建另一个会话，`/sessions` 列出存活根会话，`/use <sessionId>` 选择一个会话。Host 注册持久化的 `telegram` 设置（`token`、`chatId`、`workspacePath`、`agentPreset`）；已保存的值在下次进程启动时覆盖配置的 token 和第一条路由。插件只接受配置的 `private` chat id；它忽略群聊、频道和未知发送者。

## 交互

- 普通文本发起 DSH follow-up turn。
- `/new` 创建会话；`/sessions` 打开存活根会话卡片，标记当前选中项、点按即切换，并带 **＋ 新会话** 按钮；`/use <sessionId>` 保留为等价的手写形式；`/status` 显示所选会话并带 **会话 / 模型 / 新建** 快捷按钮；`/cancel` 中止正在运行的命令并请求取消 turn。
- `/help`、`/start` 和 `/commands` 列出所选会话解析到的全部命令，包括 Host 注册的命令。未知斜杠命令在到达模型前被拒绝。
- 适配器通过 `setMyCommands` 发布自身的聊天命令，Telegram 客户端会在输入框旁的「/」原生命中菜单中列出它们。该菜单是 bot 级菜单，只包含适配器自身的命令；Host 注册的命令仍只在 `/help` 中列出，因为它们的集合随所选会话的 scope 变化。
- 每个不需要附件输入的已注册斜杠命令都通过 Host 命令注册表执行，因此 `/compact`、`/goal`、`/plan`、`/permission`、`/feedback` 和 `/export` 的行为与 Web 输入框一致。
- `/model` 打开卡片，按 provider → 模型 → 推理强度逐步点选，并通过 Web 选择器使用的同一套已校验会话操作应用选择；手写形式 `/model <provider> <model> [reasoning-effort]` 继续可用，Host 已注册的 `model` 命令优先于回退实现。`/rename <title>` 通过 Web 标题编辑器使用的同一操作固定会话标题。
- `/export` 将生成的 ZIP 归档作为文档发送到聊天，上限为 Telegram 的 50 MB 上传限制，而不只是报告下载意图。
- 接受照片、文档、音频、视频、语音和贴纸。消息中的媒体会成为下一轮的图像或文件内容；以斜杠开头的说明文字则改为携带这些媒体运行该命令，而未声明附件输入的命令会拒绝它。
- 模型输出的 Markdown 会转换为 Telegram 支持的 HTML 子集（粗体、斜体、删除线、链接、行内与围栏代码、标题、列表、引用）；解析被拒绝时回退为纯文本，围栏代码块不会被跨消息切断。
- 每个回合只有一条消息汇总工具活动，按各工具自己的 `presentCall` 意图显示为 `Bash · <描述>` / `Read · <路径>`，并就地结算；交互式的 `ask_user_question` 不进入该消息，因为它自己的提示就是界面。重启会恢复该聊天已持久化的会话而不是新建；只有 `/new` 才会另开会话。
- 从 `turn/start` 到 `turn/end`，聊天中显示 Telegram 的“正在输入”状态，刷新间隔低于其五秒失效时间；等待人工审批或回答问题时暂停显示。
- assistant 文本在持久化 `assistant/message` 后转发。回合进行中，回复会流式写入同一条消息，随后由已提交文本替换；每次工具调用显示为独立一行，并在结果到达时就地改写。
- 审批提示提供 **Allow once** 与 **Reject** 按钮；发送失败或取消会拒绝请求。
- `ask_user_question` 按顺序询问每个问题，并一次性提交全部回答。选项显示为按钮（包括 plan 模式审查）；`multiSelect` 问题通过切换选项直到 **Done**；无选项时下一条文本是自定义答案。`/answer <text>` 可用以斜杠开头的文本回答待处理问题。

## 已知限制与延后工作

- 适配器使用长轮询，待处理交互仅存在于进程内；重启会取消它们。
- 所选会话仅保留在进程内。重启会丢失选择；除非 `agentId` 指向存活会话，否则下一条普通消息会创建新会话。
- Bot API 下载上限为 20 MB，更大的媒体会在开始下载前被拒绝。推理文本和工具结果内容不渲染；只有 assistant 消息文本会流式显示。
- `toolProgress`、`streamReplies` 与 `typingIndicator` 以消息量为代价换取可见性，可按部署关闭。
- 标识了更丰富输出的命令结果会报告拥有该输出的会话事件；Telegram 不渲染该输出。

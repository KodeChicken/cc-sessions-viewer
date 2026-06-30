# 应用内聊天框（in-app chat Q&A）设计方案

> 关联 issue：[#31](https://github.com/jerrywu001/cc-sessions-viewer/issues/31)
> ——「咱们可以加一个类似 VSCode Codex 插件中的聊天框的形式吗，好想用聊天框来进行问答」
>
> 状态：**Phase 1 已落地**（Claude stream-json MVP）+ **§9 双进程模型地基已落地** +
> **Codex GUI chat 已接通**（exec MVP）。后端 `agent_chat.rs` 驱动（两条进程模型路径）+
> `chatSessions.ts` / `ChatComposer.vue` + ChatView live 模式 + 三个入口 + 四语言文案。
> 协议已对真实 `claude`(2.1.187) / `codex`(0.142.2) CLI 验证通过，并完成一轮加固（live 时间戳、
> 进入/聊天中自动贴底滚动、聊天态下侧栏/顶栏导航、去掉 composer 分割线）。
> **已完成对照 IDE 插件的架构分析（§9.9）**：Claude 富功能在同一根 stream-json 管子里
> （`control_request` + `--include-partial-messages`），Codex 富功能在另一个引擎（app-server）。
> **决策：暂不上 app-server**（太重），Claude 走 control_request、Codex 走 per-turn flag。
> **§10 Composer 工具条（Phase 1.5）已落地**：§10.0 restart-with-resume、§10.1 slash 动态发现、
> §10.2 模型切换、§10.3 effort 切换、§10.4 权限三档、§10.5 上下文窗口/限额、§10.6 token 流式、
> §10.7 底栏排版 —— 全部完成（后端 trait 打通 + 驱动 + 前端底栏 picker/指示 + 4 语言 + 单测）。
> Claude 实跑验证底栏 picker（dev 实例）。
> **唯一刻意留到 Phase 2**：§10.4 的 `can_use_tool` 内联审批（+ `set_model`/`set_permission_mode`
> 活切，免 restart）—— 深水区，需先探 control 报文形状；当前用 §10.0 重启 + per-turn flag 顶上。
> Gemini 待认证后再接（见 §9）。
> 选型：**B — headless stream-json**（程序化驱动，主方案）

---

## 1. 目标与范围

让用户在 app 里用一个**干净的聊天输入框**对 agent 发问、读结构化回答，而不是切到
Terminal.app、也不是对着原始 TUI 敲字。

- **In scope**：输入框 → agent 处理 → ChatView 流式渲染回答；运行中状态指示；
  内联工具审批；复用现有 Claude / Codex / Gemini CLI（**不重实现 agent、不直连 API、不碰 key**）。
- **Out of scope（本期）**：自己实现 agent loop / 自管模型 API key；Windows 优先级靠后（先 macOS）。

## 2. 我们复用什么、新增什么

选 B 后，**渲染与持久化全复用，进程驱动层新增**：

| 维度 | 复用现有 | 说明 |
|---|---|---|
| **渲染** | ✅ `ChatView` + `DiffBlock`/`ToolResult`/图片 + 设计系统 + i18n | stream-json 的 `message` 对象与 JSONL 记录**同形**，可直接复用 `agents/claude.rs` 的 record→`Block` 解析逻辑 |
| **数据模型** | ✅ `Msg` / `Block`（`types.rs` / `types.ts`） | 流式事件解析成同一套 `Msg[]` 喂给 ChatView |
| **持久化/回看** | ✅ CLI 仍把会话写进 `~/.claude/projects/...jsonl` | 聊完的会话照常出现在查看器里，无需额外同步 |
| **进程驱动** | ❌ 新增 | 不走 PTI——改用**管道子进程**（stdin/stdout pipe），逐行读 JSON 事件 |
| **回答结束判定** | ❌ 新增（更准） | 直接读 stream-json 的 `result` / `message_stop` 事件，不再靠 JSONL 启发式 |
| **工具审批** | ❌ 新增 | 经 `--permission-prompt-tool` 路由到 app 内联 Approve/Deny |

> 注：B **不需要 PTI**。stream-json 没有 TUI 控制字符，用 `Stdio::piped()` 的纯管道子进程
> 更干净（不必处理 ANSI/光标）。现有 `pty.rs` 保持原样服务「TUI resume / shell」两个老入口。

## 3. 选型：headless stream-json（主）vs PTY 叠加层（兜底）

| 方案 | 做法 | 取舍 |
|---|---|---|
| **B. headless stream-json**（✅ 主方案） | 长驻 `claude -p --input-format stream-json --output-format stream-json --verbose`，stdin 持续喂 JSON 用户消息，stdout 逐行读事件直接渲染 | 协议干净、流式 delta、`result` 事件精确判定回答结束、审批可程序化内联；代价是要写一套管道子进程驱动 + 每个 agent 协议适配 |
| **A. PTY 叠加层**（兜底/逃生） | 复用现有 PTY，把 prompt 用括号粘贴注入 TUI stdin | 改动小但「往 TUI 注入文本 + 半终端审批」体验糙；保留给**没有可用 headless 模式的 agent** 或调试 |

**结论**：以 B 为主线落地；A 作为对个别 agent 的降级通道保留（不主推）。

## 4. 架构

```
┌─ ChatTab (新: 程序化聊天会话) ───────────────────────────┐
│  ┌────────────────────────────────────────────────┐    │
│  │  ChatView  ← 由 stream-json 事件累积的 Msg[]      │    │  ← 复用渲染
│  │  (结构化气泡: 文本流式 delta / 工具调用 / diff)   │    │
│  │  ├─ 工具审批卡片: [Approve] [Deny]  (Phase 2)    │    │  ← 内联审批
│  └────────────────────────────────────────────────┘    │
│  ┌─ ChatComposer (新) ──────────────────────────────┐   │
│  │  [多行输入框]            turnState→ ⏳/▶  [发送]   │   │
│  └────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
        │ 发送 {"type":"user",...}          ▲ 解析 + 渲染
        ▼  (写 stdin)                       │  agent-chat://event
   ┌──────────────────────────────────────────────────────────┐
   │ agent_chat.rs (新): 管道子进程                            │
   │   claude -p --input-format stream-json                    │
   │          --output-format stream-json --verbose           │
   │          [--resume <id> | --session-id <uuid>]            │
   │          [--permission-prompt-tool mcp__approval__prompt] │
   │   stdin ← 用户消息 JSON   stdout → 逐行事件 JSON          │
   └──────────────────────────────────────────────────────────┘
        │ 工具审批请求                       ▲ Approve/Deny
        ▼  agent-chat://permission           │  agent_chat_permission_reply
       (经 app 内置 MCP approval tool)
```

**后端**（新增一个子系统，类比 `pty.rs` 的结构）：

- 新 `src-tauri/src/agent_chat.rs`：
  - `agent_chat_start(agent, cwd, session_id?, permission_mode) -> chat_id`：用
    `Stdio::piped()` 起子进程；调用方式由新的 per-agent 方法
    `SessionSource::chat_command()`（返回带 stream-json flags 的 `AgentCommand`）给出。
    起一个 reader 线程逐行读 stdout → **复用 `agents/<agent>.rs` 的解析**得到 `Msg/Block`
    → `emit("agent-chat://event", { chatId, msg })`；stderr 线程收诊断。
  - `agent_chat_send(chat_id, text)`：把 `{"type":"user","message":{...}}` 写进 stdin。
  - `agent_chat_interrupt(chat_id)` / `agent_chat_stop(chat_id)`：取消当前回答 / 结束进程。
  - 状态藏 `OnceLock<Mutex<HashMap<chat_id, ChatHandle>>>`（与 `pty.rs` 一致的形态）。
- 事件契约：
  - `agent-chat://event`   `{ chatId, msg }`        一条解析好的 `Msg`（含流式 delta）
  - `agent-chat://result`  `{ chatId, ok, usage }`  一轮回答结束（驱动 turn 门控）
  - `agent-chat://permission` `{ chatId, reqId, toolName, input }` 工具审批请求（Phase 2）
  - `agent-chat://exit`    `{ chatId, code }`        子进程退出

**审批**（Phase 2）：起一个 app 内置的极小 MCP server 暴露 `approval/prompt` 工具，
CLI 用 `--permission-prompt-tool mcp__approval__prompt` 把每次工具调用路由过来 →
后端 emit `agent-chat://permission` → 前端弹 Approve/Deny → `agent_chat_permission_reply`
把决定回灌给 MCP 工具。MVP 阶段可先用 `--permission-mode acceptEdits` 跳过审批。

**前端**：

- 新 `src/chatSessions.ts`（类比 `terminals.ts`）：管理活跃 chat 会话，listen
  `agent-chat://event` 累积成 reactive `Msg[]`；`result` 事件推进 turnState；`sendPrompt`。
- 新 `src/components/ChatComposer.vue`：多行输入 + 发送；turn 运行中禁用/转圈；
  （Phase 2）渲染内联审批卡片。
- `src/views/ChatView.vue`：渲染 live `Msg[]`（逻辑复用，只多一个 composer 槽位）。
- `src/App.vue`：chat 模式布局 + 串接下方「§4.1 三个 GUI 入口」。

## 4.1 入口与交互（三个 GUI 入口）

新 GUI 聊天（= 本文档的 stream-json 程序化对话）共有**三个入口**，全部与既有 **TUI**
入口并存、互不替代——它们只是把同一套 GUI chat（`chatSessions.ts` → `agent_chat_start`）
以不同方式拉起。

> **先厘清 TUI vs GUI**
> - **TUI** = 现有的窗口内终端 tab：把原始 CLI 的交互式终端整个嵌进来，由
>   `terminals.ts` + `pty.rs` 驱动（`openOrFocusTui`）。是「现有行为」。
> - **GUI** = 本文档新增的「干净聊天框」：管道子进程跑 stream-json，结构化气泡渲染
>   （`chatSessions.ts` + `agent_chat.rs` + `ChatComposer.vue`）。

### 入口 1 — 侧栏「+」新建会话下拉（[Image #1]）

`SessionsView.vue` / `components/TerminalStrip.vue` 现有的「+」下拉目前是两项
（`list.action.newAgentSession` / `list.action.newTerminal`）：

```
🤖 New agent session     →（TUI：openOrFocusTui）
>_ New terminal          → 裸 shell
```

改为**三项**，把「New agent session」拆成 TUI / GUI：

```
New Session (TUI)        → openOrFocusTui（现有行为，不变）
New Session (GUI)        → 新开一个 GUI chat 会话（本文档主线）
New Terminal             → 裸 shell（现有行为，不变）
```

i18n：`list.action.newAgentSession` 拆成 `list.action.newSessionTui` /
`list.action.newSessionGui`（4 语言同步）。

### 入口 2 — 会话详情顶栏「Open in window」按钮 → 下拉（[Image #2 / #3]）

会话详情顶栏现有的 ▷「Open in window」按钮（`views/ChatView.vue` 的 `IconPlay`，
`@click → $emit('resumeHere')`，单一动作 = TUI）升级为**带 caret 的下拉**：

```
▷ ▾  Open in window
 ├─ TUI   → resumeHere（现有 openOrFocusTui，不变）
 └─ GUI   → 在窗口内打开 GUI chat（带 --resume <id> 续聊本会话）
```

即「主图标 + ▾」结构：默认项保留 TUI 旧语义，新增项 GUI 走 chat 子系统。

### 入口 3 — 会话详情右下角浮标「切到 chat 模式」（[Image #3]）

在会话详情右下角（现有 scroll-to-top / scroll-to-bottom 一组 FAB，`views/ChatView.vue`
底部 `.chat-fabs`）**新增一颗浮动 icon 按钮**：点击把当前（只读）会话**就地切换到 GUI
chat 模式**——以该会话为上下文 `--resume`，把只读 ChatView 换成可输入的 live ChatView +
`ChatComposer`。tooltip：`chat.action.switchToChat`（4 语言）。

> 三个入口最终都汇聚到同一套 GUI chat（`agent_chat_start`），区别只在于
> **新开空会话**（入口 1 的 GUI）/ **从某会话续聊**（入口 2 的 GUI、入口 3）。
> TUI 路径（入口 1 的 TUI、入口 2 的 TUI）完全沿用 `terminals.ts` + `pty.rs`，不动。

## 4.2 ChatComposer 交互细节（参考 Claude 桌面客户端）

输入框与 live 渲染的视觉 / 交互对齐 **Claude 桌面客户端**（见 issue 附图）。

### 视觉样式

- **用户消息**：右对齐，浅灰圆角气泡（`--surface-hover`）。
- **assistant 一轮**：左对齐，行首一个 `✳` 星标 + 计时（如 `4s`）—— 运行时跳动，结束后固定为该轮耗时。
- **输入框**：大号圆角多行输入，占位 `Type / for commands`；右侧**内嵌**一颗按钮 —— 空闲 = 发送（↵），运行中 = 停止（□）。
- **底栏一行**：左 = 权限模式 chip（琥珀色，如 `acceptEdits` / `Bypass permissions`）+ `+` 附件按钮；右 = 模型名（如 `Opus 4.8`）+ 运行 spinner。

### 图片粘贴 / 附件（新增需求）

- 支持 **粘贴（⌘V）/ 拖拽 / `+` 选择** 图片 → 在输入框上方排一行**缩略图附件**，每个可单独移除。
- 发送时图片随文本一起作为 stream-json 用户消息的 `content` 数组发出，与 Claude API / JSONL 的 image block **同形**，后端原样透传进 stdin，无需特殊处理：

  ```json
  {"type":"user","message":{"role":"user","content":[
    {"type":"image","source":{"type":"base64","media_type":"image/png","data":"<b64>"}},
    {"type":"text","text":"看看这张图"}
  ]}}
  ```

- 回显：发出去的用户消息走现有 `Block{kind:"image"}` → `<img>`，与离线回看一致。

### Slash 指令列表（新增需求）

- 输入框**行首键入 `/`** 调出一个**可过滤的指令浮层**：列出可用 slash 命令 / skills，继续打字即时过滤，`↑/↓` 选择、`↵` 选中、`Esc` 关闭；每项 hover 显示说明 tooltip。
- 指令来源：MVP 先**内置一份常用命令**（`/clear`、`/compact`、`/help` …）；动态发现（探测 agent 实际支持的命令 / skills）留到 Phase 2/3。选中后把 `/<cmd>` 当普通用户消息发送，由 CLI 自己解释。
- 仅**行首**的 `/` 触发；正文里的路径 `/foo` 不弹浮层。

## 5. 关键难点与对策

1. **stream-json 事件 → `Block`** → 由于 stream-json 的 `message` 与 JSONL 同形，
   直接复用 `agents/claude.rs` 解析；流式 `assistant` delta 做增量合并（按 message id 累积，
   现有 turn 聚合逻辑已有同款去重）。
2. **回答结束判定** → 读 `result` 事件，精确、无需启发式（比 A 更稳）。
3. **工具审批** → `--permission-prompt-tool` + app 内置 MCP approval tool，内联 Approve/Deny。
   MVP 先用 `--permission-mode acceptEdits`，Phase 2 再上内联审批。
4. **多 agent 协议差异**（最大不确定性）→ Claude 的 stream-json 最成熟；Codex / Gemini 的
   非交互/JSON 模式形态不同，需**各写一个薄适配器**把各自事件归一成 `Block`。
   抽象点：新增 `SessionSource::chat_command()`；事件归一放各 agent 模块内（**不污染 trait 形状、
   不在 `lib.rs`/`trash.rs` 加分支**，符合 `CLAUDE.md` 约束）。没有可用 headless 模式的
   agent 退回方案 A。
5. **进程生命周期 / 并发** → 复用 `pty.rs` 的 `HashMap<id, Handle>` + reader/waiter 线程范式；
   切 tab 不杀进程；webview 刷新即全部结束（与 TUI tab 语义一致）。
6. **取消 / slash 命令** → `interrupt` 写控制消息或发信号中断当前轮；`/clear` 等作为用户消息透传。

## 6. 分期落地

- **Phase 1 — Claude stream-json MVP**：`agent_chat.rs`（start/send/stop + 事件流）、
  `chatSessions.ts`、`ChatComposer.vue`（Claude 客户端样式 + **图片粘贴/附件** + **行首 `/` 静态指令浮层**）、
  ChatView 渲染 live `Msg[]`、`result` 驱动 turn 门控。审批先用 `--permission-mode acceptEdits`。**只接 Claude**。
- **Phase 2 — 内联工具审批**：app 内置 MCP approval tool + `--permission-prompt-tool`，
  渲染 Approve/Deny 卡片，`agent_chat_permission_reply` 回灌。
- **Phase 3 — Codex / Gemini 适配器**：详见 **§9 多 agent chat 扩展规划**。要点：chat 逻辑
  各在自己的 agent 文件里（trait + 文件内分区），先补 §9.3 的 `chat_encode_input` 抽象漏洞，
  再逐个探针 + 实现；无 headless 模式者 `chat_command` 返回 `None` 优雅降级。

## 7. 改动清单（地图，本期不写码）

| 文件 | 改动 |
|---|---|
| `src-tauri/src/agent_chat.rs` | **新增**：管道子进程驱动 + JSON 行流 + 事件 emit + 审批回灌 |
| `src-tauri/src/agents/mod.rs` | `SessionSource` 加 `chat_command()`；各 agent 实现 stream-json 调用 + 事件归一 |
| `src-tauri/src/lib.rs` | 注册 `agent_chat_start/send/interrupt/stop/permission_reply` 到 `generate_handler!` |
| `src/chatSessions.ts` | **新增**：活跃 chat 会话状态、事件累积成 `Msg[]`、turn 门控、`sendPrompt` |
| `src/components/ChatComposer.vue` | **新增**：Claude 客户端样式多行输入 + 内嵌发送/停止 + turn 状态 + **图片粘贴/拖拽附件** + **行首 `/` 指令浮层** +（Phase 2）内联审批卡片 |
| `src/views/ChatView.vue` | 增加 live composer 槽位（渲染逻辑复用）；§4.1 入口 2 顶栏按钮改下拉、入口 3 右下角新增浮标 |
| `src/views/SessionsView.vue` / `src/components/TerminalStrip.vue` | §4.1 入口 1：「+」下拉拆成 TUI / GUI / Terminal 三项 |
| `src/App.vue` | chat 模式布局、串接 §4.1 三个 GUI 入口 |
| `src/api.ts` / `src/types.ts` | 新命令封装 + 事件 payload 类型 |
| `src/locales/*` | 4 语言新增 chat composer / 审批 / 状态文案 + §4.1 入口文案（`newSessionTui` / `newSessionGui` / `switchToChat`） |
| `test/` | 事件→`Block` 解析、turn 门控、composer 行为单测 |

> `pty.rs` / `terminals.ts`（TUI resume / shell）**保持原样**，与新 chat 子系统并存。

## 8. 风险 / 开放问题

- **最大风险：Codex / Gemini 的 headless 协议成熟度**。Claude 的 stream-json 稳；另两家
  可能形态欠缺或不稳——Phase 3 视实际能力，必要时对个别 agent 退回方案 A。
- **审批 UX**：`--permission-prompt-tool` 的事件粒度 / 超时 / 默认拒绝策略需打磨；MVP 先
  `acceptEdits` 控制风险面。
- **流式 delta 合并**：增量 assistant 文本的拼接与「最终一致」需要和现有 message-id 去重对齐。
- **进程资源**：长驻子进程的内存/僵尸回收（复用 `pty.rs` 的 waiter 线程范式）。
- chat tab 是否持久化（现有 TUI tab 刷新即丢，语义上 chat 可沿用）。

## 9. 多 agent chat 扩展规划（Codex / Gemini）

> 目标：Codex / Gemini 的 chat 协议逻辑**彼此独立、各在自己的文件里**，绝不混在一起；
> 共享的驱动 / 前端 / 入口**永不按 agent 分支**。下面是落地这一点的规划。

### 9.1 组织决策（已定）

chat 协议逻辑**继续挂在 `SessionSource` trait 上**，每个 agent 的实现作为该 agent 自有
文件里一个带标题的区块：

```
agents/claude.rs   // ===== GUI chat =====  (已实现)
agents/codex.rs    // ===== GUI chat =====  (待写)
agents/gemini.rs   // ===== GUI chat =====  (待写)
```

沿用本仓库既有的「**一 agent 一文件、一 trait**」约定，**不新增**第二套 `AgentChat`
trait / dispatcher。`agent_chat.rs`（驱动）与 `chatSessions.ts`（前端状态）只认
`ChatEvent` / `Msg`，永远零 agent 分支 —— 与 CLAUDE.md「不在 lib.rs/trash.rs 加 agent
match 分支」的铁律一致。

### 9.2 当前已具备的隔离边界

| 层 | 文件 | 是否 agent 相关 |
|---|---|---|
| 契约 | `agents/mod.rs`：`enum ChatEvent` + trait 两方法（默认 `None`/`Ignore`） | 否（统一形状） |
| 实现 | `agents/claude.rs` chat 区块；codex/gemini 继承默认 → GUI 入口自动禁用 | **是，按文件隔离** |
| 驱动 | `agent_chat.rs`：子进程 + 线程 + emit，只调 `source(&agent)` | 否 |
| 前端 | `chatSessions.ts` / `ChatComposer.vue` / 三个入口 | 否 |

→ 接 Codex 就是**只在 `codex.rs` 加一个区块**，`+` 菜单 / FAB 自动点亮；没有 headless
模式时 `chat_command` 返回 `None`，入口自动隐藏，无需特判。

### 9.3 前置项：先补一个抽象漏洞（send 的 stdin 形状写死了）

`agent_chat.rs::send()` 目前把 **Claude 的 stdin 形状**
（`{"type":"user","message":{...}}`）写死在通用驱动里 —— 这是当前唯一漏在 agnostic 驱动
里的 agent 专属代码。接第二个 agent **之前**先收进 trait：

- `SessionSource` 新增 `fn chat_encode_input(&self, text, images) -> String`（把一条用户
  消息编码成该 agent stdin 的一行；默认实现给 Claude 形状）。
- `ChatHandle` 存 `agent: String`，`send()` 改为 `source(&agent).chat_encode_input(...)`。

做完驱动即 100% agnostic。这是独立的小改动，作为 Phase 3 的第 0 步。

### 9.4 trait 上 chat 的完整契约（接每个 agent 要实现的三件事）

| 方法 | 作用 | None/默认时的行为 |
|---|---|---|
| `chat_command(session_id, perm) -> Option<AgentCommand>` | headless 子进程命令（续聊带 session_id） | `None` → GUI 入口禁用 |
| `chat_encode_input(text, images) -> String`（§9.3 新增） | 用户消息 → stdin 一行 | 默认 Claude 形状 |
| `parse_chat_line(line) -> ChatEvent` | stdout 一行 → 归一事件 | `Ignore`（不被调用） |

### 9.5 接一个 agent 的 chat —— 步骤 recipe

1. **先探针**（像 Phase 1 验证 Claude 那样）：手动跑该 agent 的 headless 命令、喂一条
   消息、dump stdout 事件形状 + 确认 stdin 格式 + session/resume 语义。判断是否
   「**逐行 JSON over pipe**」。
2. 在该 agent 文件加 `// ===== GUI chat =====` 区块，实现上面三个方法（私有 parse
   helper 同文件，不外泄）。
3. 单测：`parse_chat_line` 覆盖该 agent 各事件类型 → `ChatEvent`（参照 claude.rs 现有
   6 个 `parse_chat_line_*` 测试）。
4. **不动** `agent_chat.rs` / `lib.rs` / `chatSessions.ts` / 三个 GUI 入口 —— 自动点亮。
5. 若该 agent **不适配**「逐行 JSON over pipe」（需不同分帧 / 传输 / 无 headless），改的是
   **trait 形状**（在 `mod.rs` 扩展契约），**不是** `agent_chat.rs` 加分支。

### 9.6 各 agent 现状判断

- **Codex**：✅ **已接通**（exec MVP）。`codex exec [resume <id>] --json` 一轮一进程，
  `agents/codex.rs` 实现 `chat_process_model→OneShotResume` + `chat_turn_command` +
  `parse_chat_line`（thread.started→Init / item.completed(agent_message→文本,
  command_execution→shell 工具块, 其它→兜底) / turn.completed→Result）。真机验证过
  exec 首轮 + `exec resume` 续轮（上下文续上）；11 个单测锁协议。权限映射 sandbox
  （plan→read-only / acceptEdits·default→workspace-write / bypass→`--dangerously-bypass`），
  统一用 `-c sandbox_mode=`（`exec resume` 无 `-s`）。
- **Gemini**：headless 流式 JSON 成熟度**存疑** + 本机未认证。若不具备 →`chat_turn_command`
  返回 `None`（GUI 入口不亮，优雅降级）。**认证 + 探针验证前不承诺 Gemini chat**。

### 9.7 验收标准

- 有 headless 的 agent，chat 入口自动出现；没有的不出现，且**完全不影响**该 agent 的
  只读浏览 / TUI resume。
- 新 agent 点亮**零改动** `agent_chat.rs` / `chatSessions.ts` / 三个 GUI 入口；diff 只落在
  该 agent 的文件（+ 一次性的 §9.3 trait 前置项）。

### 9.8 协议探针结论 + 关键架构发现：进程模型不同（2026-06）

对 Codex / Gemini CLI 实测探针后，发现一个**原 §9 计划没覆盖的架构差异**：三家的「进程
模型」不一样，直接决定 `agent_chat.rs` 驱动要怎么写。

**Codex（已实测）** —— `codex exec --json`，**一轮一进程（one-shot）**：

```
codex exec --json -s read-only "<prompt>"          # 首轮
codex exec resume <thread_id> --json "<prompt>"     # 续聊
事件：{"type":"thread.started","thread_id":"…"}      → Init(session_id=thread_id)
      {"type":"turn.started"}
      {"type":"item.completed","item":{"type":"agent_message","text":"…"}}  → Message
      （item.type 还可能是 reasoning / command_execution / file_change / mcp_tool_call）
      {"type":"turn.completed","usage":{…}}           → Result
进程在一轮后 **退出**。prompt 走命令 arg（或 stdin）。
```

**Gemini（CLI 面已确认，事件待补）** —— `gemini -p --output-format stream-json`，**也是
one-shot**：`--resume <id|latest>` / `--session-id <uuid>`（可自带 UUID）/
`--approval-mode default|auto_edit|yolo|plan`。⚠️ 本机 gemini **未认证**，headless 会卡在
OAuth 交互 → **事件形状待认证后再探针**，但 CLI 接口已证明结构可行。

**关键差异 —— 两套进程模型**：

| Agent | 进程模型 | 驱动方式 |
|---|---|---|
| **Claude** | **长驻进程** + stream-json **stdin 多轮喂** | start 起一次，send 写 stdin |
| **Codex / Gemini** | **一轮一进程（one-shot）** + resume | send 时 spawn 一个新 `exec resume <id> "<prompt>"`，读到退出 |

→ 原计划假设所有 agent 都像 Claude「长驻 + stdin」，**不成立**。按 §9.5 step 5 的预案，
**改 trait 形状**（不在 `agent_chat.rs` 加 agent 名分支）：

```rust
enum ChatProcessModel { LongLivedStdin, OneShotResume }
trait SessionSource {
  fn chat_process_model(&self) -> ChatProcessModel { ChatProcessModel::LongLivedStdin }
  // 长驻模型用（Claude）：起进程 + 把用户消息编成 stdin 一行
  fn chat_command(&self, session_id, perm, model, effort) -> Option<AgentCommand> { None }
  fn chat_encode_input(&self, text, images) -> String { /* Claude stdin JSON */ }
  // one-shot 模型用（Codex/Gemini）：把 prompt 直接编进「这一轮」的进程命令
  fn chat_turn_command(&self, session_id, prompt, perm, model, effort) -> Option<AgentCommand> { None }
  // 两者共用
  fn parse_chat_line(&self, line) -> ChatEvent { ChatEvent::Ignore }
}
```

`agent_chat.rs` 按 `chat_process_model()` 分两条路径（trait 驱动，非 agent 名分支）：
- **LongLivedStdin**：`start` spawn 长驻进程 + reader/waiter（现状）；`send` 写 stdin。
- **OneShotResume**：`start` 不 spawn（只登记 cwd/agent/session_id）；`send` spawn 一个
  `chat_turn_command(...)` 进程，挂 reader 读到退出，`thread.started` 回填 session_id 供下轮
  resume，进程退出即该轮 `Result`。

这同时**收编了 §9.3 的 send 漏洞**：stdin 编码（`chat_encode_input`）归 LongLivedStdin 路径，
one-shot 路径根本不写 stdin JSON。

**修订落地顺序（§9 实现）**：
1. ✅ **已完成** trait 扩展：`ChatProcessModel` + `chat_encode_input`（默认 = Anthropic
   stream-json 形状，收编 §9.3）+ `chat_turn_command`；`agent_chat.rs` 抽出两条路径
   （`ChatHandle` enum：LongLived / OneShot）；Claude 走 LongLivedStdin，140→151 测试保绿。
   `ChatImageInput` 移到 `types.rs`（共享 DTO，避免 trait 反向依赖驱动）。
2. ✅ **已完成** Codex：`codex.rs` 实现 one-shot 三件套 + `parse_chat_line`，真机验证 +
   11 单测。前端 `Agent` 已含 codex，"New GUI session" 菜单 agent-agnostic → 自动亮。
3. ⏳ Gemini：先认证再探针事件形状，再照 Codex 套路实现；未认证前 `chat_turn_command`
   返回 `None` → 入口不亮。

### 9.9 对照 IDE 插件：Claude `control_request` vs Codex `app-server`（决策：不上 app-server）

进一步对照「VSCode 系插件怎么做的」，发现 Claude / Codex 把「富功能」放在**完全不同的层**，
直接决定 §10 各项对两个 agent 的代价 —— 下面每条都有本机实测证据。

**Codex 插件 = `app-server`（长驻 JSON-RPC 引擎）**。`codex app-server` 是个**独立引擎**
（不是 `exec`），`generate-json-schema --out` 导出 66k 行 / 49 类的**已发布协议**。里面有：
- token 增量：`AgentMessageDeltaNotification` / `item/agentMessage/delta` / `commandExecution/outputDelta`
- 内联审批：`ExecCommandApprovalRequest` / `ApplyPatchApprovalRequest`（服务端反向请求）
- 实时限额：`ThreadTokenUsageUpdatedNotification` / `AccountRateLimitsUpdatedNotification` / `RateLimitSnapshot`

→ Codex 的流式 / 审批 / 5h·周限额**只在 app-server 有，`exec --json` 一概没有**。代价：要写
JSON-RPC 客户端 + `initialize` 握手 + 第三种进程模型 + 反向审批 → 重。**本期决策：不上。**

**Claude 插件 = 同一根 stream-json 管子 + `control_request` 控制层**。`claude`(2.1.187) 二进制里
实测含这些字面量：`control_request` / `control_response` / `control_cancel_request` /
`set_model` / `set_permission_mode` / `can_use_tool` / `hook_callback` / `mcp_message` /
`stream_event` / `content_block_delta` / `text_delta` / `thinking_delta` / `input_json_delta`。
另有 `~/.claude/ide/<port>.lock`（`{pid,workspaceFolders,ideName,transport:"ws",authToken}`）—
这是**编辑器集成的 WebSocket MCP 通道**（选区/诊断/原生 diff/gutter 接受改动），靠 `--ide` 连，
**与聊天主循环正交**，我们是会话查看器、**不需要**这条。

→ Claude 的富功能**在我们已经在驱动的那根 stdin/stdout 里**，只是消息类型用得更全（我们现在只发
`user`、只解析 assistant/result）。补 `--include-partial-messages`（流式）+ `control_request`
（活切模型/权限 + `can_use_tool` 审批）即可，**同进程同管子，远比 app-server 轻**。

**镜像结论（贯穿 §10）**：

| | 切模型/effort/权限 | token 流式 | 内联工具审批 | 5h/周限额 |
|---|---|---|---|---|
| **Claude**（LongLived） | `control_request` 活切 / 或 §10.0 重启 | ✅ `--include-partial-messages` | ✅ `can_use_tool` | ✅ `rate_limit_event` |
| **Codex**（OneShot） | ✅ **改下轮 flag 即可，免费 live** | ❌ exec 做不到（仅 app-server） | ❌ 仅 sandbox 闸（仅 app-server 有审批） | ❌ exec 不给（仅 app-server） |

> Codex 白拿「切换器」缺「流式/审批/限额」；Claude 白拿「流式/审批/限额」但「切换」要补
> control_request（或重启）。本期对两边都**只用各自轻路径**，硬缺口对 Codex 优雅降级。

## 10. Composer 工具条对齐 VSCode Claude 插件标准（Phase 1.5 · 高优先级）

> 目标：ChatComposer 底栏对齐 **VSCode Claude 插件标准** —— 左权限模式可切；右模型 + effort +
> 上下文/限额；外加修复 slash 指令 + token 流式。**不上 app-server**（§9.9 决策）：Claude 走
> `control_request`（轻路径）/ 或 §10.0 重启，Codex 走 per-turn flag。

**主表 —— 每个 §10.x 各 agent 要做什么（或补什么）**

| § | Claude（LongLived）要做 | Codex（OneShot）要做 | 前端共享 |
|---|---|---|---|
| **10.0 restart-with-resume** | 建通用 `restartChat`：停进程→`--resume <id>` 重起带新 flag，保留 msgs。给「无控制消息的 flag」兜底（effort） | **天然具备**，no-op（改 flag 下轮即生效） | 重启不闪、msgs 不丢 |
| **10.1 slash 动态** | 发现 `.claude/commands/*.md`(项目+全局) + skills；**砍掉** /clear /compact /help | 发现 `~/.codex/prompts/*.md`（现为空，低优先） | 替换写死的 SLASH 数组，按 agent 拉列表 |
| **10.2 模型切换** | 启动 `--model`；切换→`control_request:set_model`（或 §10.0 重启兜底） | `codex exec -m <model>`，**下轮生效，免费** | 模型 picker（按 agent 给候选） |
| **10.3 effort** | `--effort` 启动 flag；切换→**只能 §10.0 重启**（无 set_effort） | `-c model_reasoning_effort="<low\|medium\|high>"`，**下轮生效，免费** | effort picker（仅推理模型） |
| **10.4 权限三档** | `control_request:set_permission_mode` 活切；**深水区** `can_use_tool` 审批往返 | 映射 sandbox（read-only/workspace-write/danger），**下轮生效，免费**；**无内联审批** | 权限 chip 点击循环；审批弹窗（仅 Claude） |
| **10.5 上下文/限额** | context% = 累计 usage / 窗口；5h/周 = 解析现在忽略的 `rate_limit_event` | context% = turn.completed.usage / 窗口；**5h/周 exec 不给** | 三个 meter；模型→窗口表 |
| **10.6 token 流式** | `--include-partial-messages` → 解析 `stream_event` 增量 | **做不到 token 级**；最多 item 级（item.started 先显示） | 「进行中」气泡增量累积 |
| **10.7 顺序** | — | — | 纯 UI 布局 |

**Codex 三个硬缺口（都得 app-server，本期不碰 → UI 优雅降级 + tooltip 说明，不是 bug）**：
§10.6 token 流式、§10.4 内联工具审批、§10.5 的 5h/周限额。

**需要补的地基（trait / 驱动 / 前端）**：
- trait：`chat_command(…, model, effort)`（Claude 启动）+ `chat_turn_command(…, model, effort)`
  （Codex 每轮）+ `chat_encode_control(kind, value)->Option<String>`（Claude 产 control_request，
  Codex 默认 None）+ `chat_slash_commands(cwd)` / `chat_models()` / `chat_efforts()` /
  `chat_context_window(model)`。
- 驱动：LongLived 往 stdin 写 control_request；reader 认入站 `can_use_tool` → emit 前端 → 收答复
  → 写 control_response；加 `--include-partial-messages` 后解析 `stream_event` → 新 emit
  `agent-chat://delta`；通用 `restartChat`。
- 前端：composer footer（模型/effort/权限 chip + 三 meter）+ 流式 delta 累积 + 审批弹窗（Claude）。

> 注：§10.2/10.3 会重新引入之前撤回的 `model`/`effort` trait 参数 —— 那次是跟 §9 混了被撤，
> 现在正当归属 §10，干净。

### 10.0 共用机制：会话「就地重启」（restart-with-resume）

模型 / effort / 权限模式都是**子进程启动参数**（`--model` / `--effort` /
`--permission-mode`）—— headless 下**无已验证的「中途控制消息」通道**。所以切换 = 用新参数
**重启子进程**（带 `--resume <sessionId>` 续上下文），前端 `msgs` 不动、transcript 不丢。

落地：`agent_chat.rs` + `chatSessions.ts` 加一个「就地重启」能力 —— 停旧 chatId → 用新参数
起 → 换 `session.chatId` + 重新注册路由；`session.msgs` 保留。空闲时切换无感；turn 进行中
切换会打断当前轮（下一轮生效）。**这是 Claude 10.2 / 10.3 / 10.4 的共用前置。**

- **Claude（LongLived）**：需要本机制（长驻进程，启动参数中途改不了）。
- **Codex（OneShot）**：**天然具备，no-op** —— 每轮本就重 spawn `codex exec`，改 model/effort/
  sandbox flag 在下一轮 `chat_turn_command` 里直接带上即可，无需任何重启机制。

### 10.1 Slash 指令（修复 · 最高优先，且不依赖重启机制）

- **现状 bug**：硬编码 3 条且全是 TUI 内置命令（`/clear`/`/compact`/`/help`），headless 下
  报 *"… isn't available in this environment"*（用户实测命中）。
- **探针结论**：自定义命令（`.claude/commands/*.md`）+ skills **在 headless 下会展开**
  （实测 `/xxx` → 正常执行）；**TUI 内置命令不展开**。
- **方案**：后端新增 `SessionSource::chat_slash_commands(cwd) -> Vec<SlashCommand>`（Claude 扫
  `<cwd>/.claude/commands/`、`~/.claude/commands/`、`~/.claude/skills/*/SKILL.md` 中标
  `user-invocable: true` 的；取 name + description）。前端 ChatComposer 改为**拉这份动态
  列表**、按输入过滤，选中后仍按 `/<name>` 透传（CLI 自己展开）。**内置 TUI 命令不进列表**
  （避免重现「不可用」）。可选：极少量 app 原生实现（如 `/clear` → 新开一个 GUI 会话）。

### 10.2 模型切换（Image #17）

- **Claude**：`--model <model>` 启动 flag。切换→ MVP 走 §10.0 重启；**对齐插件标准**则升级到
  `control_request:set_model`（活切免重启，待探报文形状）。候选：Opus 4.8 / Sonnet 4.6 /
  Haiku 4.5（**Fable 5 当前不可用，置灰**）。「Fast mode」headless 对应 flag 待确认，先不接。
- **Codex**：`codex exec -m <model>` 每轮带 → **改下轮即生效，免费 live**，无重启。候选为 codex
  侧模型（gpt-5.x-codex / o3 …，由 `chat_models()` 按 agent 给）。
- 底栏右侧模型名点开下拉，按 `chat_models()` 拉当前 agent 的候选。

### 10.3 Effort 切换（Image #18）

- **Claude**：`--effort <level>` 启动 flag（low/medium/high/xhigh/max）。二进制里**没有**
  `set_effort` 控制消息 → 活切**只能走 §10.0 重启**（或折进模型选择）。`--fallback-model`
  也在，后续可做「自动降级」开关。
- **Codex**：`-c model_reasoning_effort="<minimal|low|medium|high>"`（实测枚举）每轮带 →
  **下轮生效，免费 live**。仅推理模型有意义。
- Faster↔Smarter 滑块映射到各 agent 的 effort 档位。

### 10.4 权限模式切换（Image #15/#16）

- **Claude**：`--permission-mode` 启动 flag。切换→ MVP 走 §10.0 重启；**对齐插件标准**升级到
  `control_request:set_permission_mode`（活切）。**深水区 = `can_use_tool`**：CLI 反向请求
  「允许这个工具吗」→ 前端弹「允许/拒绝/总是允许」→ 回 `control_response`（= Phase 2 内联审批，
  插件的真·default/Ask 模式靠这个）。
- **Codex**：映射 sandbox（plan→read-only / acceptEdits·default→workspace-write /
  bypass→`--dangerously-bypass`），每轮带 → **下轮生效，免费**；但 **exec 无 `can_use_tool`
  等价物**，没有内联审批（仅 app-server 有）→ Codex 只有 sandbox 三档这一闸。
- ⚠️ **Phase 1.5 约束**：Claude 在 `can_use_tool` 落地前，仍只放 **Accept edits / Bypass /
  Plan 三档**（headless 无需交互审批，安全）；default / Ask 待 `can_use_tool` 接通再开放。

### 10.5 上下文 / 限额指示（Image #19）

- **上下文窗口** ✅：`result.usage`（`input_tokens` + `cache_read_input_tokens` +
  `cache_creation_input_tokens`）给出已用 tokens；模型最大窗口前端按 **model→window 表**
  换算 → 显示 "85k / 200k (xx%)"。（stream 不含 `modelContextWindow`，需前端维护该表。）
- **5 小时 / 周限额重置时间** ✅：stream 里有 `rate_limit_event`
  （`{rateLimitType:"five_hour", resetsAt:<unix>, status, overageStatus}`）→ 可显示
  **重置时间 + 状态**（周限额应为另一条 `rateLimitType` ，待确认）。
- ⚠️ **限额百分比**（客户端的 7% / 65%）：`rate_limit_event` 只给 `resetsAt` + `status`，
  **不含用量百分比** → 百分比可能需单独的 `/usage` 类接口，headless stream 不提供。
  **MVP 先做：上下文窗口 % + 限额重置时间 + 接近限额告警**；用量百分比待数据源确认。
- **Codex**：context% ✅ 从 `turn.completed.usage`（input/output/cached）/ 模型窗口换算；
  但 **5h/周限额 exec `--json` 不暴露**（仅 app-server 的 `RateLimitSnapshot` 有）→ 该 agent
  限额条**优雅降级隐藏**，只显示上下文窗口。`chat_context_window(model)` 给各 agent 窗口大小。

### 10.6 流式输出（token 级 —— 用户：「像正常 AI 一样流式」）

- **现状**：message 级流式 —— 每个 `assistant` 事件是一条完整气泡，回答「一次性蹦出来」。
- **探针结论**：加 `--include-partial-messages` flag，stream-json 额外吐**标准 Anthropic
  流式事件**（`stream_event` 包 `message_start` / `content_block_start` /
  `content_block_delta`(`text_delta` / `thinking_delta`) / `content_block_stop` /
  `message_delta` / `message_stop`），最后仍给完整 `assistant` + `result`。→ **可行**。
- **方案**：
  - 后端 `chat_command` 加 `--include-partial-messages`；`parse_chat_line` 把
    `stream_event` 的 `content_block_delta(text_delta)` 归一成新 `ChatEvent` 变体（如
    `Delta { text }` + block 生命周期）；`thinking_delta` 可单独走「思考中」展示。
  - 前端在 `content_block_start` 起一个「进行中」assistant 气泡，`text_delta` 持续追加
    （打字机效果），`message_stop` / 完整 `assistant` 到达时用权威内容**对账替换**（防丢字）。
  - 兼容：无 partial 时退回整条追加（message 级）。
- **注意**：delta 累积要和 §1「重建数组」反应式策略对齐 —— 进行中气泡用**一个可变 last-msg
  引用增量更新**，避免每个 token 重建整个数组（性能）。「SSE」在本架构里就是现有 Tauri
  事件通道（效果等价，非真 HTTP SSE）。
- **Codex**：**token 级流式做不到** —— `codex exec --json` 是 item 粒度（整块 `item.completed`），
  无 token delta（仅 app-server 有 `AgentMessageDeltaNotification`）。最多做 **item 级**：
  `item.started` 先显示「正在执行命令…」，`item.completed` 填实结果。前端的流式气泡逻辑对 Codex
  退化成「整块追加」（即现状），不阻塞 Claude 的 token 流式。

### 10.7 建议落地顺序（含底栏排版本身）

1. ✅ **Claude 流式（10.6）** —— `--include-partial-messages` + `stream_event`→`Delta`→
   `agent-chat://delta`；前端 `live` 字段打字机 + 即时 markdown 渲染（`streamingHtml`）。
   Codex 天然降级为整块。
2. ✅ **model/effort/perm 通到 trait（10.2/10.3/10.4 参数层）** —— `chat_command` /
   `chat_turn_command` 加 model/effort；`agent_chat_start` 返回 `processModel`；send 透传。
   **Codex 全套 live 切换（免费，下轮 flag）**；Claude 启动 flag。底栏 3 个 `ChatPicker`。
3. ✅ **restart-with-resume（10.0）** —— Claude 改了设置 → 下次发送前 stop 旧 →
   `--resume` 新 flag 起新进程 → 热换 `chatId` + 重注册路由（`msgs` 保留）。Codex 跳过。
4. ⏸ **control_request 升级（10.2/10.4）·Phase 2 deferred** —— `set_model` /
   `set_permission_mode` 活切 + `can_use_tool` 内联审批。**先探报文形状**再写。仅 Claude。
   当前用 §10.0 重启 + per-turn flag 顶上，功能不缺，只是 Claude 切换有一次「重连」开销。
5. ✅ **上下文/限额（10.5）+ slash 动态（10.1）+ 底栏排版（10.7）** ——
   - 10.1：`chat_slash_commands(cwd)` 扫 `.claude/commands/**` + user-invocable skills，
     前端 `/` 浮层拉动态列表（**去掉写死的 TUI 内置命令**）。
   - 10.5：`rate_limit_event` 宽松解析 → `agent-chat://ratelimit`；前端 `chatContext.ts`
     按 model→window 表算上下文 %（近似）+ 限额重置时间，底栏指示，Codex 限额优雅降级隐藏。
   - 10.7：底栏 = 左 权限 chip + 附件；右 限额 · 上下文% · running · 模型 · effort。

---

**一句话总结**：用**管道子进程跑 CLI 的 stream-json 模式**程序化驱动对话，事件直接喂进
**复用的 `Block`/ChatView 渲染**；干净的流式体验 + 内联审批，代价是新增一个后端驱动子系统
（`agent_chat.rs`）和每个 agent 的事件适配器。

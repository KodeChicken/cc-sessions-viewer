# 计划：viewer 内嵌 LLM 对话（Feature Request #1）

> 关联 issue：[#1 Feature Request: in-app LLM chat with session context](https://github.com/jerrywu001/cc-sessions-viewer/issues/1)
> 状态：**待实现**（计划已评审，等拍板 2 个决策点）

## 1. 需求

看完 session 后，不离开 viewer 就能"基于该内容跟 LLM 对话"。例如：

- 对出错的步骤问"为什么失败？怎么修"
- 对 token 消耗高的地方问"哪里能优化"
- 追问"这个设计决策有什么替代方案"

在 viewer 内打开 chat 面板，把**选中的上下文 + 问题**用本地已有的 API key 配置发给 LLM，回复直接显示在 viewer 内。可选功能，**不破坏只读浏览体验**，用 toggle 开关控制。

## 2. 已确认的设计决策

| # | 决策 | 选择 |
|---|---|---|
| 1 | provider / key 来源 | 在 Settings 加设置，**基于本地 agent 配置直接读取** |
| 2 | key 配置方式 | 同 1（读 agent 配置 + Settings） |
| 3 | 上下文范围 | **消息选择**（用户勾选要带入的消息） |

## 3. ⚠️ 关键现实约束：key 不一定能从 config 直接拿到

"直接读取本地 agent 配置的 key"——三家情况不同，决定 MVP 边界：

| Agent | 本地凭据位置 | 能否直接拿到可用 API key |
|---|---|---|
| Codex | `~/.codex/auth.json` | 视登录方式：**API key 登录 → 能拿到**；ChatGPT 订阅登录 → OAuth，拿不到 |
| Gemini | `~/.gemini/oauth_creds.json` | 默认 **OAuth**，除非用户设了 `GEMINI_API_KEY` |
| Claude | `~/.claude/`（订阅走 Keychain/OAuth） | 订阅用户**通常没有** API key，除非设了 `ANTHROPIC_API_KEY` |

**对策**：key 解析做成**三级回退**，并在 Settings 对每个 provider 显示探测状态（已从 config/env 检测到 / 需手填）：

```
① 我们 Settings 里手填的 key
② 环境变量（ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY）
③ agent config 文件（codex auth.json 等）
```

这样订阅 / OAuth 用户也能用（首次手填一次 key）。

## 4. 架构（复用现有模式）

### 后端（Rust）—— 新增 `src-tauri/src/chat/`

- `Cargo.toml` 增加 `reqwest`（`rustls-tls` + `stream` feature）。**当前后端零 HTTP 依赖，这是唯一新增依赖。**
- Provider 抽象（仿 `SessionSource` trait）：`anthropic` / `openai` / `google`，各自实现：
  - `resolve_key()` —— 三级回退
  - `build_request()` —— 拼 system + context + question + history
  - `parse_sse()` —— 解析流式分片
- Tauri 命令（在 `lib.rs` 注册 + `api.ts` 包装）：
  - `chat_provider_status()` → 每个 provider 的 key 来源（config/env/settings/none）+ 默认模型，喂给 Settings UI
  - `start_chat(requestId, agent, model, context, question, history)` → `thread::spawn` 跑请求，SSE 增量通过 `chat://delta` / `chat://done` / `chat://error` 事件推送（与 `stats://` 完全同款）
  - `cancel_chat()` → 复用 stats 的"代际计数器"取消法
  - `set_chat_key(agent, key)` → 手填 key 持久化到 app 配置目录的 json（**不进 localStorage**，避免明文暴露在 webview）
- key 不出后端，HTTP 在后端发（顺带规避 CORS）。

### 前端（Vue）

- `src/llmChat.ts`：仿 `useStatsStream` 的 composable，管理对话线程 + 监听 `chat://*` + `send()`。
- `src/api.ts`：加 `startChat / cancelChat / chatProviderStatus / setChatKey` 包装。
- **`src/views/ChatView.vue`**：
  - 加**消息多选**（复用 sessions / trash 已有的 select-mode + checkbox 模式）。工具栏新增"问 AI"动作。
  - 选中的 `Msg[]` → 复用 `src/export.ts` 的 `messagesToMarkdown()` 拼成上下文字符串（零重复造轮子）。
  - 右侧**滑出式 chat 面板**：展示问答 + 流式回复，沿用现有设计 token。
- **`src/components/SettingsModal.vue`**：新增 "AI 对话" 分区——总开关 + 每 provider 的 key 探测状态 + 模型选择 + 可选 key 输入框。
- `src/settings.ts`：加 `aiChatEnabled` + 模型偏好（localStorage）；key 不存这里。
- i18n（4 个 locale）：加 `settings.ai.*` / `chat.ai.*` 键。

## 5. 数据流

```
ChatView 勾选消息
   → messagesToMarkdown(选中子集) 生成上下文
   → start_chat(agent, model, context, question)
   → 后端按 session 的 agent 选 provider、三级解析 key、发流式请求
   → chat://delta 逐字推送
   → chat 面板实时渲染
   → chat://done
```

全程**不写原始 transcript**（保持只读保证）。

## 6. 分阶段交付

### Phase 1（MVP）
- 后端 `reqwest` + Anthropic + OpenAI 两家 provider
- 三级 key 回退 + 流式 + 取消
- ChatView 消息选择 + 右侧 chat 面板
- Settings "AI 对话" 分区 + 总开关
- i18n
- Gemini 先只支持"已设 `GEMINI_API_KEY`"的情况

### Phase 2
- Gemini OAuth 支持
- 多轮追问优化
- token 估算 / 超限提示
- Anthropic 图片上下文
- key 改存 OS Keychain

## 7. 风险点

1. **成本 / 隐私**：会把会话内容发到外部 API → 默认关闭，开关开启时给明确提示。
2. **依赖体积 / 编译时间**：`reqwest` 会拉一批 crate，首次编译变慢。
3. **OAuth 那一档**：Claude 订阅 / Gemini OAuth 用户首次用必须在 Settings 手填 key——这是第 3 节表格的直接后果，无法绕开。

## 8. 测试

- 后端：provider 请求拼装单测（mock）、key 解析优先级单测。
- 前端：`llmChat` composable + 选择逻辑、SettingsModal 新分区。

## 9. 待拍板的 2 点

- **A**：Phase 1 是否接受"Gemini 暂时只支持 API key 模式"（OAuth 放 Phase 2）？
- **B**：chat 面板做**单轮**（选中 → 问 → 答，简单）还是**多轮追问**（issue 提到"想追问"，但实现略多）？

> 推荐：Gemini 延后 + 多轮。确认后即可建任务进入实现。

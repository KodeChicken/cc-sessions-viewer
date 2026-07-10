# Codex GUI Chat 实现计划

## 架构

### 进程模型：`codex app-server --stdio`（JSON-RPC）

最终采用 `codex app-server --stdio` 取代早期的 `codex exec --json`。这是 Codex 的 rich-client 协议，通过 JSON-RPC 与 app-server 通信，支持：

- **交互式审批**：`item/commandExecution/requestApproval` → 前端弹 `ChatPermissionPrompt` → 用户 allow/deny → RPC 回应 `accept`/`decline`
- **流式输出**：`item/agentMessage/delta` → token 级打字机预览
- **续聊 resume**：`thread/resume` RPC（不是 `codex exec resume`）
- **权限覆写**：`approvalPolicy` + `sandboxPolicy` 参数随每轮下发

`agent_chat.rs` 新增 `ChatHandle::CodexAppServer` 变体，与 Claude 的 `LongLived` 和旧 Codex 的 `OneShot` 并列。旧的 `codex exec` OneShot 路径保留但运行时不再触达（`if agent == "codex"` 优先走 app-server）。

### 核心数据流

```
用户发消息 → sendPrompt → agentChatSend(text, model, effort, permissionMode)
    → agent_chat::send → CodexAppServer::send_turn
        → codex_write_rpc("turn/start", { threadId, input, model, effort, approvalPolicy, sandboxPolicy })
    ← codex app-server stdout (JSON-RPC notifications):
        ← item/agentMessage/delta → emit agent-chat://delta (流式预览)
        ← item/commandExecution/requestApproval → emit agent-chat://permission (审批弹窗)
            → 用户 allow/deny → respond_control → codex_write_rpc(rpc_response, accept/decline)
        ← item/completed → emit agent-chat://event (完整气泡)
        ← turn/completed → emit agent-chat://result (轮结束 + usage)
```

## 已完成

### Phase 1：配置数据对齐

- [x] **模型列表**：GPT-5.5 / 5.4 / 5.4-Mini / 5.3-Codex + More(5.2)
- [x] **Effort 档位**：`low / medium / high / xhigh`（展示名 Light → Extra High）
- [x] **权限模式**：独立 `CODEX_PERMISSION_MODES` 四档（ask / approve / fullAccess / custom）
- [x] **effortLabel**：`xhigh` → "Extra High" 映射表
- [x] **默认值**：`defaultPermissionMode('codex')` = `approve`，`defaultModel` = `gpt-5.5`，`defaultEffort` = `high`

### Phase 2：UI 入口解除

- [x] 4 处 `agent === 'claude'` → `chatSupported(agent)` 
- [x] `NewMenu.vue` / `SessionsView.vue` / `ChatView.vue` / `App.vue`
- [x] `SessionsView.vue` 补 `IconChat` import（bug fix）

### Phase 3：UI 适配

- [x] Usage/rate-limit badge 已有 `agent === 'claude'` 守卫
- [x] Streaming：`item/agentMessage/delta` → delta 事件，Codex 也有流式预览了
- [x] Permission prompt：复用 `ChatPermissionPrompt.vue`，新增 Codex 分支（Environment/Reason 显示）
- [x] Side chat / Fork / Fast mode 保持 Claude-only

### Phase 4：打磨 & 测试

- [x] i18n：4 locale 补 Codex 权限翻译 + permission prompt 标题/hint
- [x] Codex CLI 未安装检测：`ensure_codex_cli_available` 检查 PATH
- [x] 模型标签回填：`onMsg` 时 Codex assistant Msg 用 `s.model` 回填
- [x] 续聊继承原 session 模型：`resumeChatFromSession` 传 `lastAssistantModel(preload)`
- [x] 续聊权限用 `defaultPermissionMode(agent)` 不硬编码
- [x] Error item 处理：弃用警告过滤，其他 error 用 `system_event` 显示
- [x] 单元测试：668 前端 + 254 Rust 全通过

### Bug fixes（测试中发现并修复）

1. **`lib.rs` permission 验证遗漏** — `valid_permission_mode` 未包含 `ask/approve/fullAccess/custom`
2. **`agent_chat.rs` reclaude 劫持** — 非 Claude agent 强制 `use_reclaude = false`
3. **`codex.rs` sandbox flag** — `-s` 仅 `exec` 支持，改回 `-c sandbox_mode=`（保留在旧 OneShot 路径中）

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/agent_chat.rs` | 新增 `ChatHandle::CodexAppServer`、JSON-RPC 协议、审批流、流式 delta |
| `src-tauri/src/agents/codex.rs` | sandbox 映射、error item 过滤、旧 OneShot 路径保留 |
| `src-tauri/src/lib.rs` | `valid_permission_mode` 加入 Codex 四值 |
| `src-tauri/src/types.rs` | `ChatProcessModel::as_str()` |
| `src/chatComposerOptions.ts` | 模型/effort/权限独立配置、chatSupported |
| `src/chatSessions.ts` | defaultPermissionMode、onMsg 模型回填 |
| `src/chatPermission.ts` | toolName 匹配 `shell`（Codex） |
| `src/components/ChatPermissionPrompt.vue` | agent prop、Codex 分支 UI |
| `src/components/ChatModeMenu.vue` | agent prop、permissionModesFor |
| `src/components/ChatComposer.vue` | agent 传递、签名更新 |
| `src/components/NewMenu.vue` | chatSupported 门禁 |
| `src/views/SessionsView.vue` | chatSupported + IconChat import |
| `src/views/ChatView.vue` | chatSupported FAB、agent 传递 |
| `src/App.vue` | chatSupported、续聊模型继承、默认权限 |
| `src/format.ts` | Codex 相关格式化 |
| `src/locales/*.ts` | Codex 权限/permission prompt 翻译 |
| `test/` | 668 前端测试全通过 |

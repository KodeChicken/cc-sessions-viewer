// 「btw」侧聊浮框的全局状态层 —— 对标 Claude Code 客户端的 `/btw`：在主任务进行中
// 顺手问一句、不打断、也不污染主对话历史。
//
// 语义取自 Claude Code 官方对 `/btw` 的定位：一个**临时**的旁支问答，能看见当前对话
// 的上下文，但答完即走、不进主历史。本 app 是「外部进程」模型（每个 chat 是独立的
// stream-json 子进程），无法像 TUI 那样共享内存里的对话，于是用 `--fork-session`
// 从主聊**派生**一份独立会话来还原「继承上下文却不污染」这一灵魂：
//   · 主聊有 sessionId（已落盘）→ fork：侧聊继承其全部上下文，写到一个新 session id；
//   · 没有（如全新主聊还没出首个 result）→ 退化为同目录下的一个全新 Claude 会话。
// 关掉浮框 = 停子进程并丢弃（fork 出来的 transcript 与主聊无关，不回写）。
//
// 进程模型复用 chatSessions：侧聊本身就是一个普通 ChatSession，被 `startChat` 推进
// `chatSessions.value`（于是模块时钟、事件路由、closeChat 全都直接复用），只是另由这里
// 的 `sideChat` ref 单独持有、与主视图的 `liveChat` 互不干扰。

import { ref } from 'vue'
import { startChat, closeChat, sendPrompt, type ChatSession } from './chatSessions'

/** 当前的 btw 侧聊会话；null = 浮框未开。主视图的 `liveChat` 与它各持一份，互不影响。 */
export const sideChat = ref<ChatSession | null>(null)

export interface OpenSideChatOptions {
  /** 侧聊所属项目 key（= ProjectInfo.dirName），仅用于归类/标题。 */
  projectKey: string
  /** 工作目录 —— 侧聊子进程的 cwd，必须存在。 */
  cwd: string
  /** 主聊的 session id：非空则 fork 继承其上下文；空/缺省则全新会话。 */
  forkSessionId?: string
  /** 沿用主聊的模型（保持口径一致）；缺省走 CLI 默认。 */
  model?: string
  effort?: string
  /** `/btw 你的提示词` 直接带词：开框即发这一句。 */
  prompt?: string
  title?: string
}

/**
 * 打开（或复用）btw 侧聊浮框。已开则不重开子进程：带词就把这句发进现有侧聊，
 * 否则只是把焦点交还给已存在的浮框。返回当前侧聊会话。
 */
export async function openSideChat(opts: OpenSideChatOptions): Promise<ChatSession | null> {
  if (sideChat.value) {
    if (opts.prompt) void sendPrompt(sideChat.value, opts.prompt)
    return sideChat.value
  }
  const fork = !!opts.forkSessionId
  const session = await startChat({
    // btw 是 Claude Code 的概念（`--fork-session` 也只有 Claude 有）→ 侧聊恒为 claude。
    agent: 'claude',
    projectKey: opts.projectKey,
    cwd: opts.cwd,
    sessionId: fork ? opts.forkSessionId : undefined,
    fork,
    title: opts.title ?? 'btw',
    // 旁支问答：plan 模式（只读、不动文件）—— 主聊正在改代码时，侧聊绝不会去碰同一批文件。
    permissionMode: 'plan',
    model: opts.model,
    effort: opts.effort,
    initialPrompt: opts.prompt,
  })
  sideChat.value = session
  return session
}

/** 关闭 btw 侧聊：停子进程并丢弃（fork 出来的会话与主聊无关，不回写主历史）。 */
export function closeSideChat(): void {
  const s = sideChat.value
  sideChat.value = null
  if (s) void closeChat(s.uiId)
}

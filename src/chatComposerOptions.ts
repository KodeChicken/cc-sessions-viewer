// GUI chat 底栏切换器的候选项（§10.2 模型 / §10.3 effort / §10.4 权限）。
// 纯数据 + 纯函数，便于单测；UI 在 ChatModelMenu / ChatEffortSlider / ChatModeMenu。
//
// Claude 有两套菜单：
// - 订阅/OAuth（apiKeySource === 'none'）沿用官方完整 model id；
// - API-key / 第三方兼容端点走 family alias（opus / sonnet / haiku / fable），让 Claude CLI
//   自己按 ~/.claude/settings.json 的 ANTHROPIC_DEFAULT_*_MODEL 映射到用户当前配置的真实模型。

import type { Agent } from './types'

export interface ModelOption {
  /** 下发给 CLI 的完整 model id。 */
  value: string
  /** 展示名（如 "Opus 4.8"）。 */
  label: string
}

export interface ModelMenuConfig {
  /** 置灰、不可选（如 Fable 5「Currently unavailable」）。 */
  unavailable: ModelOption[]
  /** 主列表（带 1/2/3… 数字快捷键 + 勾选）。 */
  primary: ModelOption[]
  /** "More models" 折叠组。 */
  more: ModelOption[]
  /** 是否显示 "Fast mode" 区（仅 Claude；headless 暂无对应 flag，渲染但禁用）。 */
  showFastMode: boolean
}

export interface ModelMenuOptions {
  claudeAliasMode?: boolean
  claudeAliasTargets?: Partial<Record<'opus' | 'sonnet' | 'haiku' | 'fable', string>>
}

/** 标准模型菜单（按 agent）。Claude 用官方完整 id；Codex 给一组常见 gpt-5.x。 */
export const CHAT_MODEL_MENU: Record<Agent, ModelMenuConfig> = {
  claude: {
    unavailable: [{ value: 'claude-fable-5', label: 'Fable 5' }],
    primary: [
      { value: 'claude-opus-4-8', label: 'Opus 4.8' },
      { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
    more: [
      { value: 'claude-opus-4-7', label: 'Opus 4.7' },
      { value: 'claude-opus-4-6', label: 'Opus 4.6' },
    ],
    showFastMode: true,
  },
  codex: {
    unavailable: [],
    primary: [
      { value: 'gpt-5.4', label: 'gpt-5.4' },
      { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
      { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
    ],
    more: [{ value: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max' }],
    showFastMode: false,
  },
  gemini: { unavailable: [], primary: [], more: [], showFastMode: false },
}

/** Claude 在 API-key / 第三方兼容端点下改走 alias，让本地 settings.json 模型映射接管。 */
export const CLAUDE_ALIAS_MODEL_MENU: ModelMenuConfig = {
  unavailable: [],
  primary: [
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
    { value: 'fable', label: 'Fable' },
  ],
  more: [],
  showFastMode: true,
}

function withAliasTargetLabel(base: ModelOption, target?: string): ModelOption {
  const clean = target?.trim()
  if (!clean) return base
  return { ...base, label: `${base.label} (${clean})` }
}

export function modelMenuFor(agent: Agent, opts: ModelMenuOptions = {}): ModelMenuConfig {
  if (agent === 'claude' && opts.claudeAliasMode) {
    return {
      ...CLAUDE_ALIAS_MODEL_MENU,
      primary: CLAUDE_ALIAS_MODEL_MENU.primary.map((m) =>
        withAliasTargetLabel(
          m,
          opts.claudeAliasTargets?.[m.value as keyof NonNullable<ModelMenuOptions['claudeAliasTargets']>],
        ),
      ),
    }
  }
  return CHAT_MODEL_MENU[agent]
}

function claudeKnownModels(): ModelOption[] {
  return [
    ...CHAT_MODEL_MENU.claude.unavailable,
    ...CHAT_MODEL_MENU.claude.primary,
    ...CHAT_MODEL_MENU.claude.more,
    ...CLAUDE_ALIAS_MODEL_MENU.primary,
  ]
}

/** 该 agent 是否提供模型选择。 */
export function hasModelChoice(agent: Agent, opts: ModelMenuOptions = {}): boolean {
  const c = modelMenuFor(agent, opts)
  return c.primary.length > 0 || c.more.length > 0
}

/** 扁平化所有可选模型（primary + more），用于按 value 反查展示名。 */
export function allModels(agent: Agent, opts: ModelMenuOptions = {}): ModelOption[] {
  const c = modelMenuFor(agent, opts)
  return [...c.primary, ...c.more]
}

/** 按 value 找展示名；找不到回退 value 本身（如直接显示某个未列出的 id）。 */
export function modelLabel(
  agent: Agent,
  value: string | undefined,
  opts: ModelMenuOptions = {},
): string {
  if (!value) return ''
  const base = allModels(agent, opts)
  const pool = agent === 'claude' ? [...base, ...claudeKnownModels()] : base
  return pool.find((m) => m.value === value)?.label ?? value
}

/**
 * effort 基础档位（Faster→Smarter 顺序）。Claude：low|medium|high|xhigh|max（= CLI
 * `--effort` 实际接受的全部值，实测无效值会被忽略并回落默认档）；Codex（reasoning
 * effort）：minimal|low|medium|high。空 = 该 agent 无 effort 概念。
 *
 * 注意：这是「基础」档位。某些模型还会多一档（见 effortLevelsFor / ultracode）。
 */
export const CHAT_EFFORT_LEVELS: Record<Agent, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high'],
  gemini: [],
}

/** 多一档「ultracode」的模型（排在 max 之后，仅这些模型显示）。 */
const ULTRACODE_MODELS = new Set(['claude-opus-4-8', 'claude-opus-4-7'])

/**
 * 该 (agent, model) 实际的 effort 档位列表。
 * Opus 4.7 / 4.8 在 `max` 之后追加一档 `ultracode`（对齐 Claude 客户端的滑杆）。
 */
export function effortLevelsFor(agent: Agent, model: string | undefined): string[] {
  const base = CHAT_EFFORT_LEVELS[agent]
  if (agent === 'claude' && model && ULTRACODE_MODELS.has(model)) {
    return [...base, 'ultracode']
  }
  return base
}

export function hasEffortChoice(agent: Agent): boolean {
  return CHAT_EFFORT_LEVELS[agent].length > 0
}

/**
 * 某个模型是否支持 effort（reasoning effort）切换。
 * 规则（对齐 Claude 客户端）：Haiku 系列没有 effort 概念 —— 既不展示滑杆，也不下发 `--effort`。
 */
export function modelSupportsEffort(agent: Agent, model: string | undefined): boolean {
  if (!hasEffortChoice(agent)) return false
  if (model && /haiku/i.test(model)) return false
  return true
}

/**
 * UI 档位 → CLI `--effort` 值的映射。headless CLI 的 effort 上限就是 `max`，没有更高档；
 * `ultracode` 只是客户端在 max 之后多画的一格，这里把它落到真正的天花板 `max`，避免传一个
 * CLI 不认的值被忽略 → 反而回落到默认档（比 max 还低）。其余档位原样透传。
 */
const EFFORT_CLI_VALUE: Record<string, string> = {
  ultracode: 'max',
}

/**
 * 该模型实际下发给 CLI 的 effort：
 *  - 不支持 effort 的模型（Haiku）→ undefined（省掉 `--effort`）；
 *  - `ultracode` → `max`（headless 天花板）；其余原样。
 */
export function effectiveEffort(
  agent: Agent,
  model: string | undefined,
  effort: string | undefined,
): string | undefined {
  if (!modelSupportsEffort(agent, model)) return undefined
  if (!effort) return effort
  return EFFORT_CLI_VALUE[effort] ?? effort
}

/**
 * 模型变更后，若当前 effort 档在新模型下不存在（如从 Opus 4.8 的 `ultracode` 切到 Sonnet），
 * 退到新模型的最高可用档；否则原样保留。
 */
export function fallbackEffort(
  current: string | undefined,
  agent: Agent,
  model: string | undefined,
): string | undefined {
  const levels = effortLevelsFor(agent, model)
  if (!current || levels.includes(current)) return current
  return levels[levels.length - 1]
}

/** 该 agent 的初始模型（= 主列表第一项；无则 undefined）。用户要求「不存在 default model」，
 *  故每个会话都以一个明确模型起步。 */
export function defaultModel(agent: Agent): string | undefined {
  if (agent === 'claude') return undefined
  return modelMenuFor(agent).primary[0]?.value
}

/** 该 agent 的初始 effort（取中高档：claude→high、codex→medium）。同样不留「default」。 */
export function defaultEffort(agent: Agent): string | undefined {
  if (agent === 'claude') return undefined
  const lv = CHAT_EFFORT_LEVELS[agent]
  return lv[2] ?? lv[lv.length - 1]
}

/** effort 档位的展示名（首字母大写，如 high → High、xhigh → Xhigh）。 */
export function effortLabel(level: string | undefined): string {
  if (!level) return ''
  return level.charAt(0).toUpperCase() + level.slice(1)
}

/**
 * 权限模式五档（对齐 Claude Code「Mode」菜单 / `--permission-mode` choices）。
 * 顺序 = Image#8：Ask permissions / Accept edits / Plan mode / Auto mode / Bypass。
 * headless 下需审批的模式（default/auto）会自动拒绝、不挂起（已实测），故全部可放。
 */
export const CHAT_PERMISSION_MODES: { value: string; labelKey: string }[] = [
  { value: 'default', labelKey: 'chat.composer.permission.ask' },
  { value: 'acceptEdits', labelKey: 'chat.composer.permission.acceptEdits' },
  { value: 'plan', labelKey: 'chat.composer.permission.plan' },
  { value: 'auto', labelKey: 'chat.composer.permission.auto' },
  { value: 'bypassPermissions', labelKey: 'chat.composer.permission.bypassPermissions' },
]

/** 权限模式 value → labelKey（找不到回退 acceptEdits）。 */
export function permissionLabelKey(value: string): string {
  return (
    CHAT_PERMISSION_MODES.find((m) => m.value === value)?.labelKey ??
    'chat.composer.permission.acceptEdits'
  )
}

/**
 * 某个权限模式在当前模型下是否不可用。
 * 规则（对齐 Claude Code）：Haiku 不支持 `auto`（自动）权限模式。
 */
export function permissionModeDisabled(value: string, model: string | undefined): boolean {
  return value === 'auto' && !!model && /haiku/i.test(model)
}

/** 模型变更后，若当前权限模式在新模型下不可用，给一个可用的回退（acceptEdits）。 */
export function fallbackPermissionMode(current: string, model: string | undefined): string {
  return permissionModeDisabled(current, model) ? 'acceptEdits' : current
}

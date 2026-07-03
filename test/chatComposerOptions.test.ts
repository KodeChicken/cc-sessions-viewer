import { describe, expect, it } from 'vitest'
import {
  CHAT_PERMISSION_MODES,
  CHAT_MODEL_MENU,
  CLAUDE_ALIAS_MODEL_MENU,
  CHAT_EFFORT_LEVELS,
  hasModelChoice,
  autoPickModel,
  requiresCredits,
  hasEffortChoice,
  effortLevelsFor,
  modelSupportsEffort,
  effectiveEffort,
  fallbackEffort,
  allModels,
  modelLabel,
  modelMenuFor,
  effortLabel,
  defaultModel,
  defaultEffort,
  permissionLabelKey,
  permissionModeDisabled,
  fallbackPermissionMode,
} from '../src/chatComposerOptions'

describe('chatComposerOptions', () => {
  it('权限五档，顺序对齐 Claude Code「Mode」菜单', () => {
    expect(CHAT_PERMISSION_MODES.map((m) => m.value)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'bypassPermissions',
    ])
  })

  it('permissionLabelKey：命中返回对应 key，未知回退 acceptEdits', () => {
    expect(permissionLabelKey('plan')).toBe('chat.composer.permission.plan')
    expect(permissionLabelKey('nope')).toBe('chat.composer.permission.acceptEdits')
  })

  it('Claude / Codex 有模型与 effort 候选；Gemini 暂无', () => {
    expect(hasModelChoice('claude')).toBe(true)
    expect(hasModelChoice('codex')).toBe(true)
    expect(hasModelChoice('gemini')).toBe(false)
    expect(hasEffortChoice('claude')).toBe(true)
    expect(hasEffortChoice('codex')).toBe(true)
    expect(hasEffortChoice('gemini')).toBe(false)
  })

  it('Claude 模型用完整标准 id（主列表 + More），且一律不带 [1m]', () => {
    expect(CHAT_MODEL_MENU.claude.primary.map((m) => m.value)).toEqual([
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ])
    expect(CHAT_MODEL_MENU.claude.more.map((m) => m.value)).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-opus-4-6',
    ])
  })

  it('Claude API-key 菜单改走 alias，让 Claude CLI 自己按 settings.json 做模型映射', () => {
    expect(CLAUDE_ALIAS_MODEL_MENU.primary.map((m) => m.value)).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'fable',
    ])
    expect(modelMenuFor('claude', { claudeAliasMode: true }).primary.map((m) => m.value)).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'fable',
    ])
  })

  it('Claude alias 菜单会把本地映射模型名拼到展示标签上', () => {
    expect(
      modelMenuFor('claude', {
        claudeAliasMode: true,
        claudeAliasTargets: { opus: 'mimo-v2.5-pro' },
      }).primary[0].label,
    ).toBe('Opus (mimo-v2.5-pro)')
  })

  it('autoPickModel：Fable 5 需 credits 不作新会话默认，订阅落到 Opus 4.8，alias 照常取 opus', () => {
    expect(requiresCredits('claude-fable-5')).toBe(true)
    expect(requiresCredits('claude-opus-4-8')).toBe(false)
    // 订阅：primary[0] 是烧额度的 Fable 5 → 跳过 → 第一个不烧额度的 Opus 4.8
    expect(autoPickModel('claude')).toBe('claude-opus-4-8')
    // alias 模式：primary[0] 是 opus 别名（不烧额度）→ 照常返回
    expect(autoPickModel('claude', { claudeAliasMode: true })).toBe('opus')
  })

  it('关键回归：任何下发模型 id 都不含 [1m]（否则会触发 1M-context credits 报错）', () => {
    for (const agent of ['claude', 'codex', 'gemini'] as const) {
      for (const m of allModels(agent)) {
        expect(m.value).not.toContain('[1m]')
      }
    }
    for (const m of allModels('claude', { claudeAliasMode: true })) {
      expect(m.value).not.toContain('[1m]')
    }
  })

  it('Claude effort 五档，Codex reasoning effort 四档', () => {
    expect(CHAT_EFFORT_LEVELS.claude).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(CHAT_EFFORT_LEVELS.codex).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('候选 value 仅 [A-Za-z0-9._-]（与后端 valid_flag_token 对齐，可被 posix_quote 安全转义）', () => {
    const c = CHAT_MODEL_MENU.claude
    const vals = [
      ...c.unavailable,
      ...c.primary,
      ...c.more,
      ...CHAT_MODEL_MENU.codex.primary,
      ...CHAT_MODEL_MENU.codex.more,
    ].map((o) => o.value)
    for (const v of [...vals, ...CHAT_EFFORT_LEVELS.claude, ...CHAT_EFFORT_LEVELS.codex]) {
      expect(v).toMatch(/^[A-Za-z0-9._-]+$/)
    }
  })

  it('modelLabel / effortLabel：命中返回展示名，未知回退原值', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8')
    expect(modelLabel('claude', 'claude-opus-4-7')).toBe('Opus 4.7')
    expect(modelLabel('claude', 'opus')).toBe('Opus')
    expect(modelLabel('claude', 'haiku')).toBe('Haiku')
    expect(modelLabel('claude', 'sonnet', { claudeAliasMode: true })).toBe('Sonnet')
    expect(modelLabel('claude', undefined)).toBe('')
    expect(modelLabel('claude', 'weird-id')).toBe('weird-id')
    expect(effortLabel('high')).toBe('High')
    expect(effortLabel(undefined)).toBe('')
  })

  it('effortLabel：各档首字母大写（xhigh → Xhigh、ultracode → Ultracode）', () => {
    expect(effortLabel('xhigh')).toBe('Xhigh')
    expect(effortLabel('ultracode')).toBe('Ultracode')
    expect(effortLabel('max')).toBe('Max')
    expect(effortLabel('low')).toBe('Low')
  })

  it('effortLevelsFor：Fable 5 / Opus 4.7 / 4.8 在 max 后多一档 ultracode，其余模型只有基础五档', () => {
    const base = ['low', 'medium', 'high', 'xhigh', 'max']
    expect(effortLevelsFor('claude', 'claude-fable-5')).toEqual([...base, 'ultracode'])
    expect(effortLevelsFor('claude', 'claude-opus-4-8')).toEqual([...base, 'ultracode'])
    expect(effortLevelsFor('claude', 'claude-opus-4-7')).toEqual([...base, 'ultracode'])
    expect(effortLevelsFor('claude', 'claude-opus-4-6')).toEqual(base)
    expect(effortLevelsFor('claude', 'claude-sonnet-5')).toEqual(base)
    expect(effortLevelsFor('claude', undefined)).toEqual(base)
    expect(effortLevelsFor('codex', 'gpt-5.4')).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('modelSupportsEffort：Haiku 无 effort；Opus/Sonnet 有；Gemini agent 一律无', () => {
    expect(modelSupportsEffort('claude', 'claude-opus-4-8')).toBe(true)
    expect(modelSupportsEffort('claude', 'claude-sonnet-5')).toBe(true)
    expect(modelSupportsEffort('claude', 'claude-haiku-4-5-20251001')).toBe(false)
    // 未指定模型时按「支持」处理（滑杆默认展示）。
    expect(modelSupportsEffort('claude', undefined)).toBe(true)
    // agent 本身无 effort 概念则恒 false，与模型无关。
    expect(modelSupportsEffort('gemini', 'whatever')).toBe(false)
  })

  it('effectiveEffort：Haiku 抹掉 effort；ultracode 落到 max（headless 天花板）；其余透传', () => {
    expect(effectiveEffort('claude', 'claude-opus-4-8', 'high')).toBe('high')
    expect(effectiveEffort('claude', 'claude-opus-4-8', 'ultracode')).toBe('max')
    expect(effectiveEffort('claude', 'claude-haiku-4-5-20251001', 'high')).toBeUndefined()
    expect(effectiveEffort('gemini', 'whatever', 'high')).toBeUndefined()
  })

  it('fallbackEffort：切到不支持当前档的模型 → 退最高可用档；否则原样', () => {
    // 4.8 的 ultracode 切到 Sonnet（无 ultracode）→ 退到 max。
    expect(fallbackEffort('ultracode', 'claude', 'claude-sonnet-5')).toBe('max')
    // 档位在新模型下仍存在 → 原样。
    expect(fallbackEffort('high', 'claude', 'claude-opus-4-8')).toBe('high')
    expect(fallbackEffort('ultracode', 'claude', 'claude-opus-4-7')).toBe('ultracode')
    expect(fallbackEffort(undefined, 'claude', 'claude-sonnet-5')).toBeUndefined()
  })

  it('Haiku 不支持 auto 权限模式；其它模型不受限', () => {
    expect(permissionModeDisabled('auto', 'claude-haiku-4-5-20251001')).toBe(true)
    expect(permissionModeDisabled('auto', 'claude-opus-4-8')).toBe(false)
    expect(permissionModeDisabled('auto', 'claude-sonnet-5')).toBe(false)
    expect(permissionModeDisabled('acceptEdits', 'claude-haiku-4-5-20251001')).toBe(false)
    expect(permissionModeDisabled('auto', undefined)).toBe(false)
  })

  it('fallbackPermissionMode：Haiku+auto → acceptEdits，其余原样返回', () => {
    expect(fallbackPermissionMode('auto', 'claude-haiku-4-5-20251001')).toBe('acceptEdits')
    expect(fallbackPermissionMode('auto', 'claude-opus-4-8')).toBe('auto')
    expect(fallbackPermissionMode('plan', 'claude-haiku-4-5-20251001')).toBe('plan')
  })

  it('defaultModel / defaultEffort：明确起步值（无 "default" 概念）', () => {
    expect(defaultModel('claude')).toBeUndefined()
    expect(defaultModel('codex')).toBe('gpt-5.4')
    expect(defaultModel('gemini')).toBeUndefined()
    expect(defaultEffort('claude')).toBeUndefined()
    expect(defaultEffort('codex')).toBe('medium')
    expect(defaultEffort('gemini')).toBeUndefined()
  })
})

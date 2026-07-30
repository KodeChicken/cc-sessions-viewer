import { describe, expect, it } from 'vitest'
import {
  readChatGuiPreference,
  rememberedChatEffort,
  rememberedChatModel,
  rememberedChatPermissionMode,
  rememberChatGuiPreference,
} from '../src/chatGuiPreferences'

describe('chatGuiPreferences', () => {
  it('persists the last GUI chat permission, model, and effort by agent', () => {
    rememberChatGuiPreference('codex', {
      permissionMode: 'plan',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
    })

    expect(readChatGuiPreference('codex')).toEqual({
      permissionMode: 'plan',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
    })
    expect(rememberedChatPermissionMode('codex')).toBe('plan')
    expect(rememberedChatModel('codex')).toBe('gpt-5.6-sol')
    expect(rememberedChatEffort('codex', 'gpt-5.6-sol')).toBe('ultra')
  })

  it('falls back to safe defaults when stored values are invalid', () => {
    localStorage.setItem('chatGuiPrefs:v1', JSON.stringify({
      codex: {
        permissionMode: 'bypassPermissions',
        model: 'missing-model',
        effort: 'ultra',
      },
    }))

    expect(readChatGuiPreference('codex')).toEqual({
      model: 'gpt-5.5',
    })
    expect(rememberedChatPermissionMode('codex')).toBe('fullAccess')
    expect(rememberedChatEffort('codex', 'gpt-5.5')).toBeUndefined()
  })
})

import type { Agent } from './types'
import {
  chatSupported,
  defaultEffort,
  defaultPermissionMode,
  effortLevelsFor,
  permissionModesFor,
  sanitizeModel,
} from './chatComposerOptions'

const KEY = 'chatGuiPrefs:v1'

export interface ChatGuiPreference {
  permissionMode?: string
  model?: string
  effort?: string
}

type StoredPrefs = Partial<Record<Agent, ChatGuiPreference>>

function readAll(): StoredPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as StoredPrefs) : {}
  } catch {
    return {}
  }
}

function writeAll(prefs: StoredPrefs) {
  localStorage.setItem(KEY, JSON.stringify(prefs))
}

function validPermissionMode(agent: Agent, value: unknown): value is string {
  return typeof value === 'string' && permissionModesFor(agent).some((m) => m.value === value)
}

function validEffort(agent: Agent, value: unknown, model: string | undefined): value is string {
  return typeof value === 'string' && effortLevelsFor(agent, model).includes(value)
}

function normalize(agent: Agent, pref: ChatGuiPreference | undefined): ChatGuiPreference {
  if (!chatSupported(agent) || !pref) return {}
  const out: ChatGuiPreference = {}
  if (validPermissionMode(agent, pref.permissionMode)) out.permissionMode = pref.permissionMode
  if (typeof pref.model === 'string' && pref.model.trim()) out.model = sanitizeModel(agent, pref.model)
  if (validEffort(agent, pref.effort, out.model)) out.effort = pref.effort
  return out
}

export function readChatGuiPreference(agent: Agent): ChatGuiPreference {
  return normalize(agent, readAll()[agent])
}

export function rememberedChatPermissionMode(agent: Agent): string {
  return readChatGuiPreference(agent).permissionMode ?? defaultPermissionMode(agent)
}

export function rememberedChatModel(agent: Agent): string | undefined {
  return readChatGuiPreference(agent).model
}

export function rememberedChatEffort(agent: Agent, model: string | undefined): string | undefined {
  const pref = readChatGuiPreference(agent)
  if (validEffort(agent, pref.effort, model ?? pref.model)) return pref.effort
  return undefined
}

export function rememberChatGuiPreference(agent: Agent, patch: ChatGuiPreference) {
  if (!chatSupported(agent)) return
  const prefs = readAll()
  const next = normalize(agent, { ...readChatGuiPreference(agent), ...patch })
  prefs[agent] = next
  writeAll(prefs)
}

export function defaultChatGuiEffort(agent: Agent, model: string | undefined): string | undefined {
  return rememberedChatEffort(agent, model) ?? defaultEffort(agent)
}

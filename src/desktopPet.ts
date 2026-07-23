import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { emitTo } from '@tauri-apps/api/event'

export type DesktopPetCharacter = 'momo' | 'lumi' | 'kumo'

export const DESKTOP_PET_CHARACTERS: DesktopPetCharacter[] = ['momo', 'lumi', 'kumo']

const ENABLED_KEY = 'desktopPetEnabled:v1'
const CHARACTER_KEY = 'desktopPetCharacter:v1'

function readCharacter(): DesktopPetCharacter {
  const value = localStorage.getItem(CHARACTER_KEY)
  return DESKTOP_PET_CHARACTERS.includes(value as DesktopPetCharacter)
    ? (value as DesktopPetCharacter)
    : 'momo'
}

export const desktopPetEnabled = ref(localStorage.getItem(ENABLED_KEY) === '1')
export const desktopPetCharacter = ref<DesktopPetCharacter>(readCharacter())

export type DesktopTaskState = 'started' | 'blocked' | 'completed' | 'failed'

export interface DesktopTask {
  agent: string
  path: string
  state: DesktopTaskState
  title: string
  updatedAt: number
}

export type DesktopTaskGroups = Record<DesktopTaskState, DesktopTask[]>

export function groupDesktopTasks(tasks: DesktopTask[]): DesktopTaskGroups {
  const groups: DesktopTaskGroups = {
    started: [],
    blocked: [],
    completed: [],
    failed: [],
  }
  for (const task of tasks) {
    if (groups[task.state]) groups[task.state].push(task)
  }
  return groups
}

export function setDesktopPetEnabled(enabled: boolean) {
  desktopPetEnabled.value = enabled
  localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0')
}

export function setDesktopPetCharacter(character: DesktopPetCharacter) {
  desktopPetCharacter.value = character
  localStorage.setItem(CHARACTER_KEY, character)
}

export const fetchDesktopPetTasks = () => invoke<DesktopTask[]>('desktop_pet_tasks')

export const updateDesktopPetWindow = (enabled: boolean) =>
  invoke<void>('set_desktop_pet_enabled', { enabled })

export async function syncDesktopPetWithHooks(hooksEnabled: boolean) {
  if (!hooksEnabled) {
    if (!desktopPetEnabled.value) return
    setDesktopPetEnabled(false)
    await updateDesktopPetWindow(false)
    return
  }
  if (desktopPetEnabled.value) await updateDesktopPetWindow(true)
}

export const openDesktopPetSession = (task: Pick<DesktopTask, 'agent' | 'path' | 'title'>) =>
  invoke<void>('open_desktop_pet_session', {
    agent: task.agent,
    path: task.path,
    title: task.title,
  })

export async function notifyDesktopPetCharacter(character: DesktopPetCharacter) {
  setDesktopPetCharacter(character)
  try {
    await emitTo('desktop-pet', 'desktop-pet://character', { character })
  } catch {
    // The pet window is optional; no listener exists while it is disabled.
  }
}

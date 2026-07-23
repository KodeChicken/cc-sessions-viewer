import { ref } from 'vue'
import * as api from './api'
import type { TurnHookStatus } from './api'

export const turnHookStatus = ref<TurnHookStatus | null>(null)
export const turnHookStatusLoading = ref(false)
export const turnHookStatusError = ref('')

export async function refreshTurnHookStatus() {
  if (turnHookStatusLoading.value) return
  turnHookStatusLoading.value = true
  turnHookStatusError.value = ''
  try {
    turnHookStatus.value = await api.turnHookStatus()
  } catch (e) {
    turnHookStatusError.value = String(e)
  } finally {
    turnHookStatusLoading.value = false
  }
}

import { reactive } from 'vue'

const refreshVersions = reactive(new Map<string, number>())

/** 通知同一仓库中正在查看 working diff 的视图重新拉取文件和内容。 */
export function refreshGitWorkingChanges(cwd: string) {
  refreshVersions.set(cwd, (refreshVersions.get(cwd) ?? 0) + 1)
}

export function gitWorkingChangesRefreshVersion(cwd: string): number {
  return refreshVersions.get(cwd) ?? 0
}

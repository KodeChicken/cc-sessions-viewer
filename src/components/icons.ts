// 统一图标层：所有图标改用 Iconify（lucide 集合）按需打包，编译期内联 SVG，
// 运行时不联网（Tauri 离线友好）。如需替换图标，直接换 import 路径即可：
//   import IconFoo from '~icons/lucide/foo-name'
// 浏览所有可用图标：https://iconify.design/

import IconPinUpRaw from '~icons/lucide/arrow-up-to-line'
import IconPinDownRaw from '~icons/lucide/arrow-down-to-line'
import IconTrashRaw from '~icons/lucide/trash-2'
import IconTrashOpenRaw from '~icons/quill/folder-trash'
import IconRestoreRaw from '~icons/lucide/archive-restore'
import IconSettingsRaw from '~icons/lucide/settings'
import IconPlayRaw from '~icons/lucide/play'
import IconChatRaw from '~icons/lucide/message-circle'
import IconFolderRaw from '~icons/lucide/folder'
import IconInboxRaw from '~icons/lucide/inbox'
import IconRefreshRaw from '~icons/lucide/rotate-cw'
import IconArrowLeftRaw from '~icons/lucide/arrow-left'
import IconArrowUpRaw from '~icons/lucide/arrow-up'
import IconArrowDownRaw from '~icons/lucide/arrow-down'
import IconChevronRightRaw from '~icons/lucide/chevron-right'
import IconEmptyBoxRaw from '~icons/lucide/package'
import IconPointLeftRaw from '~icons/lucide/chevron-left'
import IconSidebarRaw from '~icons/lucide/panel-left'
import IconCloseRaw from '~icons/lucide/x'
import IconSunRaw from '~icons/lucide/sun'
import IconMoonRaw from '~icons/lucide/moon'
import IconMonitorRaw from '~icons/lucide/monitor'
import IconLanguagesRaw from '~icons/lucide/languages'
import IconDatabaseRaw from '~icons/lucide/database'
import IconInfoRaw from '~icons/lucide/info'
import IconPaletteRaw from '~icons/lucide/palette'
import IconCheckRaw from '~icons/lucide/check'
import IconPencilRaw from '~icons/lucide/pencil'
import IconCopyRaw from '~icons/lucide/copy'
import IconSearchRaw from '~icons/lucide/search'
import IconChevronUpRaw from '~icons/lucide/chevron-up'
import IconChevronDownRaw from '~icons/lucide/chevron-down'
import IconFoldRaw from '~icons/lucide/chevrons-down-up'
import IconUnfoldRaw from '~icons/lucide/chevrons-up-down'
import IconDownloadRaw from '~icons/lucide/download'
import IconMarkdownRaw from '~icons/lucide/file-text'
import IconHtmlRaw from '~icons/lucide/file-code'
import IconJsonRaw from '~icons/lucide/braces'
import IconSortRaw from '~icons/lucide/arrow-down-up'
import IconSelectRaw from '~icons/lucide/list-checks'
import IconPlusRaw from '~icons/lucide/plus'
import IconHistoryRaw from '~icons/lucide/history'
import IconExportHistoryRaw from '~icons/lucide/clock-arrow-down'
import IconMoreRaw from '~icons/lucide/more-horizontal'
import IconPriceTagRaw from '~icons/lucide/circle-dollar-sign'
import IconGithubRaw from '~icons/lucide/github'
import IconCornerDownLeftRaw from '~icons/lucide/corner-down-left'
import IconChartRaw from '~icons/lucide/bar-chart-3'
import IconListRaw from '~icons/lucide/list'
import IconWalletRaw from '~icons/lucide/wallet'
import IconActivityRaw from '~icons/lucide/activity'
import IconLayersRaw from '~icons/lucide/layers'
import IconZapRaw from '~icons/lucide/zap'
import IconExternalLinkRaw from '~icons/lucide/external-link'
import IconArchiveRaw from '~icons/lucide/archive'
import IconShieldCheckRaw from '~icons/lucide/shield-check'
import IconTerminalRaw from '~icons/lucide/terminal'
import IconClaudeRaw from '~icons/material-icon-theme/claude'
import IconGeminiRaw from '~icons/material-icon-theme/gemini-ai'

export const IconPinUp = IconPinUpRaw
export const IconPinDown = IconPinDownRaw
export const IconTrash = IconTrashRaw
export const IconTrashOpen = IconTrashOpenRaw
export const IconRestore = IconRestoreRaw
export const IconSettings = IconSettingsRaw
export const IconPlay = IconPlayRaw
export const IconChat = IconChatRaw
export const IconFolder = IconFolderRaw
export const IconInbox = IconInboxRaw
export const IconRefresh = IconRefreshRaw
export const IconArrowLeft = IconArrowLeftRaw
export const IconArrowUp = IconArrowUpRaw
export const IconArrowDown = IconArrowDownRaw
export const IconChevronRight = IconChevronRightRaw
export const IconEmptyBox = IconEmptyBoxRaw
export const IconPointLeft = IconPointLeftRaw
export const IconSidebar = IconSidebarRaw
export const IconClose = IconCloseRaw
export const IconSun = IconSunRaw
export const IconMoon = IconMoonRaw
export const IconMonitor = IconMonitorRaw
export const IconLanguages = IconLanguagesRaw
export const IconDatabase = IconDatabaseRaw
export const IconInfo = IconInfoRaw
export const IconPalette = IconPaletteRaw
export const IconCheck = IconCheckRaw
export const IconPencil = IconPencilRaw
export const IconCopy = IconCopyRaw
export const IconSearch = IconSearchRaw
export const IconChevronUp = IconChevronUpRaw
export const IconChevronDown = IconChevronDownRaw
export const IconFold = IconFoldRaw
export const IconUnfold = IconUnfoldRaw
export const IconDownload = IconDownloadRaw
export const IconMarkdown = IconMarkdownRaw
export const IconHtml = IconHtmlRaw
export const IconJson = IconJsonRaw
export const IconSort = IconSortRaw
export const IconSelect = IconSelectRaw
export const IconPlus = IconPlusRaw
export const IconHistory = IconHistoryRaw
export const IconExportHistory = IconExportHistoryRaw
export const IconMore = IconMoreRaw
export const IconPriceTag = IconPriceTagRaw
export const IconGithub = IconGithubRaw
export const IconCornerDownLeft = IconCornerDownLeftRaw
export const IconChart = IconChartRaw
export const IconList = IconListRaw
export const IconWallet = IconWalletRaw
export const IconActivity = IconActivityRaw
export const IconLayers = IconLayersRaw
export const IconZap = IconZapRaw
export const IconExternalLink = IconExternalLinkRaw
export const IconArchive = IconArchiveRaw
export const IconShieldCheck = IconShieldCheckRaw
export const IconTerminal = IconTerminalRaw
// 「已 pin」状态的小圆点指示器；6×6 实心圆，自己拼比拉一整个集合便宜。
import { defineComponent, h, type Component } from 'vue'
import type { Agent } from '../types'
export const IconPinFilled = defineComponent({
  name: 'IconPinFilled',
  setup() {
    return () =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'currentColor',
          'aria-hidden': 'true',
        },
        [h('circle', { cx: 12, cy: 12, r: 6 })],
      )
  },
})

// Codex brand mark — single path with a built-in linear gradient (purple → blue).
// Inlined as a render function so we don't pull in vite-svg-loader for one icon;
// the gradient id is namespaced (`codexLogoGrad`) to avoid clashing if multiple
// instances mount in the same page.
const CODEX_PATH =
  'm84.3 5.1q3.7-1.5 7.7-2.6 3.9-1 7.9-1.6 4-0.5 8.1-0.6 4 0 8 0.5 20.7 2.4 37.1 17.7 0.1 0.1 0.4 0.3 0.1 0 0.2 0 0 0 0.2 0 0 0 0.1 0 0 0 0.1 0 5.2-1.4 10.7-1.9 5.4-0.4 10.7 0.1 5.5 0.4 10.7 1.9 5.2 1.3 10.1 3.6l0.6 0.4 1.6 0.8q5.2 2.5 9.7 6.1 4.7 3.4 8.6 7.7 3.8 4.3 6.9 9.2 3 4.8 5.2 10.2 4.3 10.5 4.3 22.1 0.2 2.1 0 4.2-0.1 2.2-0.2 4.3-0.3 2.1-0.7 4.3-0.4 2.1-0.9 4.1 0 0.2 0 0.4 0 0.2 0 0.5 0 0.1 0.1 0.4 0.1 0.1 0.3 0.3 12.3 12.6 16.3 30 6 29.7-12.2 53.5l-1.9 2.2q-3 3.5-6.5 6.4-3.4 3.1-7.3 5.5-3.8 2.4-8.1 4.2-4.1 1.9-8.5 3.2-0.3 0-0.4 0.2-0.3 0-0.4 0.1-0.1 0.1-0.3 0.4 0 0.1-0.1 0.3c-2.7 7.7-5.3 14.2-10.2 20.7-12.5 16.5-30.8 25.5-51.5 25.5q-24.6-0.1-43.6-18.1-0.2-0.1-0.4-0.2-0.2-0.1-0.4-0.1-0.2 0-0.3 0-0.3 0-0.4 0c-5.4 1.7-10.9 1.9-16.7 1.9q-3.5 0-7-0.5-3.4-0.4-6.9-1.2-3.3-0.8-6.6-2-3.3-1.2-6.4-2.8-3.3-1.6-6.4-3.6-3-2-5.8-4.3-3-2.3-5.5-5-2.5-2.6-4.6-5.6c-2.2-2.7-4.3-5.4-5.8-8.5q-0.8-1.6-1.6-3.2-0.6-1.7-1.3-3.3-0.7-1.7-1.2-3.4-0.5-1.6-1-3.4-1.1-4-1.6-7.9-0.6-4-0.6-8 0-4 0.6-8 0.4-4 1.4-8 0 0 0-0.1 0-0.1 0-0.1 0.2-0.2 0.2-0.3 0-0.1-0.2-0.1 0-0.2 0-0.3 0-0.1-0.1-0.1 0-0.2 0-0.2-0.1-0.1-0.1-0.1-2.4-2.5-4.6-5.2-2.1-2.7-4-5.4-1.7-3-3.2-6-1.5-3.1-2.6-6.3-0.8-2-1.3-4.1-0.7-2-1.1-4-0.4-2.1-0.7-4.2-0.2-2.2-0.4-4.3-0.2-2.8-0.1-5.6 0-2.8 0.3-5.4 0.1-2.8 0.6-5.6 0.4-2.8 1.1-5.5 7-23.1 26.9-36.3 4.3-2.9 8.2-4.5 4.5-1.9 9-3.2 0.2 0 0.3-0.1 0.1-0.2 0.3-0.3 0.1 0 0.1-0.3 0.1-0.1 0.1-0.2 1-3.1 2.2-6 1-2.9 2.5-5.7 1.5-3 3.2-5.6 1.7-2.7 3.7-5.1 2.5-3.2 5.3-5.9 3-2.8 6.1-5.4 3.2-2.4 6.8-4.4 3.5-2 7.2-3.5zm48.3 146.4c-2.3 0.1-4.4 1-6 2.8-1.5 1.6-2.4 3.7-2.4 5.9 0 2.3 0.9 4.4 2.4 6.2 1.6 1.6 3.7 2.5 6 2.6h50.4c2.4 0.1 4.8-0.6 6.5-2.4 1.7-1.6 2.8-4 2.8-6.4 0-2.4-1.1-4.7-2.8-6.3-1.7-1.8-4.1-2.6-6.5-2.4zm-56.7-64.9c-1.2-1.9-3-3.4-5.3-3.9-2.2-0.5-4.5-0.3-6.5 0.9-2 1.1-3.5 3-4.1 5.2-0.7 2.2-0.4 4.6 0.6 6.5l17.7 30.9-17.5 29.5c-1.2 2-1.6 4.5-1.1 6.8 0.7 2.3 2.1 4.1 4.1 5.3 2 1.2 4.4 1.6 6.7 0.9 2.2-0.5 4.2-1.9 5.4-3.9l20.1-34.1q0.7-0.9 0.9-2.1 0.3-1.1 0.3-2.3 0-1.2-0.3-2.2-0.2-1.2-0.8-2.2z'
const IconCodexRaw = defineComponent({
  name: 'IconCodex',
  setup() {
    return () =>
      h(
        'svg',
        {
          viewBox: '0 0 250 250',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          class: 'iconify',
        },
        [
          h('defs', null, [
            h(
              'linearGradient',
              {
                id: 'codexLogoGrad',
                gradientUnits: 'userSpaceOnUse',
                x1: 125,
                y1: 0.332,
                x2: 125,
                y2: 249.667,
              },
              [
                h('stop', { 'stop-color': '#b1a7ff' }),
                h('stop', { offset: '.5', 'stop-color': '#7a9dff' }),
                h('stop', { offset: '1', 'stop-color': '#3941ff' }),
              ],
            ),
          ]),
          h('path', { fill: 'url(#codexLogoGrad)', d: CODEX_PATH }),
        ],
      )
  },
})

// Brand marks for the two agents, pulled from iconify at build time so
// runtime stays offline-friendly. Sources: `material-icon-theme:claude`,
// our own `assets/codex.svg`, and `material-icon-theme:gemini-ai`.
// Re-exported individually for direct use and aggregated into `agentIcons`
// for dispatch-by-agent.
export const IconClaude = IconClaudeRaw
export const IconCodex = IconCodexRaw
export const IconGemini = IconGeminiRaw

/**
 * Global dictionary of agent → brand-mark icon component. Use as
 * `<component :is="agentIcons[agent]" />` so consumers don't have to
 * branch on the agent name themselves. Keep additions to this map in
 * sync with `Agent` in `src/types.ts`.
 */
export const agentIcons: Record<Agent, Component> = {
  claude: IconClaudeRaw,
  codex: IconCodexRaw,
  gemini: IconGeminiRaw,
}

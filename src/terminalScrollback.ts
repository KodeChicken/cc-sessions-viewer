import type { Terminal } from '@xterm/xterm'
import type { Agent } from './types'

type CsiParams = (number | number[])[]

function shouldConsumeEraseInDisplay(
  agent: Agent,
  isShell: boolean,
  params: CsiParams,
): boolean {
  return agent === 'codex' && !isShell && params[0] === 3
}

export function installTerminalScrollbackProtection(
  term: Terminal,
  agent: Agent,
  isShell: boolean,
): void {
  term.parser.registerCsiHandler(
    { final: 'J' },
    (params) => shouldConsumeEraseInDisplay(agent, isShell, params),
  )
}

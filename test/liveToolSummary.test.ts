import { describe, expect, it } from 'vitest'
import { summarizeTool } from '../src/liveToolSummary'

describe('live tool summary', () => {
  it('classifies shell search commands and keeps the command plus short target', () => {
    expect(
      summarizeTool(
        'shell',
        JSON.stringify({ command: 'rg -n "toolActivity" src/views/ChatView.vue' }),
      ),
    ).toEqual({
      kind: 'search',
      target: 'src/views/ChatView.vue',
      command: 'rg -n "toolActivity" src/views/ChatView.vue',
    })
  })

  it('classifies frontend builds and tests while retaining command text', () => {
    expect(summarizeTool('shell', 'npm run build')).toEqual({ kind: 'buildFrontend', command: 'npm run build' })
    expect(summarizeTool('Bash', JSON.stringify({ command: 'npm test -- --runInBand' }))).toEqual({
      kind: 'test',
      command: 'npm test -- --runInBand',
    })
  })

  it('keeps the full command for generic shell activity', () => {
    expect(summarizeTool('Bash', JSON.stringify({ command: 'pwd && git status --short' }))).toEqual({
      kind: 'git',
      command: 'pwd && git status --short',
    })
  })

  it('uses structured file and read targets for named tools', () => {
    expect(summarizeTool('Read', JSON.stringify({ file_path: '/repo/src/App.vue' }))).toEqual({
      kind: 'read',
      target: '/repo/src/App.vue',
    })
    expect(summarizeTool('apply_patch', undefined, '/repo/src/style.css')).toEqual({
      kind: 'editFile',
      target: '/repo/src/style.css',
    })
  })

  it('falls back to a named tool for unknown protocols', () => {
    expect(summarizeTool('mcp__browser__navigate', '{"url":"https://example.com"}')).toEqual({
      kind: 'callTool',
      target: 'mcp__browser__navigate',
    })
  })
})

import { describe, expect, it } from 'vitest'
import { summarizeTool } from '../src/liveToolSummary'

describe('live tool summary', () => {
  it('classifies shell search commands and keeps only a short target', () => {
    expect(
      summarizeTool(
        'shell',
        JSON.stringify({ command: 'rg -n "toolActivity" src/views/ChatView.vue' }),
      ),
    ).toEqual({ kind: 'search', target: 'src/views/ChatView.vue' })
  })

  it('classifies frontend builds and tests without echoing command text', () => {
    expect(summarizeTool('shell', 'npm run build')).toEqual({ kind: 'buildFrontend' })
    expect(summarizeTool('Bash', JSON.stringify({ command: 'npm test -- --runInBand' }))).toEqual({ kind: 'test' })
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

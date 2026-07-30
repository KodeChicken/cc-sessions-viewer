import { describe, expect, it } from 'vitest'
import {
  codexPluginLinkForUri,
  codexPluginMentionRanges,
  codexPluginMentionTextElements,
  expandCodexPluginMentionsForPrompt,
  highlightCodexPluginMentionHtmlText,
  renderCodexPluginMentionHtmlText,
} from '../src/codexPluginMentions'

describe('codexPluginMentions', () => {
  it('finds plugin mention ranges with multi-word plugin names', () => {
    const ranges = codexPluginMentionRanges('use @Template Creator for this')
    expect(ranges).toHaveLength(1)
    expect(ranges[0]).toMatchObject({ start: 4, end: 21 })
    expect(ranges[0].plugin.name).toBe('Template Creator')
  })

  it('highlights plugin mentions in text nodes without touching tags', () => {
    const html = '<div class="text-run">@Computer 打开trae <a href="@Chrome">x</a></div>'
    const highlighted = highlightCodexPluginMentionHtmlText(html)
    expect(highlighted).toContain('<span class="cmd-name codex-plugin-name"')
    expect(highlighted).toContain('>@Computer</span> 打开trae')
    expect(highlighted).toContain('href="@Chrome"')
  })

  it('renders short plugin mentions as display tokens without touching tags', () => {
    const html = '<div class="text-run">@Chrome 打开bing.com <a href="@PDF">x</a></div>'
    const rendered = renderCodexPluginMentionHtmlText(html)
    expect(rendered).toContain('class="codex-plugin-ref cmd-name"')
    expect(rendered).toContain('codex-plugin-ref-ic--chrome')
    expect(rendered).toContain('<span class="codex-plugin-ref-name">Chrome</span>')
    expect(rendered).toContain('</span> 打开bing.com')
    expect(rendered).toContain('href="@PDF"')
    expect(rendered).not.toContain('>@Chrome</span> 打开bing.com')
  })

  it('expands short mentions to Codex plugin markdown links for prompts', () => {
    expect(expandCodexPluginMentionsForPrompt('@Computer 打开todesk')).toBe(
      '[@Computer](plugin://computer-use@openai-bundled) 打开todesk',
    )
    expect(expandCodexPluginMentionsForPrompt('@Chrome 打开bing.com')).toBe(
      '[@Chrome](plugin://chrome@openai-bundled) 打开bing.com',
    )
    expect(expandCodexPluginMentionsForPrompt('@PDF xxx')).toBe(
      '[@pdf](plugin://pdf@openai-primary-runtime) xxx',
    )
    expect(expandCodexPluginMentionsForPrompt('@Visualize xxx')).toBe(
      '[@visualize](plugin://visualize@openai-bundled) xxx',
    )
    expect(expandCodexPluginMentionsForPrompt('@Template Creator xxx')).toBe(
      '[@template-creator](plugin://template-creator@openai-primary-runtime) xxx',
    )
  })

  it('builds structured Codex app-server plugin mention elements with UTF-8 byte ranges', () => {
    expect(codexPluginMentionTextElements('@Chrome 打开bing.com')).toEqual([
      {
        type: 'mention',
        byteRange: { start: 0, end: 7 },
        path: 'plugin://chrome@openai-bundled',
        name: 'Chrome',
        placeholder: '@Chrome',
      },
    ])
    expect(codexPluginMentionTextElements('请 @Chrome 打开', 5)[0]).toMatchObject({
      byteRange: { start: 9, end: 16 },
      path: 'plugin://chrome@openai-bundled',
    })
  })

  it('does not double-expand existing Codex plugin markdown links', () => {
    const raw = '[@Computer](plugin://computer-use@openai-bundled) 打开todesk'
    expect(expandCodexPluginMentionsForPrompt(raw)).toBe(raw)
  })

  it('recognizes plugin file-block fallbacks from older parsing', () => {
    expect(codexPluginLinkForUri('visualize@openai-bundled')?.name).toBe('Visualize')
    expect(codexPluginLinkForUri('visualize](plugin://visualize@openai-bundled)')?.name).toBe('Visualize')
  })
})

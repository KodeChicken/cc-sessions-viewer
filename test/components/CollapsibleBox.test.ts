import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CollapsibleBox from '../../src/components/CollapsibleBox.vue'
import { setLang } from '../../src/settings'

beforeEach(() => setLang('en'))

const slot = '<div class="payload">content</div>'

describe('CollapsibleBox', () => {
  it('renders the slot directly when disabled', () => {
    const wrapper = mount(CollapsibleBox, {
      props: { enabled: false },
      slots: { default: slot },
    })
    expect(wrapper.find('.payload').exists()).toBe(true)
    expect(wrapper.find('.collapsible-box').exists()).toBe(false)
  })

  it('wraps the slot in a collapsible box when enabled', () => {
    const wrapper = mount(CollapsibleBox, { slots: { default: slot } })
    expect(wrapper.find('.collapsible-box').exists()).toBe(true)
    expect(wrapper.find('.collapsible-inner .payload').exists()).toBe(true)
  })

  it('shows no toggle when the content fits within maxHeight', async () => {
    const wrapper = mount(CollapsibleBox, { slots: { default: slot } })
    await flushPromises()
    expect(wrapper.find('.collapsible-toggle').exists()).toBe(false)
  })

  it('falls back to rendering the slot directly when disabled at runtime', async () => {
    const wrapper = mount(CollapsibleBox, {
      props: { enabled: true },
      slots: { default: slot },
    })
    expect(wrapper.find('.collapsible-box').exists()).toBe(true)
    await wrapper.setProps({ enabled: false })
    expect(wrapper.find('.collapsible-box').exists()).toBe(false)
    expect(wrapper.find('.payload').exists()).toBe(true)
  })

  it('unmounts cleanly (disconnecting its ResizeObserver)', () => {
    const wrapper = mount(CollapsibleBox, { slots: { default: slot } })
    expect(() => wrapper.unmount()).not.toThrow()
  })

  describe('scroll container behavior', () => {
    it('caps the box height and keeps content scrollable without a toggle', async () => {
      const wrapper = mount(CollapsibleBox, {
        props: { maxHeight: 100 },
        slots: { default: slot },
      })
      await flushPromises()

      const box = wrapper.find('.collapsible-box')
      expect(box.attributes('style')).toContain('max-height: 100px')
      expect(wrapper.find('.collapsible-toggle').exists()).toBe(false)
      expect(box.classes()).not.toContain('collapsed')
    })
  })
})

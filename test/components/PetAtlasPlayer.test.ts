import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import PetAtlasPlayer from '../../src/components/PetAtlasPlayer.vue'

afterEach(() => vi.useRealTimers())

describe('PetAtlasPlayer', () => {
  it('loops idle with Codex slow-idle timing', async () => {
    vi.useFakeTimers()
    const wrapper = mount(PetAtlasPlayer, {
      props: { src: 'asset://pet.webp', state: 'idle' },
    })

    expect(wrapper.attributes('data-row')).toBe('0')
    expect(wrapper.attributes('data-frame')).toBe('0')
    await vi.advanceTimersByTimeAsync(1679)
    expect(wrapper.attributes('data-frame')).toBe('0')
    await vi.advanceTimersByTimeAsync(1)
    expect(wrapper.attributes('data-frame')).toBe('1')
    wrapper.unmount()
  })

  it('plays a transient row three times and then loops slow idle', async () => {
    vi.useFakeTimers()
    const wrapper = mount(PetAtlasPlayer, {
      props: { src: 'asset://pet.webp', state: 'jumping' },
    })

    expect(wrapper.attributes('data-row')).toBe('4')
    await vi.advanceTimersByTimeAsync(2520)
    expect(wrapper.attributes('data-row')).toBe('0')
    expect(wrapper.attributes('data-frame')).toBe('0')
    await vi.advanceTimersByTimeAsync(1680)
    expect(wrapper.attributes('data-frame')).toBe('1')
    wrapper.unmount()
  })

  it('maps all sixteen v2 look frames across the final two rows', async () => {
    const wrapper = mount(PetAtlasPlayer, {
      props: { src: 'asset://pet.webp', state: 'idle', lookFrame: 15, spriteVersionNumber: 2 },
    })

    expect(wrapper.attributes('data-row')).toBe('10')
    expect(wrapper.attributes('data-frame')).toBe('7')
    expect(wrapper.attributes('data-look-frame')).toBe('15')

    await wrapper.setProps({ lookFrame: 0 })
    expect(wrapper.attributes('data-row')).toBe('9')
    expect(wrapper.attributes('data-frame')).toBe('0')
    wrapper.unmount()
  })

  it('keeps animation and look frames on separate layers for gaze transitions', async () => {
    const wrapper = mount(PetAtlasPlayer, {
      props: { src: 'asset://pet.webp', state: 'review', spriteVersionNumber: 2 },
    })

    const animationLayer = wrapper.get('.pet-atlas-animation-layer')
    const lookLayer = wrapper.get('.pet-atlas-look-layer')
    expect(wrapper.classes()).not.toContain('pet-atlas-sprite--looking')
    expect(animationLayer.attributes('style')).toContain('0% 80%')

    await wrapper.setProps({ lookFrame: 4 })
    expect(wrapper.classes()).toContain('pet-atlas-sprite--looking')
    expect(lookLayer.attributes('style')).toContain('57.14285714285714% 90%')

    await wrapper.setProps({ lookFrame: null })
    expect(wrapper.classes()).not.toContain('pet-atlas-sprite--looking')
    wrapper.unmount()
  })

  it('uses the nine-row v1 atlas and ignores unavailable look frames', () => {
    const wrapper = mount(PetAtlasPlayer, {
      props: { src: 'asset://pet.png', state: 'idle', lookFrame: 12, spriteVersionNumber: 1 },
    })

    expect(wrapper.attributes('data-row')).toBe('0')
    expect(wrapper.attributes('data-look-frame')).toBeUndefined()
    expect(wrapper.attributes('style')).toContain('800% 900%')
    wrapper.unmount()
  })
})

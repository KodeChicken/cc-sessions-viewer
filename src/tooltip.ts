// Singleton tooltip implemented as a Vue directive `v-tooltip="text"`.
// 一个全局复用的 DOM 节点，挂在 <body> 上；hover/focus 时定位到目标元素附近。
// 主要替代原生 `title` —— 原生 tooltip 在 macOS WebKit 下风格生硬，且 240ms
// 才出现、字号小、深浅模式无法跟随。
import type { Directive } from 'vue'

interface BindData {
  text: string
  enter: () => void
  leave: () => void
  focusin: () => void
  focusout: () => void
}

const bindings = new WeakMap<HTMLElement, BindData>()
let tipEl: HTMLDivElement | null = null
let showTimer = 0
let activeEl: HTMLElement | null = null

function ensureTipEl(): HTMLDivElement {
  if (tipEl) return tipEl
  const el = document.createElement('div')
  el.className = 'cv-tooltip'
  el.setAttribute('role', 'tooltip')
  document.body.appendChild(el)
  tipEl = el
  return el
}

function showFor(target: HTMLElement, text: string) {
  const el = ensureTipEl()
  el.textContent = text
  // 重置位置以便测量真实尺寸（max-width 由 CSS 控制）
  el.style.left = '0px'
  el.style.top = '0px'
  el.classList.remove('is-visible')
  const targetRect = target.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  const gap = 6
  const margin = 6
  let placeAbove = false
  let top = targetRect.bottom + gap
  if (top + rect.height + margin > window.innerHeight) {
    top = targetRect.top - rect.height - gap
    placeAbove = true
  }
  let left = targetRect.left + targetRect.width / 2 - rect.width / 2
  left = Math.max(margin, Math.min(window.innerWidth - rect.width - margin, left))
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
  el.dataset.placement = placeAbove ? 'top' : 'bottom'
  requestAnimationFrame(() => el.classList.add('is-visible'))
}

function hide() {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = 0
  }
  activeEl = null
  tipEl?.classList.remove('is-visible')
}

function bind(el: HTMLElement, text: string) {
  const data: BindData = {
    text,
    enter() {
      if (!data.text) return
      activeEl = el
      if (showTimer) clearTimeout(showTimer)
      showTimer = window.setTimeout(() => {
        if (activeEl === el) showFor(el, data.text)
      }, 250)
    },
    leave() {
      if (activeEl === el) hide()
    },
    focusin() {
      if (!data.text) return
      activeEl = el
      // 键盘聚焦时不延迟
      showFor(el, data.text)
    },
    focusout() {
      if (activeEl === el) hide()
    },
  }
  el.addEventListener('mouseenter', data.enter)
  el.addEventListener('mouseleave', data.leave)
  el.addEventListener('focusin', data.focusin)
  el.addEventListener('focusout', data.focusout)
  bindings.set(el, data)
}

function unbind(el: HTMLElement) {
  const data = bindings.get(el)
  if (!data) return
  el.removeEventListener('mouseenter', data.enter)
  el.removeEventListener('mouseleave', data.leave)
  el.removeEventListener('focusin', data.focusin)
  el.removeEventListener('focusout', data.focusout)
  if (activeEl === el) hide()
  bindings.delete(el)
}

export const vTooltip: Directive<HTMLElement, string | undefined | null> = {
  mounted(el, binding) {
    const text = typeof binding.value === 'string' ? binding.value : ''
    if (!text) return
    bind(el, text)
    el.setAttribute('aria-label', text)
  },
  updated(el, binding) {
    const next = typeof binding.value === 'string' ? binding.value : ''
    const prev = bindings.get(el)
    if (next === (prev?.text ?? '')) return
    if (prev) {
      if (next) {
        prev.text = next
        el.setAttribute('aria-label', next)
      } else {
        unbind(el)
        el.removeAttribute('aria-label')
      }
    } else if (next) {
      bind(el, next)
      el.setAttribute('aria-label', next)
    }
  },
  unmounted(el) {
    unbind(el)
  },
}

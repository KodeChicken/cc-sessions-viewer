import { createApp } from 'vue'
import './style.css'

if (navigator.platform.startsWith('Mac')) {
  document.documentElement.classList.add('is-macos')
}

const isDesktopPet = new URLSearchParams(location.search).has('desktop-pet')

if (isDesktopPet) {
  const DesktopPet = (await import('./components/DesktopPet.vue')).default
  createApp(DesktopPet).mount('#app')
} else {
  const [{ default: App }, { vTooltip }, { openLocalPath, openUrl }] = await Promise.all([
    import('./App.vue'),
    import('./tooltip'),
    import('./api'),
  ])

  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
    if (!a) return
    const localTarget = a.dataset.localTarget
    if (localTarget) {
      e.preventDefault()
      openLocalPath(localTarget)
      return
    }
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('http://') || href.startsWith('https://')) {
      e.preventDefault()
      openUrl(href)
    }
  })

  document.addEventListener('contextmenu', (e) => {
    const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
    if (a) e.preventDefault()
  })

  createApp(App).directive('tooltip', vTooltip).mount('#app')
}

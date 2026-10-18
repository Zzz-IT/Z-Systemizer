// 【视觉服务】IntersectionObserver 图标按需懒加载与内存释放

const ICON_LOAD_TIMEOUT_MS = 2000

export interface IconScopeElements {
  img: HTMLImageElement
  loader: HTMLElement | null
  fallback: HTMLElement | null
}

export interface IconControllerOptions {
  rootMargin?: string
  iconUrl?: (pkg: string) => string
  onError?: (pkg: string, scope: HTMLElement) => void
}

export class IconController {
  private observer: IntersectionObserver | null = null
  private loaded = new Set<string>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private options: IconControllerOptions

  constructor(options: IconControllerOptions = {}) {
    this.options = {
      rootMargin: '120px',
      iconUrl: (pkg) => `ksu://icon/${pkg}`,
      ...options,
    }
  }

  attach(scope: HTMLElement): void {
    if (scope.dataset.iconBound === '1') return
    scope.dataset.iconBound = '1'
    this.observer?.observe(scope)
  }

  refresh(root: ParentNode = document): void {
    this.observer?.disconnect()

    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue

        const wrap = entry.target as HTMLElement
        const pkg = wrap.dataset.package
        if (!pkg) continue

        this.loadIcon(pkg, wrap)
        this.observer?.unobserve(wrap)
      }
    }, {
      rootMargin: this.options.rootMargin ?? '120px',
      threshold: 0.01,
    })

    root.querySelectorAll<HTMLElement>('.icon-wrap').forEach((wrap) => {
      if (wrap.dataset.iconBound === '1') {
        this.observer?.observe(wrap)
        return
      }
      wrap.dataset.iconBound = '1'
      this.observer?.observe(wrap)
    })
  }

  detach(): void {
    this.observer?.disconnect()
    this.observer = null
  }

  reset(root: ParentNode = document): void {
    this.loaded.clear()
    // 清掉上一轮仍在计时的兜底定时器：否则它会在重载途中隐藏 loader、
    // 点亮 fallback，表现为「点重新加载图标后整屏图标直接变灰」。
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()

    root.querySelectorAll<HTMLElement>('.icon-wrap').forEach((wrap) => {
      const img = wrap.querySelector<HTMLImageElement>('.app-icon')
      const loader = wrap.querySelector<HTMLElement>('.icon-loader')
      const fallback = wrap.querySelector<HTMLElement>('.icon-fallback')

      delete wrap.dataset.iconLoaded
      delete wrap.dataset.iconBound

      if (img) {
        img.onload = null
        img.onerror = null
        img.removeAttribute('src')
        img.classList.remove('is-loaded', 'is-error')
        img.style.display = ''
      }

      if (loader) loader.style.display = ''
      if (fallback) fallback.classList.remove('visible')
    })

    this.refresh(root)
  }

  private getScope(scope: HTMLElement): IconScopeElements | null {
    const img = scope.querySelector<HTMLImageElement>('.app-icon')
    if (!img) return null

    return {
      img,
      loader: scope.querySelector<HTMLElement>('.icon-loader'),
      fallback: scope.querySelector<HTMLElement>('.icon-fallback'),
    }
  }

  private loadIcon(pkg: string, scope: HTMLElement): void {
    const elements = this.getScope(scope)
    if (!elements) return

    const { img, loader, fallback } = elements

    if (this.loaded.has(pkg) && img.classList.contains('is-loaded')) {
      if (loader) loader.style.display = 'none'
      scope.dataset.iconLoaded = '1'
      return
    }

    let settled = false

    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (settled) return
      if (loader) loader.style.display = 'none'
      if (fallback) fallback.classList.add('visible')
    }, ICON_LOAD_TIMEOUT_MS)
    this.timers.add(timer)

    img.onload = () => {
      this.timers.delete(timer)
      clearTimeout(timer)
      if (settled) return

      if (loader) loader.style.display = 'none'
      if (fallback) fallback.classList.remove('visible')
      img.classList.add('is-loaded')
      img.classList.remove('is-error')

      this.loaded.add(pkg)
      scope.dataset.iconLoaded = '1'
      settled = true
    }

    img.onerror = () => {
      this.timers.delete(timer)
      clearTimeout(timer)
      if (settled) return

      if (loader) loader.style.display = 'none'
      img.classList.add('is-error')
      img.classList.remove('is-loaded')
      if (fallback) fallback.classList.add('visible')
      this.options.onError?.(pkg, scope)
      settled = true
    }

    img.src = (this.options.iconUrl ?? ((p: string) => `ksu://icon/${p}`))(pkg)
  }
}
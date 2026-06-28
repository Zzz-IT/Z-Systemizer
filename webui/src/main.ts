import {
  getAppsSafe,
  getSystemizerStateSafe,
  systemize,
  unsystemize,
  diagnose,
  rebootDevice,
  refreshDerived,
  type SystemizerState
} from './api'
import { buildUiApps, hasPending, mergeBusyState, type UiAppEntry } from './state'
import './style.scss'

const state = {
  apps: [] as UiAppEntry[],
  filter: '',
  onlySystemized: false,
  globalBusy: false,
  rawState: null as SystemizerState | null,
}

const renderedCards = new Map<string, HTMLElement>()

function $(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`找不到元素：${selector}`)
  return el
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function statusText(app: UiAppEntry): string {
  switch (app.status) {
    case 'pending-add': return '待系统化'
    case 'pending-remove': return '待移除，重启前可撤销'
    case 'systemized': return '已系统化'
    case 'normal':
    default: return '未系统化'
  }
}

function statusClass(app: UiAppEntry): string {
  switch (app.status) {
    case 'pending-add': return 'is-pending-add'
    case 'pending-remove': return 'is-pending-remove'
    case 'systemized': return 'is-systemized'
    case 'normal':
    default: return 'is-normal'
  }
}

function isSwitchOn(app: UiAppEntry): boolean {
  return app.status === 'pending-add' || app.status === 'systemized'
}

function isManaged(app: UiAppEntry): boolean {
  return app.status === 'pending-add'
    || app.status === 'pending-remove'
    || app.status === 'systemized'
}

function statusPriority(app: UiAppEntry): number {
  switch (app.status) {
    case 'pending-add': return 0
    case 'pending-remove': return 1
    case 'systemized': return 2
    case 'normal':
    default: return 3
  }
}

function sortApps(apps: UiAppEntry[]): UiAppEntry[] {
  return [...apps].sort((a, b) => {
    const pa = statusPriority(a)
    const pb = statusPriority(b)

    if (pa !== pb) return pa - pb

    return a.appName.localeCompare(b.appName, 'zh-Hans-CN')
  })
}

function visibleApps(): UiAppEntry[] {
  const q = state.filter.trim().toLowerCase()

  return sortApps(state.apps.filter(app => {
    if (state.onlySystemized && !isManaged(app)) return false

    if (!q) return true

    return app.appName.toLowerCase().includes(q)
      || app.packageName.toLowerCase().includes(q)
  }))
}

const INITIAL_ICON_LIMIT = 16
const INITIAL_ICON_TIMEOUT_MS = 900

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function preloadIcon(pkg: string): Promise<boolean> {
  return new Promise(resolve => {
    const img = new Image()
    let done = false

    const finish = (ok: boolean) => {
      if (done) return
      done = true
      resolve(ok)
    }

    const timer = setTimeout(() => finish(false), INITIAL_ICON_TIMEOUT_MS)

    img.onload = () => {
      clearTimeout(timer)
      finish(true)
    }

    img.onerror = () => {
      clearTimeout(timer)
      finish(false)
    }

    img.src = `ksu://icon/${pkg}`
  })
}

async function preloadInitialIcons(apps: UiAppEntry[]): Promise<void> {
  const first = apps.slice(0, INITIAL_ICON_LIMIT)

  await Promise.race([
    Promise.allSettled(first.map(async app => {
      const ok = await preloadIcon(app.packageName)
      if (ok) loadedIconPackages.add(app.packageName)
    })).then(() => {}),
    delay(INITIAL_ICON_TIMEOUT_MS),
  ])
}

let iconObserver: IntersectionObserver | null = null
const loadedIconPackages = new Set<string>()

function setupIconObserver() {
  iconObserver?.disconnect()

  iconObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue

      const wrap = entry.target as HTMLElement
      const pkg = wrap.dataset.package
      if (!pkg) continue

      loadIcon(pkg, wrap)
      iconObserver?.unobserve(wrap)
    }
  }, {
    rootMargin: '120px',
    threshold: 0.01,
  })

  document.querySelectorAll<HTMLElement>('.icon-wrap').forEach(wrap => {
    if (wrap.dataset.iconLoaded === '1') return
    iconObserver?.observe(wrap)
  })
}

function loadIcon(pkg: string, scope: HTMLElement) {
  const img = scope.querySelector<HTMLImageElement>('.app-icon')
  const loader = scope.querySelector<HTMLElement>('.icon-loader')
  const fallback = scope.querySelector<HTMLElement>('.icon-fallback')

  if (!img) return

  if (loadedIconPackages.has(pkg) && img.classList.contains('is-loaded')) {
    if (loader) loader.style.display = 'none'
    scope.dataset.iconLoaded = '1'
    return
  }

  let settled = false

  const timer = setTimeout(() => {
    if (settled) return
    if (loader) loader.style.display = 'none'
    if (fallback) fallback.classList.add('visible')
  }, 2000)

  img.onload = () => {
    clearTimeout(timer)

    if (loader) loader.style.display = 'none'
    if (fallback) fallback.classList.remove('visible')

    img.classList.add('is-loaded')
    img.classList.remove('is-error')
    loadedIconPackages.add(pkg)
    scope.dataset.iconLoaded = '1'
    settled = true
  }

  img.onerror = () => {
    clearTimeout(timer)
    if (settled) return

    if (loader) loader.style.display = 'none'
    img.classList.add('is-error')
    img.classList.remove('is-loaded')
    if (fallback) fallback.classList.add('visible')
    settled = true
  }

  img.src = `ksu://icon/${pkg}`
}

function resetVisibleIcons() {
  loadedIconPackages.clear()

  document.querySelectorAll<HTMLElement>('.icon-wrap').forEach(wrap => {
    const img = wrap.querySelector<HTMLImageElement>('.app-icon')
    const loader = wrap.querySelector<HTMLElement>('.icon-loader')
    const fallback = wrap.querySelector<HTMLElement>('.icon-fallback')

    delete wrap.dataset.iconLoaded

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

  setupIconObserver()
}

function renderCardInner(app: UiAppEntry): string {
  const on = isSwitchOn(app)
  const pkgEscaped = escapeHtml(app.packageName)
  const nameEscaped = escapeHtml(app.appName)
  const initial = escapeHtml((app.appName || app.packageName).slice(0, 1).toUpperCase())

  return `
    <div class="icon-wrap" data-package="${pkgEscaped}">
      <div class="icon-loader" data-package="${pkgEscaped}"></div>
      <img class="app-icon" data-package="${pkgEscaped}" alt="" draggable="false" />
      <div class="icon-fallback" data-package="${pkgEscaped}">${initial}</div>
    </div>
    <div class="app-info">
      <div class="app-name">${nameEscaped}</div>
      <div class="package-name">${pkgEscaped}</div>
      <div class="app-status ${statusClass(app)}">${statusText(app)}</div>
    </div>
    <button class="switch ${on ? 'is-on' : ''} ${app.busy ? 'is-busy' : ''}" aria-label="切换状态">
      <span class="switch-thumb"></span>
    </button>
  `
}

function createCardElement(app: UiAppEntry, index = 0): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.innerHTML = `
    <article
      class="app-card enter"
      style="
        --enter-delay: ${Math.min(index * 26, 260)}ms;
        --enter-index: ${index};
      "
      data-package="${escapeHtml(app.packageName)}"
    >
      ${renderCardInner(app)}
    </article>
  `

  return wrapper.firstElementChild as HTMLElement
}

function updateCardElement(card: HTMLElement, app: UiAppEntry) {
  const on = isSwitchOn(app)

  const status = card.querySelector('.app-status')
  if (status) {
    status.textContent = statusText(app)
    status.className = `app-status ${statusClass(app)}`
  }

  const sw = card.querySelector('.switch')
  if (sw) {
    sw.className = `switch ${on ? 'is-on' : ''} ${app.busy ? 'is-busy' : ''}`
  }
}

function updateCardDOM(pkg: string) {
  const app = state.apps.find(item => item.packageName === pkg)
  if (!app) return
  
  const card = renderedCards.get(pkg)
  if (!card) return
  
  updateCardElement(card, app)
  renderSummary()
  renderRebootButton()
}

function render() {
  const list = $('.app-list')
  const empty = document.querySelector<HTMLElement>('.empty-state')
  const apps = visibleApps()

  if (empty) {
    empty.classList.toggle('hidden', apps.length > 0)

    if (apps.length === 0) {
      empty.textContent = state.filter.trim()
        ? '没有匹配的应用'
        : '暂无可显示应用'
    }
  }

  const visiblePkgs = new Set(apps.map(app => app.packageName))

  for (const [pkg, card] of renderedCards) {
    if (!visiblePkgs.has(pkg)) {
      card.classList.add('leave')
      setTimeout(() => card.remove(), 180)
      renderedCards.delete(pkg)
    }
  }

  apps.forEach((app, index) => {
    let card = renderedCards.get(app.packageName)

    if (!card) {
      card = createCardElement(app, index)
      renderedCards.set(app.packageName, card)
      list.appendChild(card)
      requestAnimationFrame(() => card!.classList.add('enter-done'))
    } else {
      updateCardElement(card, app)
      list.appendChild(card)
    }
  })

  renderSummary()
  renderRebootButton()
  setupIconObserver()
  revealList()
}

function revealList() {
  const loading = document.querySelector<HTMLElement>('.loading-state')
  const list = document.querySelector<HTMLElement>('.app-list')

  if (loading) {
    loading.classList.add('hidden')
  }

  if (list) {
    list.classList.remove('is-loading')
    requestAnimationFrame(() => {
      list.classList.add('is-ready')
    })
  }
}

function showAppLoading() {
  const list = document.querySelector<HTMLElement>('.app-list')
  const empty = document.querySelector<HTMLElement>('.empty-state')
  const loading = document.querySelector<HTMLElement>('.loading-state')

  if (list) {
    list.classList.remove('is-ready')
    list.classList.add('is-loading')
  }

  if (empty) {
    empty.classList.add('hidden')
  }

  if (loading) {
    loading.classList.remove('hidden')
  }
}

function renderSummary() {
  const systemizedCount = state.apps.filter(app => 
    app.status === 'systemized'
  ).length

  const pendingCount = state.apps.filter(app =>
    app.status === 'pending-add' || app.status === 'pending-remove'
  ).length

  $('.summary-systemized').textContent = String(systemizedCount)
  $('.summary-pending').textContent = String(pendingCount)
}

function renderRebootButton() {
  const button = $('.reboot-fab')
  button.classList.toggle('is-hot', hasPending(state.apps))
}

async function toggleApp(app: UiAppEntry) {
  if (state.globalBusy || app.busy) return

  if (app.status === 'pending-add') {
    await doUnsystemize(app, '已取消待系统化', 'normal')
    return
  }

  if (app.status === 'pending-remove') {
    await doSystemize(app, '已撤销移除', 'systemized')
    return
  }

  if (app.status === 'systemized') {
    app.busy = true
    updateCardDOM(app.packageName)

    const ok = await confirmRemove(app)
    if (!ok) {
      app.busy = false
      updateCardDOM(app.packageName)
      return
    }

    await doUnsystemize(app, '已记录待移除', 'pending-remove')
    return
  }

  await doSystemize(app, '已记录待系统化', 'pending-add')
}

async function doSystemize(app: UiAppEntry, msg: string, nextStatus: UiAppEntry['status']) {
  app.busy = true
  updateCardDOM(app.packageName)

  try {
    await systemize(app.packageName)
    toast(msg)
    app.busy = false
    app.status = nextStatus
    updateCardDOM(app.packageName)
  } catch (e) {
    toast(errorMessage(e))
    app.busy = false
    updateCardDOM(app.packageName)
  }
}

async function doUnsystemize(app: UiAppEntry, msg: string, nextStatus: UiAppEntry['status']) {
  app.busy = true
  updateCardDOM(app.packageName)

  try {
    await unsystemize(app.packageName)
    toast(msg)
    app.busy = false
    app.status = nextStatus
    updateCardDOM(app.packageName)
  } catch (e) {
    toast(errorMessage(e))
    app.busy = false
    updateCardDOM(app.packageName)
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function showFatalError(e: unknown) {
  const message = errorMessage(e)

  const statusLine = document.querySelector<HTMLElement>('.status-line')
  const loading = document.querySelector<HTMLElement>('.loading-state')
  if (loading) {
    loading.classList.add('hidden')
  }

  const list = document.querySelector<HTMLElement>('.app-list')
  if (list) {
    list.classList.remove('is-loading')
    list.classList.add('is-ready')
  }

  const empty = document.querySelector<HTMLElement>('.empty-state')
  const hasOldCards = renderedCards.size > 0

  if (empty) {
    empty.classList.toggle('hidden', hasOldCards)
    empty.textContent = message
  }

  if (statusLine) {
    statusLine.textContent = hasOldCards
      ? `刷新失败，已保留上次列表：${message}`
      : `加载失败：${message}`
  }

  toast(message)
}

function toast(message: string) {
  const node = document.createElement('div')
  node.className = 'toast'
  node.textContent = message
  document.body.appendChild(node)

  requestAnimationFrame(() => node.classList.add('show'))
  setTimeout(() => {
    node.classList.remove('show')
    setTimeout(() => node.remove(), 250)
  }, 2200)
}

async function confirmRemove(app: UiAppEntry): Promise<boolean> {
  return showConfirm({
    title: '移除系统化？',
    message: `将从模块 system/app 中移除：\n${app.appName}\n${app.packageName}\n\n需要重启后生效。`,
    cancelText: '取消',
    confirmText: '移除',
    danger: true,
  })
}

async function confirmReboot(): Promise<boolean> {
  return showConfirm({
    title: '确认重启设备？',
    message: '已完成的系统化/移除操作需要重启后生效。\n当前设备将立即重启。',
    cancelText: '取消',
    confirmText: '立即重启',
    danger: true,
  })
}

function showConfirm(options: {
  title: string
  message: string
  cancelText: string
  confirmText: string
  danger?: boolean
}): Promise<boolean> {
  return new Promise(resolve => {
    if (document.querySelector('.dialog-backdrop')) {
      resolve(false)
      return
    }

    const dialog = document.createElement('div')
    dialog.className = 'dialog-backdrop'
    dialog.innerHTML = `
      <div class="dialog">
        <div class="dialog-title">${escapeHtml(options.title)}</div>
        <div class="dialog-message">${escapeHtml(options.message).replaceAll('\n', '<br>')}</div>
        <div class="dialog-actions">
          <button class="dialog-cancel">${escapeHtml(options.cancelText)}</button>
          <button class="dialog-confirm ${options.danger ? 'danger' : ''}">${escapeHtml(options.confirmText)}</button>
        </div>
      </div>
    `

    document.body.appendChild(dialog)
    requestAnimationFrame(() => dialog.classList.add('show'))

    const closeDialog = (result: boolean) => {
      dialog.classList.remove('show')
      setTimeout(() => {
        dialog.remove()
        resolve(result)
      }, 180)
    }

    dialog.querySelector<HTMLButtonElement>('.dialog-cancel')!.onclick = () => closeDialog(false)
    dialog.querySelector<HTMLButtonElement>('.dialog-confirm')!.onclick = () => closeDialog(true)
  })
}

async function loadDiagnoseDialog() {
  try {
    const out = await diagnose()
    let msg = out || '无诊断输出'
    if (state.rawState) {
      const records = Object.values(state.rawState.apps)
      const active = records.filter(r => r.status === 'active').length
      const pendingAdd = records.filter(r => r.status === 'pending_add').length
      const pendingRemove = records.filter(r => r.status === 'pending_remove').length
      
      msg += `\n\n--- UI 状态映射 ---\n已系统化: ${active}\n待系统化: ${pendingAdd}\n待移除: ${pendingRemove}\n`
    }

    await showConfirm({
      title: '诊断信息',
      message: msg,
      cancelText: '关闭',
      confirmText: '刷新',
    })
  } catch (e) {
    toast(errorMessage(e))
  }
}

async function refresh() {
  if (state.globalBusy) return

  state.globalBusy = true

  showAppLoading()

  const statusLine = document.querySelector<HTMLElement>('.status-line')
  if (statusLine) statusLine.textContent = '正在刷新...'

  try {
    const oldApps = state.apps

    const apps = await getAppsSafe()
    const sysState = await getSystemizerStateSafe()

    state.rawState = sysState

    let nextApps = buildUiApps(apps, sysState)
    nextApps = mergeBusyState(nextApps, oldApps)

    state.apps = nextApps

    const firstScreenApps = visibleApps()

    await preloadInitialIcons(firstScreenApps)

    if (statusLine) {
      statusLine.textContent = `已加载 ${state.apps.length} 个应用`
    }

    render()

    refreshDerived().catch(() => {})
  } catch (e) {
    showFatalError(e)
  } finally {
    state.globalBusy = false
  }
}

function bindEvents() {
  let searchTimeout: ReturnType<typeof setTimeout>
  let lastFilter = ''

  document.querySelector<HTMLInputElement>('.search-input')!.oninput = e => {
    clearTimeout(searchTimeout)

    searchTimeout = setTimeout(() => {
      const value = (e.target as HTMLInputElement).value
      const wasNonEmpty = lastFilter.trim().length > 0
      const isEmpty = value.trim().length === 0

      state.filter = value
      lastFilter = value

      if (wasNonEmpty && isEmpty) {
        refresh().catch(showFatalError)
        return
      }

      render()
    }, 250)
  }

  $('.refresh-button').onclick = () => {
    refresh().catch(showFatalError)
  }

  $('.reboot-fab').onclick = async () => {
    const ok = await confirmReboot()
    if (!ok) return

    try {
      await rebootDevice()
    } catch (e) {
      toast(`重启失败：${errorMessage(e)}`)
    }
  }

  // Event Delegation for App List
  $('.app-list').onclick = (event) => {
    const target = event.target as HTMLElement
    const card = target.closest('.app-card') as HTMLElement
    if (!card) return
    
    const pkg = card.dataset.package
    if (!pkg) return
    
    const app = state.apps.find(item => item.packageName === pkg)
    if (!app) return
    
    toggleApp(app)
  }
  
  // Dropdown Menu Logic
  const moreButton = $('.more-button')
  const dropdownMenu = $('.dropdown-menu')
  
  moreButton.onclick = (e) => {
    e.stopPropagation()
    dropdownMenu.classList.toggle('show')
  }
  
  document.addEventListener('click', (e) => {
    if (!dropdownMenu.contains(e.target as Node)) {
      dropdownMenu.classList.remove('show')
    }
  })
  
  document.getElementById('toggle-only-sys')!.onchange = (e) => {
    state.onlySystemized = (e.target as HTMLInputElement).checked
    render()
  }
  
  document.getElementById('menu-diagnose')!.onclick = () => {
    dropdownMenu.classList.remove('show')
    loadDiagnoseDialog()
  }
  
  document.getElementById('menu-clear-icons')!.onclick = () => {
    dropdownMenu.classList.remove('show')
    resetVisibleIcons()
    toast('已重新加载图标')
  }

  document.getElementById('menu-about')!.onclick = () => {
    dropdownMenu.classList.remove('show')
    showConfirm({
      title: '关于 Z-Systemizer',
      message: 'Z-Systemizer 模块 WebUI\n版本: 1.1.6\n持久状态与自动同步',
      cancelText: '关闭',
      confirmText: '确定'
    })
  }

  // Pull to Refresh Logic
  let touchStartY = 0
  let isPulling = false
  const ptrIndicator = document.querySelector<HTMLElement>('.ptr-indicator')!
  const ptrSpinner = document.querySelector<HTMLElement>('.ptr-spinner')!
  const THRESHOLD = 60

  document.addEventListener('touchstart', (e) => {
    if (window.scrollY === 0) {
      touchStartY = e.touches[0].clientY
      isPulling = true
    } else {
      isPulling = false
    }
  }, { passive: true })

  document.addEventListener('touchmove', (e) => {
    if (!isPulling || state.globalBusy) return
    const currentY = e.touches[0].clientY
    const pullDistance = currentY - touchStartY

    if (pullDistance > 0 && window.scrollY === 0) {
      e.preventDefault()
      const height = Math.min(pullDistance * 0.4, THRESHOLD + 20)
      ptrIndicator.style.height = `${height}px`
      
      if (height > THRESHOLD) {
        ptrSpinner.classList.add('active')
      } else {
        ptrSpinner.classList.remove('active')
      }
    }
  }, { passive: false })

  document.addEventListener('touchend', () => {
    if (!isPulling) return
    isPulling = false
    const currentHeight = parseInt(ptrIndicator.style.height || '0', 10)

    if (currentHeight > THRESHOLD && !state.globalBusy) {
      ptrIndicator.style.height = `${THRESHOLD}px`
      refresh().then(() => {
        ptrIndicator.style.height = '0px'
        ptrSpinner.classList.remove('active')
      }).catch((e) => {
        showFatalError(e)
        ptrIndicator.style.height = '0px'
        ptrSpinner.classList.remove('active')
      })
    } else {
      ptrIndicator.style.height = '0px'
      ptrSpinner.classList.remove('active')
    }
  })
}

bindEvents()
refresh().catch(showFatalError)

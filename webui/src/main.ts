import {
  getApps,
  getSystemizedPackages,
  systemize,
  unsystemize,
  diagnose,
  rebootDevice,
} from './api'
import { buildUiApps, hasPending, mergePendingState, type UiAppEntry } from './state'
import './style.scss'

const state = {
  apps: [] as UiAppEntry[],
  filter: '',
  onlySystemized: false,
  globalBusy: false,
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
  if (app.pending === 'add') return '待系统化'
  if (app.pending === 'remove') return '待移除'
  return app.systemized ? '已系统化' : '未系统化'
}

function statusClass(app: UiAppEntry): string {
  if (app.pending === 'add') return 'is-pending-add'
  if (app.pending === 'remove') return 'is-pending-remove'
  return app.systemized ? 'is-systemized' : 'is-normal'
}

function isOn(app: UiAppEntry): boolean {
  if (app.pending === 'add') return true
  if (app.pending === 'remove') return false
  return app.systemized
}

function render() {
  const q = state.filter.trim().toLowerCase()
  const list = $('.app-list')

  const apps = state.apps.filter(app => {
    if (state.onlySystemized && !isOn(app)) return false

    return app.appName.toLowerCase().includes(q)
      || app.packageName.toLowerCase().includes(q)
  })

  const visiblePkgs = new Set(apps.map(app => app.packageName))

  for (const [pkg, card] of renderedCards) {
    if (!visiblePkgs.has(pkg)) {
      card.classList.add('leave')
      setTimeout(() => card.remove(), 180)
      renderedCards.delete(pkg)
    }
  }

  for (const app of apps) {
    let card = renderedCards.get(app.packageName)

    if (!card) {
      card = createCardElement(app)
      renderedCards.set(app.packageName, card)
      list.appendChild(card)
      const el = card
      requestAnimationFrame(() => el.classList.add('enter-done'))
    } else {
      updateCardElement(card, app)
    }
  }

  renderSummary()
  renderRebootButton()
}

function renderCardInner(app: UiAppEntry): string {
  const on = isOn(app)
  const pkgEscaped = escapeHtml(app.packageName)
  const nameEscaped = escapeHtml(app.appName)

  return `
    <div class="icon-wrap">
      <img class="app-icon" src="ksu://icon/${pkgEscaped}" alt="" />
      <div class="icon-fallback">${escapeHtml((app.appName || app.packageName).slice(0, 1).toUpperCase())}</div>
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

function createCardElement(app: UiAppEntry): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.innerHTML = `
    <article class="app-card enter" data-package="${escapeHtml(app.packageName)}">
      ${renderCardInner(app)}
    </article>
  `
  const card = wrapper.firstElementChild as HTMLElement
  bindIconCache(card, app)
  return card
}

const iconCache = new Map<string, string>()

function bindIconCache(card: HTMLElement, app: UiAppEntry) {
  const img = card.querySelector<HTMLImageElement>('.app-icon')
  if (!img) return

  const cached = iconCache.get(app.packageName)
  if (cached) {
    img.src = cached
    img.classList.add('is-loaded')
    return
  }

  img.onload = () => {
    iconCache.set(app.packageName, img.src)
    img.classList.add('is-loaded')
  }

  img.onerror = () => {
    img.classList.add('is-error')
  }
}

function updateCardElement(card: HTMLElement, app: UiAppEntry) {
  const on = isOn(app)
  
  const status = card.querySelector('.app-status')!
  status.textContent = statusText(app)
  status.className = `app-status ${statusClass(app)}`
  
  card.querySelector('.switch')!.className = `switch ${on ? 'is-on' : ''} ${app.busy ? 'is-busy' : ''}`
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

function renderSummary() {
  const systemizedCount = state.apps.filter(app =>
    app.systemized && app.pending !== 'remove'
  ).length

  const pendingCount = state.apps.filter(app =>
    app.pending !== 'none'
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

  if (app.pending === 'add') {
    await cancelPendingAdd(app)
    return
  }

  if (app.pending === 'remove') {
    await cancelPendingRemove(app)
    return
  }

  if (app.systemized) {
    app.busy = true
    updateCardDOM(app.packageName)

    const ok = await confirmRemove(app)
    if (!ok) {
      app.busy = false
      updateCardDOM(app.packageName)
      return
    }

    await doUnsystemize(app)
    return
  }

  await doSystemize(app)
}

async function doSystemize(app: UiAppEntry) {
  app.busy = true
  updateCardDOM(app.packageName)

  try {
    await systemize(app.packageName)
    app.systemized = true
    app.pending = 'add'
    toast(`已添加 ${app.appName} 的待系统化`)
  } catch (e) {
    toast(errorMessage(e))
  } finally {
    app.busy = false
    updateCardDOM(app.packageName)
  }
}

async function doUnsystemize(app: UiAppEntry) {
  app.busy = true
  updateCardDOM(app.packageName)

  try {
    await unsystemize(app.packageName)
    app.systemized = false
    app.pending = 'remove'
    toast(`已记录 ${app.appName} 的待移除`)
  } catch (e) {
    toast(errorMessage(e))
  } finally {
    app.busy = false
    updateCardDOM(app.packageName)
  }
}

async function cancelPendingAdd(app: UiAppEntry) {
  app.busy = true
  updateCardDOM(app.packageName)

  try {
    await unsystemize(app.packageName)
    app.systemized = false
    app.pending = 'none'
    toast(`已取消 ${app.appName} 的待系统化`)
  } catch (e) {
    toast(errorMessage(e))
  } finally {
    app.busy = false
    updateCardDOM(app.packageName)
  }
}

async function cancelPendingRemove(app: UiAppEntry) {
  app.busy = true
  updateCardDOM(app.packageName)

  try {
    await systemize(app.packageName)
    app.systemized = true
    app.pending = 'none'
    toast(`已恢复 ${app.appName} 的系统化状态`)
  } catch (e) {
    toast(errorMessage(e))
  } finally {
    app.busy = false
    updateCardDOM(app.packageName)
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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
    await showConfirm({
      title: '诊断信息',
      message: out || '无诊断输出',
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
  $('.status-line').textContent = '正在刷新...'

  try {
    const oldApps = state.apps

    const [apps, systemized] = await Promise.all([
      getApps(),
      getSystemizedPackages(),
    ])

    const nextApps = buildUiApps(apps, systemized)
    state.apps = mergePendingState(nextApps, oldApps)

    $('.status-line').textContent = `已加载 ${state.apps.length} 个应用`
    render()
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
        refresh().catch(err => toast(errorMessage(err)))
        return
      }

      render()
    }, 250)
  }

  $('.refresh-button').onclick = () => {
    refresh().catch(e => toast(errorMessage(e)))
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
  
  document.getElementById('menu-about')!.onclick = () => {
    dropdownMenu.classList.remove('show')
    showConfirm({
      title: '关于 Z-Systemizer',
      message: 'Z-Systemizer 模块 WebUI\n版本: 1.1.2\n基于 KernelSU API 构建。',
      cancelText: '关闭',
      confirmText: '确定'
    })
  }
}

bindEvents()
refresh().catch(e => {
  $('.status-line').textContent = errorMessage(e)
  toast(errorMessage(e))
})

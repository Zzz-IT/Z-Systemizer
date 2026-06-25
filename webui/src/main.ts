import {
  getApps,
  getSystemizerState,
  systemize,
  unsystemize,
  diagnose,
  rebootDevice,
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
    case 'pending-remove': return '待移除'
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

function isOn(app: UiAppEntry): boolean {
  return app.status === 'pending-add' || app.status === 'systemized'
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
    if (state.onlySystemized && !isOn(app)) return false

    if (!q) return true

    return app.appName.toLowerCase().includes(q)
      || app.packageName.toLowerCase().includes(q)
  }))
}

function render() {
  const list = $('.app-list')
  const apps = visibleApps()
  const visiblePkgs = new Set(apps.map(app => app.packageName))

  for (const [pkg, card] of renderedCards) {
    if (!visiblePkgs.has(pkg)) {
      card.classList.add('leave')
      setTimeout(() => card.remove(), 180)
      renderedCards.delete(pkg)
    }
  }

  // To preserve ordering with appendChild, we need to append in order.
  // Using appendChild on an existing node moves it to the end.
  // We can just iterate and append, diffing will keep instances alive but correct their order.
  for (const app of apps) {
    let card = renderedCards.get(app.packageName)

    if (!card) {
      card = createCardElement(app)
      renderedCards.set(app.packageName, card)
      list.appendChild(card)
      requestAnimationFrame(() => card!.classList.add('enter-done'))
    } else {
      updateCardElement(card, app)
      list.appendChild(card) // move to correct visual position
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

const DB_NAME = 'ksu_systemizer_db'
const STORE_NAME = 'icons'

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

async function getIconBlob(pkg: string): Promise<Blob | null> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(pkg)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    console.warn('IDB get failed', e)
    return null
  }
}

async function saveIconBlob(pkg: string, blob: Blob): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const req = tx.objectStore(STORE_NAME).put(blob, pkg)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    console.warn('IDB save failed', e)
  }
}

export async function clearIconCache(): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const req = tx.objectStore(STORE_NAME).clear()
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    console.warn('IDB clear failed', e)
  }
}

async function fetchAndSaveIcon(pkg: string): Promise<string> {
  try {
    const res = await fetch(`ksu://icon/${pkg}`)
    if (res.ok) {
      const blob = await res.blob()
      await saveIconBlob(pkg, blob)
      return URL.createObjectURL(blob)
    }
  } catch (e) {
    console.warn("fetch ksu:// failed, trying canvas fallback...", e)
  }
  
  return new Promise<string>((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(img, 0, 0)
        try {
          canvas.toBlob((blob) => {
            if (blob) {
              saveIconBlob(pkg, blob).catch(console.error)
              resolve(URL.createObjectURL(blob))
            } else {
              resolve(`ksu://icon/${pkg}`)
            }
          })
        } catch (e) {
          console.warn("canvas toBlob failed, tainted?", e)
          resolve(`ksu://icon/${pkg}`)
        }
      } else {
        resolve(`ksu://icon/${pkg}`)
      }
    }
    img.onerror = () => resolve(`ksu://icon/${pkg}`)
    img.src = `ksu://icon/${pkg}`
  })
}

const iconCache = new Map<string, string>()

async function bindIconCache(card: HTMLElement, app: UiAppEntry) {
  const img = card.querySelector<HTMLImageElement>('.app-icon')
  if (!img) return

  const cached = iconCache.get(app.packageName)
  if (cached) {
    img.src = cached
    img.classList.add('is-loaded')
    return
  }

  const blob = await getIconBlob(app.packageName)
  if (blob) {
    const url = URL.createObjectURL(blob)
    iconCache.set(app.packageName, url)
    img.src = url
    img.classList.add('is-loaded')
    return
  }

  const url = await fetchAndSaveIcon(app.packageName)
  iconCache.set(app.packageName, url)
  img.src = url
  img.classList.add('is-loaded')
  
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
    app.status === 'systemized' || app.status === 'pending-remove'
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
    await doUnsystemize(app, '已取消待系统化')
    return
  }

  if (app.status === 'pending-remove') {
    await doSystemize(app, '已取消待移除，重新写入队列')
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

    await doUnsystemize(app, '已记录待移除')
    return
  }

  await doSystemize(app, '已记录待系统化')
}

async function doSystemize(app: UiAppEntry, msg: string) {
  app.busy = true
  updateCardDOM(app.packageName)

  try {
    await systemize(app.packageName)
    toast(msg)
    app.busy = false
    await refresh()
  } catch (e) {
    toast(errorMessage(e))
    app.busy = false
    updateCardDOM(app.packageName)
  }
}

async function doUnsystemize(app: UiAppEntry, msg: string) {
  app.busy = true
  updateCardDOM(app.packageName)

  try {
    await unsystemize(app.packageName)
    toast(msg)
    app.busy = false
    await refresh()
  } catch (e) {
    toast(errorMessage(e))
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
  $('.status-line').textContent = '正在刷新...'

  try {
    const oldApps = state.apps

    const [apps, sysState] = await Promise.all([
      getApps(),
      getSystemizerState(),
    ])

    state.rawState = sysState
    let nextApps = buildUiApps(apps, sysState)
    nextApps = mergeBusyState(nextApps, oldApps)
    
    state.apps = nextApps

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
  
  document.getElementById('menu-clear-icons')!.onclick = async () => {
    dropdownMenu.classList.remove('show')
    await clearIconCache()
    iconCache.clear()
    toast('已清除本地图标缓存，重新加载将抓取新图标')
  }

  document.getElementById('menu-about')!.onclick = () => {
    dropdownMenu.classList.remove('show')
    showConfirm({
      title: '关于 Z-Systemizer',
      message: 'Z-Systemizer 模块 WebUI\n版本: 1.1.4\n持久状态与自动同步',
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

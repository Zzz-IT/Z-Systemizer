import {
  getApps,
  getSystemizedPackages,
  systemize,
  unsystemize,
  diagnose,
  rebootDevice,
} from './api'
import { buildUiApps, hasPending, type UiAppEntry } from './state'
import './style.scss'

const state = {
  apps: [] as UiAppEntry[],
  filter: '',
  onlySystemized: false,
}

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
  if (app.pending === 'add') return '已写入，重启后生效'
  if (app.pending === 'remove') return '已移除，重启后生效'
  return app.systemized ? '已系统化' : '未系统化'
}

function isOn(app: UiAppEntry): boolean {
  if (app.pending === 'add') return true
  if (app.pending === 'remove') return false
  return app.systemized
}

function render() {
  const q = state.filter.trim().toLowerCase()
  const list = $('.app-list')

  const apps = state.apps
    .filter(app => {
      if (state.onlySystemized && !isOn(app)) return false

      return app.appName.toLowerCase().includes(q)
        || app.packageName.toLowerCase().includes(q)
    })

  list.innerHTML = apps.map(app => renderCard(app)).join('')

  list.querySelectorAll<HTMLElement>('.app-card').forEach(card => {
    const pkg = card.dataset.package!
    const app = state.apps.find(item => item.packageName === pkg)
    if (!app) return

    const sw = card.querySelector<HTMLButtonElement>('.switch')!
    sw.onclick = event => {
      event.stopPropagation()
      toggleApp(app)
    }

    card.onclick = () => toggleApp(app)
  })

  renderSummary()
  renderRebootButton()
}

function renderCard(app: UiAppEntry): string {
  const on = isOn(app)
  const pending = app.pending !== 'none'

  return `
    <article class="app-card ${on ? 'is-on' : ''} ${pending ? 'is-pending' : ''}" data-package="${escapeHtml(app.packageName)}">
      <div class="icon-wrap">
        <img class="app-icon" src="ksu://icon/${escapeHtml(app.packageName)}" alt="" />
        <div class="icon-fallback">${escapeHtml((app.appName || app.packageName).slice(0, 1).toUpperCase())}</div>
      </div>

      <div class="app-info">
        <div class="app-name">${escapeHtml(app.appName)}</div>
        <div class="package-name">${escapeHtml(app.packageName)}</div>
        <div class="app-status">${statusText(app)}</div>
      </div>

      <button class="switch ${on ? 'is-on' : ''} ${app.busy ? 'is-busy' : ''}" aria-label="切换系统化状态">
        <span class="switch-thumb"></span>
      </button>
    </article>
  `
}

function renderSummary() {
  const systemizedCount = state.apps.filter(app => isOn(app)).length
  const pendingCount = state.apps.filter(app => app.pending !== 'none').length

  $('.summary-systemized').textContent = String(systemizedCount)
  $('.summary-pending').textContent = String(pendingCount)
}

function renderRebootButton() {
  const button = $('.reboot-fab')
  button.classList.toggle('is-hot', hasPending(state.apps))
}

async function toggleApp(app: UiAppEntry) {
  if (app.busy) return

  const currentlyOn = isOn(app)

  if (currentlyOn) {
    const ok = await confirmRemove(app)
    if (!ok) return
    await doUnsystemize(app)
  } else {
    await doSystemize(app)
  }
}

async function doSystemize(app: UiAppEntry) {
  app.busy = true
  render()

  try {
    await systemize(app.packageName)
    app.systemized = true
    app.pending = 'add'
    toast(`已写入 ${app.appName}，重启后生效`)
  } catch (e) {
    toast(errorMessage(e))
  } finally {
    app.busy = false
    render()
  }
}

async function doUnsystemize(app: UiAppEntry) {
  app.busy = true
  render()

  try {
    await unsystemize(app.packageName)
    app.systemized = false
    app.pending = 'remove'
    toast(`已移除 ${app.appName}，重启后生效`)
  } catch (e) {
    toast(errorMessage(e))
  } finally {
    app.busy = false
    render()
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

    dialog.querySelector<HTMLButtonElement>('.dialog-cancel')!.onclick = () => {
      dialog.remove()
      resolve(false)
    }

    dialog.querySelector<HTMLButtonElement>('.dialog-confirm')!.onclick = () => {
      dialog.remove()
      resolve(true)
    }
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
  $('.status-line').textContent = '正在刷新...'

  const [apps, systemized] = await Promise.all([
    getApps(),
    getSystemizedPackages(),
  ])

  state.apps = buildUiApps(apps, systemized)

  $('.status-line').textContent = `已加载 ${state.apps.length} 个应用`
  render()
}

function bindEvents() {
  document.querySelector<HTMLInputElement>('.search-input')!.oninput = e => {
    state.filter = (e.target as HTMLInputElement).value
    render()
  }

  $('.refresh-button').onclick = () => {
    refresh().catch(e => toast(errorMessage(e)))
  }

  $('.diagnose-button').onclick = () => {
    loadDiagnoseDialog()
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
}

bindEvents()
refresh().catch(e => {
  $('.status-line').textContent = errorMessage(e)
  toast(errorMessage(e))
})

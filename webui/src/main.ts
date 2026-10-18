// 【主协调器】页面生命周期、Pull-To-Refresh、节点复用与差异更新

import {
  getAppsSafe,
  getSystemizerState,
  systemize,
  unsystemize,
  setKeepalive,
  diagnose,
  rebootDevice,
  refreshDerived,
  getModuleInfo,
} from './api.ts'
import {
  applyClickResult,
  buildUiApps,
  computeNextOnClick,
  computeSummary,
  deriveKeepalivePackages,
  filterByCategory,
  getDisplayStatus,
  hasPending,
  isSwitchOn,
  mergeBusyState,
  sortApps,
  type ClickResult,
} from './stateMachine.ts'
import type {
  Category,
  SystemizerState,
  UiAppEntry,
} from './types.ts'
import { showConfirm, toast } from './dialogs.ts'
import { IconController } from './icons.ts'
import './style.scss'

// 全局运行时状态（与 DOM 无关的纯数据）
const state = {
  apps: [] as UiAppEntry[],
  filter: '',
  // 单一持久化键 'onlySystemized'（v1.2.x 起沿用，勿改键名：存量用户的开关状态存在这里）
  onlySystemized: localStorage.getItem('onlySystemized') === 'true',
  globalBusy: false,
  rawState: null as SystemizerState | null,
  keepalivePackages: new Set<string>(),
  category: 'app' as Category,
}

const baselineStatus = new Map<string, UiAppEntry['logical']>()
const dirtyPackages = new Set<string>()

const renderedCards = new Map<string, HTMLElement>()
const icons = new IconController()

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

// =============================================================================
// 状态摘要：基准与刷新提示
// =============================================================================
function captureBaseline() {
  baselineStatus.clear()
  dirtyPackages.clear()
  for (const app of state.apps) {
    baselineStatus.set(app.packageName, app.logical)
  }
  updateRefreshHint()
}

function markDirtyState(app: UiAppEntry) {
  const baseline = baselineStatus.get(app.packageName) ?? 'normal'
  if (app.logical === baseline) {
    dirtyPackages.delete(app.packageName)
  } else {
    dirtyPackages.add(app.packageName)
  }
  updateRefreshHint()
}

function updateRefreshHint() {
  const statusLine = document.querySelector<HTMLElement>('.status-line')
  if (!statusLine) return
  if (state.apps.length === 0) {
    statusLine.classList.add('hidden')
    return
  }
  statusLine.classList.remove('hidden')
  if (dirtyPackages.size > 0) {
    statusLine.textContent = '列表待刷新'
  } else {
    statusLine.textContent = `已加载 ${state.apps.length} 个应用`
  }
}

// =============================================================================
// 视图过滤：根据 category + 搜索词 + "仅看系统化"
// =============================================================================
function visibleApps(): UiAppEntry[] {
  const q = state.filter.trim().toLowerCase()

  return sortApps(
    filterByCategory(state.apps, state.category).filter((app) => {
      if (state.onlySystemized) {
        // 开关语义：隐藏 logical==='normal' 的应用，
        // 即保留「已系统化 / 已保活 / 待系统化 / 待移除」四类，
        // 与概览「已处理 + 待重启」两栏口径完全一致。
        if (app.logical === 'normal') return false
      }

      if (!q) return true

      return app.appName.toLowerCase().includes(q)
        || app.packageName.toLowerCase().includes(q)
    }),
    state.category,
  )
}

// =============================================================================
// 卡片渲染：创建、差异更新（绝不重排整棵树）
// =============================================================================
function statusClassFor(app: UiAppEntry): string {
  switch (app.logical) {
    case 'pending_add': return 'is-pending-add'
    case 'pending_remove': return 'is-pending-remove'
    case 'systemized': return 'is-systemized'
    case 'keepalive': return 'is-keepalive'
    case 'normal':
    default: return 'is-normal'
  }
}

function renderCardInner(app: UiAppEntry): string {
  const on = isSwitchOn(app.actual, app.intent, state.category)
  const display = getDisplayStatus(app.actual, app.intent)
  const pkgEscaped = escapeHtml(app.packageName)
  const nameEscaped = escapeHtml(app.appName)
  const initial = escapeHtml((app.appName || app.packageName).slice(0, 1).toUpperCase())

  return `
    <div class="icon-wrap" data-package="${pkgEscaped}">
      <div class="icon-loader"></div>
      <img class="app-icon" data-package="${pkgEscaped}" alt="" draggable="false" />
      <div class="icon-fallback">${initial}</div>
    </div>
    <div class="app-info">
      <div class="app-name">${nameEscaped}</div>
      <div class="package-name">${pkgEscaped}</div>
      <div class="app-status ${statusClassFor(app)}">${display.formattedHtml}</div>
    </div>
    <button class="switch ${on ? 'is-on' : ''} ${app.busy ? 'is-busy' : ''}" aria-label="切换状态">
      <span class="switch-thumb"></span>
    </button>
  `
}

// 视口感知分流：仅 index < viewportCardLimit 的卡片走 enter → enter-done 动画，
// 视口外卡片以 enter-done 状态静默就位，零动画算力。
function createCardElement(app: UiAppEntry, index = 0, animate = true): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.innerHTML = `
    <article
      class="app-card ${animate ? 'enter' : 'enter-done'}"
      style="
        --enter-delay: ${animate ? Math.min(index * 20, 160) : 0}ms;
        --enter-index: ${index};
      "
      data-package="${escapeHtml(app.packageName)}"
    >
      ${renderCardInner(app)}
    </article>
  `

  const card = wrapper.firstElementChild as HTMLElement
  icons.attach(card.querySelector<HTMLElement>('.icon-wrap')!)
  return card
}

function updateCardElement(card: HTMLElement, app: UiAppEntry) {
  const on = isSwitchOn(app.actual, app.intent, state.category)

  const status = card.querySelector<HTMLElement>('.app-status')
  if (status) {
    const display = getDisplayStatus(app.actual, app.intent)
    status.innerHTML = display.formattedHtml
    status.className = `app-status ${statusClassFor(app)}`
  }

  const sw = card.querySelector<HTMLElement>('.switch')
  if (sw) {
    sw.className = `switch ${on ? 'is-on' : ''} ${app.busy ? 'is-busy' : ''}`
  }
}

// =============================================================================
// 局部更新：仅刷新单张卡片内容（不重排）
// 用于 busy 态切换等「不改变排序键」的场景，保证列表滚动零卡顿。
// =============================================================================
function updateCardDOM(pkg: string) {
  const app = state.apps.find((item) => item.packageName === pkg)
  if (!app) return

  const card = renderedCards.get(pkg)
  if (!card) return

  updateCardElement(card, app)
  renderSummary()
  renderRebootButton()
}

// 退场动画时长，必须与 .app-card.enter-done.leave 里最长的 max-height/padding/margin
// 过渡（220ms）保持一致；动画末帧刚好被 setTimeout 摘除，无残留。
const LEAVE_MS = 220

// 视口感知分流：视口外的卡片立即 remove（不会被用户看见），
// 视口内的卡片从实测高度塌缩，避免 160px 起步空转 + 一帧内整批消失的跳变。
function removeHiddenCards(visiblePkgs: Set<string>) {
  const vh = window.innerHeight

  // 第一趟：只读几何，避免读写交替触发多次强制重排
  type Pending = { pkg: string; card: HTMLElement; mode: 'animate' | 'instant' }
  const leaving: Pending[] = []
  for (const [pkg, card] of renderedCards) {
    if (visiblePkgs.has(pkg)) continue
    const rect = card.getBoundingClientRect()
    // 视口下方：立即摘除
    // 视口上方 / 与视口相交：走动画（塌缩会带动可见区内容连续上移）
    leaving.push({ pkg, card, mode: rect.top >= vh ? 'instant' : 'animate' })
  }

  // 第二趟：统一写入
  for (const { pkg, card, mode } of leaving) {
    // 立即出账：后续 render 会按新可见集合重建元素，不会与 .leave 冲突
    renderedCards.delete(pkg)
    if (mode === 'instant') {
      card.remove()
    } else {
      // 两帧法：把 maxHeight 起始值跨过一次帧边界
      //   1) 固化为实测高度（h ≈ 88px，远小于 .enter.enter-done 的 160px）
      //   2) 同一帧内若直接 .leave + maxHeight:0，浏览器会拿 160px 作为 transition 起点，前 ~45% 时长空转
      //   3) rAF 把起始值的样式变更与 .leave 类写入分到两个独立样式帧，确保塌缩从 h 起
      //   4) setTimeout 兜底 rAF 抖动也能按计划摘除
      const h = card.getBoundingClientRect().height
      card.style.maxHeight = `${h}px`
      requestAnimationFrame(() => {
        card.classList.add('leave')
        card.style.maxHeight = '0px'
      })
      setTimeout(() => card.remove(), LEAVE_MS + 32)
    }
  }
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

  const visiblePkgs = new Set(apps.map((app) => app.packageName))
  removeHiddenCards(visiblePkgs)

  // 视口感知：卡片高约 80px + 12px gap，预留 2 张冗余，
  // 超过首屏范围的卡片以 enter-done 状态静默就位，零动画算力
  const viewportCardLimit = Math.ceil(window.innerHeight / 92) + 2

  // 批量挂载 + 收集需要启动入场的卡片，统一一帧触发合成动画
  const pendingEnterCards: HTMLElement[] = []
  const fragment = document.createDocumentFragment()

  apps.forEach((app, index) => {
    let card = renderedCards.get(app.packageName)
    if (!card) {
      const shouldAnimate = index < viewportCardLimit
      card = createCardElement(app, index, shouldAnimate)
      card.style.order = String(index)
      renderedCards.set(app.packageName, card)
      fragment.appendChild(card)
      if (shouldAnimate) pendingEnterCards.push(card)
    } else {
      updateCardElement(card, app)
      card.style.order = String(index)
    }
  })

  if (fragment.children.length > 0) {
    list.appendChild(fragment)
  }
  if (pendingEnterCards.length > 0) {
    requestAnimationFrame(() => {
      pendingEnterCards.forEach((c) => c.classList.add('enter-done'))
    })
  }

  renderSummary()
  renderRebootButton()
  icons.refresh()
  revealList()
}

function revealList() {
  const loading = document.querySelector<HTMLElement>('.loading-state')
  const list = document.querySelector<HTMLElement>('.app-list')

  if (loading) loading.classList.add('hidden')

  if (list) {
    list.classList.remove('is-loading')
    requestAnimationFrame(() => list.classList.add('is-ready'))
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

  if (empty) empty.classList.add('hidden')
  if (loading) loading.classList.remove('hidden')
}

// =============================================================================
// 概览卡片：首栏固定为「已处理」全局口径，第二栏「待重启」全局口径
// （v1.2.1：统计与当前分类解耦，用户在任何分类下都能看到全局进度）
// =============================================================================
function renderSummary() {
  const summary = computeSummary(state.apps)
  $('.summary-systemized').textContent = String(summary.systemized)
  $('.summary-pending').textContent = String(summary.pending)

  // 首栏标签固定：已处理 = 已系统化 + 已保活
  $('.summary-systemized-label').textContent = '已处理'
  $('.summary-pending-label').textContent = '待重启'

  const categoryTitle = $('.summary-category-title')
  const categorySubtitle = $('.summary-category-subtitle')
  if (state.category === 'app') {
    categoryTitle.textContent = 'app'
    categorySubtitle.textContent = 'system/app'
  } else {
    categoryTitle.textContent = '仅保活'
    categorySubtitle.textContent = '实时生效'
  }
}

function renderRebootButton() {
  const button = $('.reboot-fab')
  button.classList.toggle('is-hot', hasPending(state.apps))
}

// =============================================================================
// 开关点击：依据 category 与 current logical 由状态机推导下个状态
// =============================================================================
async function toggleApp(app: UiAppEntry) {
  if (state.globalBusy || app.busy) return

  const on = isSwitchOn(app.actual, app.intent, state.category)
  const intent = on ? 'off' : 'on'
  const result: ClickResult | null = computeNextOnClick(app.logical, state.category, intent)

  if (!result) return

  if (state.category === 'app') {
    await executeAppCategoryClick(app, result)
  } else {
    await executeKeepaliveCategoryClick(app, result)
  }
}

async function executeAppCategoryClick(app: UiAppEntry, result: ClickResult) {
  // S2: 待系统化 → 取消（走 unsystemize 接口回滚 PendingAdd）
  if (app.logical === 'pending_add' && result.nextLogical === 'normal') {
    await doUnsystemize(app, '已取消待系统化', result)
    return
  }
  // S3: 已系统化 → 标记待移除（先二次确认）
  if (app.logical === 'systemized' && result.nextLogical === 'pending_remove') {
    app.busy = true
    updateCardDOM(app.packageName)
    const ok = await confirmRemove(app)
    app.busy = false
    if (!ok) {
      updateCardDOM(app.packageName)
      return
    }
    await doUnsystemize(app, '已记录待移除', result)
    return
  }
  // S4: 待移除 → 撤销
  if (app.logical === 'pending_remove' && result.nextLogical === 'systemized') {
    if (state.keepalivePackages.has(app.packageName)) {
      await setKeepalive(app.packageName, false)
      state.keepalivePackages.delete(app.packageName)
    }
    await doSystemize(app, '已撤销移除', result)
    return
  }
  // S1 → S2 / S5 → S2：开启系统化
  if (result.nextLogical === 'pending_add') {
    await doSystemize(app, '已记录待系统化', result)
    return
  }
}

async function executeKeepaliveCategoryClick(app: UiAppEntry, result: ClickResult) {
  // S1/S2 → S5：开启保活，即时生效
  if (result.nextLogical === 'keepalive') {
    await doSetKeepalive(app, true, '已加入保活白名单', result)
    return
  }
  // S5 → S1：关闭保活，即时生效
  if (app.logical === 'keepalive' && result.nextLogical === 'normal') {
    await doSetKeepalive(app, false, '已退出保活白名单', result)
    return
  }
  // S3 → S4：已系统化开启保活 → 后台同步保活白名单 + 标记待移除
  if (app.logical === 'systemized' && result.nextLogical === 'pending_remove') {
    await doKeepaliveFromSystemized(app, result)
    return
  }
  // S4 → 开：已系统化待移除点开保活（保活即时生效）
  if (app.logical === 'pending_remove' && result.nextActual === 'keepalive') {
    await doSetKeepalive(app, true, '已加入保活白名单', result, /* preserveIntent */ true)
    return
  }
  // S4 → 关：已系统化待移除在保活视图关闭保活
  if (app.logical === 'pending_remove' && result.nextActual === 'none') {
    await doSetKeepalive(app, false, '已退出保活白名单', result, /* preserveIntent */ true)
    return
  }
  // S5 → S2：保活状态下打开系统化（互斥）
  if (app.logical === 'keepalive' && result.nextLogical === 'pending_add') {
    await doKeepaliveToSystemize(app, result)
    return
  }
}

async function doSystemize(app: UiAppEntry, msg: string, result: ClickResult) {
  app.busy = true
  updateCardDOM(app.packageName)

  try {
    await systemize(app.packageName)
    const next = applyClickResult(app, result)
    Object.assign(app, next)
    app.busy = false
    updateCardDOM(app.packageName)
    markDirtyState(app)
    toast(msg)
  } catch (e) {
    app.busy = false
    updateCardDOM(app.packageName)
    toast(errorMessage(e))
  }
}

async function doUnsystemize(app: UiAppEntry, msg: string, result: ClickResult) {
  app.busy = true
  updateCardDOM(app.packageName)

  try {
    await unsystemize(app.packageName)
    const next = applyClickResult(app, result)
    Object.assign(app, next)
    app.busy = false
    updateCardDOM(app.packageName)
    markDirtyState(app)
    toast(msg)
  } catch (e) {
    app.busy = false
    updateCardDOM(app.packageName)
    toast(errorMessage(e))
  }
}

async function doSetKeepalive(
  app: UiAppEntry,
  enabled: boolean,
  msg: string,
  result: ClickResult,
  preserveIntent = false,
) {
  app.busy = true
  updateCardDOM(app.packageName)

  try {
    await setKeepalive(app.packageName, enabled)
    if (enabled) state.keepalivePackages.add(app.packageName)
    else state.keepalivePackages.delete(app.packageName)

    let next = applyClickResult(app, result)
    if (preserveIntent) {
      next = { ...next, intent: app.intent, logical: app.logical }
    }
    Object.assign(app, next)
    app.busy = false
    updateCardDOM(app.packageName)
    markDirtyState(app)
    toast(msg)
  } catch (e) {
    app.busy = false
    updateCardDOM(app.packageName)
    toast(errorMessage(e))
  }
}

async function doKeepaliveFromSystemized(app: UiAppEntry, result: ClickResult) {
  app.busy = true
  updateCardDOM(app.packageName)
  try {
    // CLI `keepalive <pkg> on` 对已系统化应用本身就是一次原子迁移：
    // 摘掉 system/app 目录 + 置 keepalive_only + 标记 pending_remove。
    // 因此不再补一条 unsystemize（多余，且会引入两条命令之间的中间态）。
    await setKeepalive(app.packageName, true)
    state.keepalivePackages.add(app.packageName)
    const next = applyClickResult(app, result)
    Object.assign(app, next)
    app.busy = false
    updateCardDOM(app.packageName)
    markDirtyState(app)
    toast('已加入保活白名单，重启后将移出 system/app')
  } catch (e) {
    app.busy = false
    updateCardDOM(app.packageName)
    toast(errorMessage(e))
  }
}

async function doKeepaliveToSystemize(app: UiAppEntry, result: ClickResult) {
  app.busy = true
  updateCardDOM(app.packageName)
  try {
    // 先撤销保活（互斥），再标记待系统化
    await setKeepalive(app.packageName, false)
    state.keepalivePackages.delete(app.packageName)
    await systemize(app.packageName)
    const next = applyClickResult(app, result)
    Object.assign(app, next)
    app.busy = false
    updateCardDOM(app.packageName)
    markDirtyState(app)
    toast('已记录待系统化（保活已撤销）')
  } catch (e) {
    app.busy = false
    updateCardDOM(app.packageName)
    toast(errorMessage(e))
  }
}

// =============================================================================
// 错误处理与对话框
// =============================================================================
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function showFatalError(e: unknown) {
  const message = errorMessage(e)

  const statusLine = document.querySelector<HTMLElement>('.status-line')
  const loading = document.querySelector<HTMLElement>('.loading-state')
  if (loading) loading.classList.add('hidden')

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

async function loadDiagnoseDialog() {
  try {
    const out = await diagnose()
    let msg = out || '无诊断输出'
    if (state.rawState) {
      const records = Object.values(state.rawState.apps ?? {})
      const active = records.filter((r) => r.status === 'active').length
      const pendingAdd = records.filter((r) => r.status === 'pending_add').length
      const pendingRemove = records.filter((r) => r.status === 'pending_remove').length

      msg += `\n\n--- UI 状态映射 ---\n已系统化: ${active}\n待系统化: ${pendingAdd}\n待移除: ${pendingRemove}\n`
    }

    const shouldRefresh = await showConfirm({
      title: '诊断信息',
      message: msg,
      cancelText: '关闭',
      confirmText: '刷新',
      diagnostic: true,
    })

    if (shouldRefresh) {
      refresh('diagnose').catch(showFatalError)
    }
  } catch (e) {
    toast(errorMessage(e))
  }
}

// =============================================================================
// 数据加载与刷新
// =============================================================================
type RefreshMode = 'initial' | 'manual' | 'pull' | 'diagnose' | 'search' | 'search-cancel'

async function refresh(mode: RefreshMode = 'manual') {
  if (state.globalBusy) return

  state.globalBusy = true

  const statusLine = document.querySelector<HTMLElement>('.status-line')

  // pull / search* 为静默刷新：保留既有列表，不切到 loading 骨架屏，
  // 否则搜索结算时列表会整屏闪一下。
  const quiet = mode === 'pull' || mode === 'search' || mode === 'search-cancel'

  if (quiet) {
    if (statusLine) {
      statusLine.classList.remove('hidden')
      statusLine.textContent = '正在刷新...'
    }
  } else {
    showAppLoading()
    if (statusLine) {
      statusLine.classList.add('hidden')
      statusLine.textContent = '正在刷新...'
    }
  }

  try {
    const oldApps = state.apps

    const apps = await getAppsSafe()
    // 只读一次 state-json：state 与保活集合必须来自同一快照，
    // 且读取失败必须冒泡（曾经 catch 成空状态，界面会把已系统化/已保活全显示成未处理）。
    const sysState = await getSystemizerState()
    state.keepalivePackages = deriveKeepalivePackages(sysState)
    state.rawState = sysState

    let nextApps = buildUiApps(apps, sysState, state.keepalivePackages)
    nextApps = mergeBusyState(nextApps, oldApps)

    state.apps = nextApps
    captureBaseline()

    if (statusLine) {
      statusLine.textContent = `已加载 ${state.apps.length} 个应用`
    }

    // 位置变化统一跟随刷新动作生效：先记录旧坐标，render() 改写 order 后再 FLIP。
    // 开关点击只更新卡片内容、不再即时重排，避免「刚点完就跳位」。
    const previous = captureCardRects()
    render()
    playFlip(previous)

    refreshDerived().catch(() => {})
  } catch (e) {
    showFatalError(e)
  } finally {
    state.globalBusy = false
  }
}

// =============================================================================
// FLIP 过渡：仅在分类切换时启用
//   First  - render() 之前记录每张可见卡片的 getBoundingClientRect()
//   Last   - render() 之后卡片已在新 order 位置
//   Invert  - 用 transform 把卡片瞬间移回旧坐标（不触发 reflow）
//   Play   - 下一帧移除 transform，交由 CSS transition 平滑过渡
// 单卡片局部更新仍走节点复用，不触发 FLIP，保证列表滚动流畅。
// =============================================================================
type CardRect = { top: number; left: number; width: number; height: number }

function captureCardRects(): Map<string, CardRect> {
  const rects = new Map<string, CardRect>()
  for (const [pkg, card] of renderedCards) {
    const r = card.getBoundingClientRect()
    rects.set(pkg, { top: r.top, left: r.left, width: r.width, height: r.height })
  }
  return rects
}

function playFlip(previous: Map<string, CardRect>) {
  if (previous.size === 0) return

  const animations: Array<{ card: HTMLElement; dx: number; dy: number }> = []

  for (const [pkg, card] of renderedCards) {
    const before = previous.get(pkg)
    if (!before) continue
    const after = card.getBoundingClientRect()
    const dx = before.left - after.left
    const dy = before.top - after.top
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
    animations.push({ card, dx, dy })
  }

  if (animations.length === 0) return

  const list = document.querySelector<HTMLElement>('.app-list')

  // Invert 阶段：
  // 1) 显式关闭 transition，避免浏览器把本次 transform 变更也纳入过渡而被合并丢弃
  // 2) 立即写入 translate，把卡片瞬间移回旧坐标
  // 3) 强制回流（读取 offsetHeight），确保 Invert 状态被浏览器确认为一个独立样式帧；
  //    若缺少这一步，同一帧内的 transition 开启 + transform 清除会被合并，动画直接丢失
  for (const { card, dx, dy } of animations) {
    card.classList.add('is-flipping')
    card.style.transition = 'none'
    card.style.transform = `translate(${dx}px, ${dy}px)`
  }
  void list?.offsetHeight

  requestAnimationFrame(() => {
    for (const { card } of animations) {
      // Play 阶段：显式声明过渡曲线，再清空 transform 触发回移动画
      card.style.transition = 'transform 360ms cubic-bezier(0.2, 0.8, 0.2, 1)'
      card.style.transform = ''
    }
    window.setTimeout(() => {
      for (const { card } of animations) {
        card.style.transition = ''
        card.classList.remove('is-flipping')
      }
    }, 380)
  })
}

// =============================================================================
// 分类切换：app ↔ keepalive（带 FLIP 过渡）
// =============================================================================
function toggleCategory() {
  const previous = captureCardRects()
  state.category = state.category === 'app' ? 'keepalive' : 'app'
  // 切换分类时强制走一次可见性过滤
  render()
  playFlip(previous)
}

// =============================================================================
// 事件绑定
// =============================================================================
function bindEvents() {
  const searchInput = document.querySelector<HTMLInputElement>('.search-input')!
  let searchTimeout: ReturnType<typeof setTimeout>

  // 搜索结算的两个刷新时机（空搜索不算）：
  //   1. 真正搜出结果（非空且有命中）→ 刷新一次
  //   2. 有结果之后取消搜索（清空）→ 再刷新一次
  // 两次都走 refresh()，由它内部的 FLIP 把「待刷新」的位置变化连动画一起落地。
  let lastSettledQuery = ''
  let lastHadResults = false

  function runSearchRefresh(mode: RefreshMode) {
    // 已有刷新在跑时不能直接丢弃：filter 已经改了，至少也要重绘一次
    if (state.globalBusy) {
      render()
      return
    }
    refresh(mode).catch(showFatalError)
  }

  function settleSearch() {
    const raw = searchInput.value
    const q = raw.trim()
    state.filter = raw

    if (q !== '') {
      lastHadResults = visibleApps().length > 0
      lastSettledQuery = q
      runSearchRefresh('search')
      return
    }

    if (lastSettledQuery !== '' && lastHadResults) {
      lastSettledQuery = ''
      lastHadResults = false
      runSearchRefresh('search-cancel')
      return
    }

    lastSettledQuery = ''
    lastHadResults = false
    render()
  }

  searchInput.oninput = () => {
    clearTimeout(searchTimeout)
    searchTimeout = setTimeout(settleSearch, 180)
  }

  searchInput.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    clearTimeout(searchTimeout)
    settleSearch()
    searchInput.blur()
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

  // 概览卡片最右侧：点击切换分类
  const categoryBlock = document.querySelector<HTMLElement>('.summary-category')
  if (categoryBlock) {
    const switchCategory = () => toggleCategory()
    categoryBlock.addEventListener('click', switchCategory)
    categoryBlock.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        switchCategory()
      }
    })
  }

  // 列表事件委托：点击卡片触发开关
  $('.app-list').onclick = (event) => {
    const target = event.target as HTMLElement
    const card = target.closest('.app-card') as HTMLElement
    if (!card) return

    const pkg = card.dataset.package
    if (!pkg) return

    const app = state.apps.find((item) => item.packageName === pkg)
    if (!app) return

    toggleApp(app)
  }

  // 下拉菜单
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

  const toggleOnlySys = document.getElementById('toggle-only-sys') as HTMLInputElement
  if (toggleOnlySys) {
    toggleOnlySys.checked = state.onlySystemized
    toggleOnlySys.onchange = (e) => {
      state.onlySystemized = (e.target as HTMLInputElement).checked
      localStorage.setItem('onlySystemized', String(state.onlySystemized))
      // 勾选切换：记录卡片几何位置 → 渲染 → FLIP 协同，
      // 让已有卡片走 transform 平滑滑入新位置，不再被新插入卡片瞬间挤压
      const previous = captureCardRects()
      render()
      playFlip(previous)
    }
  }

  document.getElementById('menu-diagnose')!.onclick = () => {
    dropdownMenu.classList.remove('show')
    loadDiagnoseDialog()
  }

  document.getElementById('menu-clear-icons')!.onclick = () => {
    dropdownMenu.classList.remove('show')
    icons.reset()
    toast('已重新加载图标')
  }

  document.getElementById('menu-about')!.onclick = async () => {
    dropdownMenu.classList.remove('show')
    try {
      const info = await getModuleInfo()
      showConfirm({
        title: '关于 Z-Systemizer',
        htmlMessage:
          `Z-Systemizer 模块 WebUI<br>版本: ${escapeHtml(info.version)}<br>${escapeHtml(info.description)}<br><br>` +
          `<a href="https://github.com/Zzz-IT/Z-Systemizer" target="_blank" style="color: var(--accent); text-decoration: none; font-weight: 500;">访问 GitHub 仓库</a>`,
        cancelText: '关闭',
        confirmText: '确定',
      })
    } catch (e) {
      showConfirm({
        title: '关于 Z-Systemizer',
        htmlMessage:
          `Z-Systemizer 模块 WebUI<br>版本: 未知<br>持久状态与自动同步<br>(获取模块信息失败: ${escapeHtml(errorMessage(e))})<br><br>` +
          `<a href="https://github.com/Zzz-IT/Z-Systemizer" target="_blank" style="color: var(--accent); text-decoration: none; font-weight: 500;">访问 GitHub 仓库</a>`,
        cancelText: '关闭',
        confirmText: '确定',
      })
    }
  }

  // Pull-To-Refresh
  // 性能要点（v1.2.1）：指示器与内容层都只动 transform / opacity，
  // 全程不写 height，因此 .app-list 的 20+ 张卡片不会被逐帧重排。
  const region = document.querySelector<HTMLElement>('.app-region')!
  const indicator = document.querySelector<HTMLElement>('.ptr-indicator')!
  const spinner = document.querySelector<HTMLElement>('.ptr-spinner')!
  const content = document.querySelector<HTMLElement>('.ptr-content')!

  let startX = 0
  let startY = 0
  let pulling = false
  // claimed：手势已被下拉接管。接管后即便 dy ≤ 0 也要继续驱动，
  // 让回拉过起点时角度继续反向旋转，页面不滚动。
  let claimed = false
  let distance = 0
  let frame = 0

  const threshold = 72
  const maxPull = 112

  function ignored(target: EventTarget | null): boolean {
    return target instanceof HTMLElement
      && !!target.closest('input, button, .dialog-backdrop, .dropdown-menu')
  }

  // 拖动期 transform 100% 由 JS 接管：
  //   - 角度不 clamp：纯函数 progress = value/threshold，回拉自动反向；过阈值继续转
  //   - 缩放要 clamp：圆环不应超过满尺寸，使用 scaleProgress = min(progress, 1)
  //   - 松手时由 --spin-from CSS 变量把残余角度注入 keyframes，零相位跳变
  function applyPull(value: number) {
    const d = Math.max(0, Math.min(value, maxPull))
    const progress = d / threshold
    const scaleProgress = Math.min(progress, 1)
    const translate = `translateY(${d}px)`

    indicator.style.transform = translate
    indicator.style.opacity = String(scaleProgress)
    content.style.transform = translate
    spinner.style.transform =
      `rotate(${progress * 360}deg) scale(${0.6 + 0.4 * scaleProgress})`
    distance = d
  }

  // 手指拖动期间禁用圆环过渡（已在 SCSS 配 .is-pulling .ptr-spinner { transition: none }）
  function beginPulling() {
    indicator.classList.add('is-pulling')
    content.classList.add('is-pulling')
  }

  function releasePull() {
    indicator.classList.remove('is-pulling')
    content.classList.remove('is-pulling')
    spinner.classList.remove('active')

    indicator.style.transform = 'translateY(0)'
    indicator.style.opacity = '0'
    content.style.transform = 'translateY(0)'
    // 角度从当前位置平滑退回 0°，消除「相位归零」瞬跳；
    // 由于 is-pulling 已摘除，spinner 重新有 transition，会平滑回绕。
    spinner.style.transform = 'rotate(0deg) scale(0.6)'
    distance = 0
  }

  region.addEventListener('touchstart', (e) => {
    if (state.globalBusy) return
    if (ignored(e.target)) return
    if (window.scrollY !== 0) return

    const touch = e.touches[0]
    startX = touch.clientX
    startY = touch.clientY
    pulling = true
    claimed = false
    distance = 0
  }, { passive: true })

  region.addEventListener('touchmove', (e) => {
    if (!pulling || state.globalBusy) return
    const touch = e.touches[0]
    const dx = touch.clientX - startX
    const dy = touch.clientY - startY

    if (!claimed) {
      // 初次判断：未接管前，dy ≤ 0 或横移大于纵移 → 不接管
      if (dy <= 0) return
      if (Math.abs(dx) > Math.abs(dy)) return
      claimed = true
      beginPulling()
    }

    // 已接管：永远 preventDefault 阻止页面滚动，
    // 并把 dy clamp 到 0 继续更新距离与角度。
    e.preventDefault()
    // 先同步记账、再排队上屏：touchend 会 cancel 掉尚未执行的帧，
    // 若 distance 只在帧回调里更新，快速甩动后松手就会读到旧值而丢掉这次刷新。
    const eased = Math.min(Math.pow(Math.max(0, dy), 0.82), maxPull)
    distance = eased
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (!pulling) return
      applyPull(distance)
    })
  }, { passive: false })

  region.addEventListener('touchend', () => {
    if (frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    if (!pulling) return
    pulling = false
    claimed = false

    if (distance < threshold || state.globalBusy) {
      releasePull()
      return
    }

    // 松手交接（≥ 阈值）：
    // 1. 计算残余角度 = (distance/threshold) * 360°；此时 progress ≥ 1，角度可达 560°（1.5 圈）
    // 2. setProperty('--spin-from', angle) 注入 keyframes（一次性，绝不每帧写）
    // 3. 挂 .active 启动 ptr-spin 动画
    // 4. 清内联 transform 交给 keyframes
    // 同一 JS 任务内完成，浏览器只解析最终状态。
    // 角度从 --spin-from 平滑转到 --spin-from+360°，位置上 = 原地起步，零跳变。
    // 缩放：进度 ≥ 1 ⇒ scaleProgress = 1 ⇒ 内联 scale(1)，与 keyframes scale(1) 天然一致。
    const angle = (distance / threshold) * 360
    indicator.classList.remove('is-pulling')
    content.classList.remove('is-pulling')
    indicator.classList.add('is-refreshing')
    indicator.style.transform = `translateY(${threshold}px)`
    indicator.style.opacity = '1'
    content.style.transform = `translateY(${threshold}px)`
    spinner.style.setProperty('--spin-from', `${angle}deg`)
    spinner.classList.add('active')
    spinner.style.transform = ''

    const statusLine = document.querySelector<HTMLElement>('.status-line')
    if (statusLine) statusLine.textContent = '正在刷新...'

    refresh('pull')
      .catch(showFatalError)
      .finally(() => {
        indicator.classList.remove('is-refreshing')
        releasePull()
      })
  })

  region.addEventListener('touchcancel', () => {
    if (frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    if (!pulling) return
    pulling = false
    claimed = false
    releasePull()
  })
}

bindEvents()
refresh().catch(showFatalError)
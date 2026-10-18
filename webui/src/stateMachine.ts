// 【纯函数状态机】
// 不依赖 DOM、不依赖 api 层：所有计算均为纯函数，便于单元测试
// 详细规范见 REFACTOR_AND_OPERATION_MANUAL.md §2

import type {
  ActualStatus,
  AppDisplayStatus,
  AppEntry,
  AppRecord,
  Category,
  IntentStatus,
  LogicalStatus,
  SummaryStats,
  SystemizerState,
  UiAppEntry,
} from './types.ts'

// =============================================================================
// 维度 1：从后端持久化 AppRecord 推出开机后物理基准 ActualStatus
// 关键：pending_add 表示"用户标记了、但尚未重启落盘"，物理现状仍是 'none'
// =============================================================================
export function deriveActual(record: AppRecord | undefined): ActualStatus {
  if (!record) return 'none'

  // 只有「active」才代表当前开机状态下真的驻留在 system/app；
  // pending_remove 在重启前仍驻留在 system/app，物理基准也是 systemized。
  // pending_add 表示"用户标记了待添加"，未重启时仍是普通应用，应返回 'none'。
  if (record.status === 'active' || record.status === 'pending_remove') {
    return 'systemized'
  }

  return 'none'
}

// =============================================================================
// 维度 2：从后端持久化 AppRecord 推出意图 IntentStatus
// =============================================================================
export function deriveIntent(record: AppRecord | undefined): IntentStatus {
  if (!record) return 'none'

  switch (record.status) {
    case 'pending_add':
      return 'pending_add'
    case 'pending_remove':
      return 'pending_remove'
    default:
      return 'none'
  }
}

// =============================================================================
// 组合：将 actual + intent 折叠为 5 态之一的 LogicalStatus
// =============================================================================
export function collapseLogical(actual: ActualStatus, intent: IntentStatus): LogicalStatus {
  if (intent === 'pending_add') return 'pending_add'
  if (intent === 'pending_remove') return 'pending_remove'
  if (actual === 'systemized') return 'systemized'
  if (actual === 'keepalive') return 'keepalive'
  return 'normal'
}

// =============================================================================
// 互斥判定：在 category 视图下，开关是否应处于 ON
// =============================================================================
export function isSwitchOn(
  actual: ActualStatus,
  intent: IntentStatus,
  category: Category,
): boolean {
  if (category === 'app') {
    if (actual === 'systemized') {
      // 已系统化且尚未标记移除
      return intent !== 'pending_remove'
    }
    // 普通应用只要被标记待系统化，就视为开启
    return intent === 'pending_add'
  }

  // keepalive 视图：保活即时生效，开关 = actual === 'keepalive'
  return actual === 'keepalive'
}

// =============================================================================
// 白黄双色小字渲染契约
// 红线 1：禁止出现"待保活"
// 红线 2：白字与黄字之间必须且仅能使用单个半角空格
// =============================================================================
export function getDisplayStatus(actual: ActualStatus, intent: IntentStatus): AppDisplayStatus {
  // v1.2.1：白字部分统一使用「已系统化 / 已保活 / 未处理」，
  // 未处理 = 当前既没有系统化也没有保活的普通应用（无论是否被标记待系统化）
  const actualText =
    actual === 'systemized' ? '已系统化' :
    actual === 'keepalive'   ? '已保活'   :
                                '未处理'

  let intentText: AppDisplayStatus['intentText'] = null
  if (intent === 'pending_add') intentText = '待系统化'
  if (intent === 'pending_remove') {
    // S3→S5 边界态：白字已是「已保活」，「待移除」会与主语脱节。
    // 此时黄字必须把动作方向和对象补齐 →「待移除系统化」。
    // app 视图下白字已是「已系统化」，「待移除」主语明确，保留短词。
    intentText = actual === 'keepalive' ? '待移除系统化' : '待移除'
  }

  if (intentText) {
    // 红线 2：单个半角空格
    const plainText = `${actualText} ${intentText}`
    const formattedHtml =
      `<span class="status-actual">${actualText}</span> ` +
      `<span class="status-intent">${intentText}</span>`
    return { actualText, intentText, formattedHtml, plainText }
  }

  return {
    actualText,
    intentText: null,
    formattedHtml: `<span class="status-actual">${actualText}</span>`,
    plainText: actualText,
  }
}

// =============================================================================
// 用户操作行为 → 下一状态推导（用于点击 switch 的决策表）
// 文档 §2.4 S1~S5 状态流转矩阵
// =============================================================================
export type SwitchIntent = 'on' | 'off'

export interface ClickResult {
  nextLogical: LogicalStatus
  nextActual: ActualStatus
  nextIntent: IntentStatus
}

export function computeNextOnClick(
  current: LogicalStatus,
  category: Category,
  intent: SwitchIntent,
): ClickResult | null {
  if (category === 'app') {
    // 系统化视图
    switch (current) {
      case 'normal':
        // 普通应用点开 → S2：未系统化 + 待系统化
        return intent === 'on'
          ? { nextLogical: 'pending_add', nextActual: 'none', nextIntent: 'pending_add' }
          : null
      case 'pending_add':
        // 待系统化点关 → 取消待系统化，回到 S1
        return intent === 'off'
          ? { nextLogical: 'normal', nextActual: 'none', nextIntent: 'none' }
          : null
      case 'systemized':
        // 已系统化点关 → 标记待移除 S4
        return intent === 'off'
          ? { nextLogical: 'pending_remove', nextActual: 'systemized', nextIntent: 'pending_remove' }
          : null
      case 'pending_remove':
        // 待移除点开 → 撤销移除，回到 S3
        return intent === 'on'
          ? { nextLogical: 'systemized', nextActual: 'systemized', nextIntent: 'none' }
          : null
      case 'keepalive':
        // 在保活状态点系统化开 → 取消保活并标记待系统化（S2）
        return intent === 'on'
          ? { nextLogical: 'pending_add', nextActual: 'none', nextIntent: 'pending_add' }
          : null
    }
  }

  // keepalive 视图
  switch (current) {
    case 'normal':
      // 普通应用点开保活 → S5 即时生效
      return intent === 'on'
        ? { nextLogical: 'keepalive', nextActual: 'keepalive', nextIntent: 'none' }
        : null
    case 'pending_add':
      // 待系统化点开保活 → 互斥：取消待系统化，直接进入 S5
      return intent === 'on'
        ? { nextLogical: 'keepalive', nextActual: 'keepalive', nextIntent: 'none' }
        : null
    case 'systemized':
      // 已系统化点开保活 → 立即加入保活白名单（actual: keepalive），并标记待从 system/app 移除（intent: pending_remove）
      return intent === 'on'
        ? { nextLogical: 'pending_remove', nextActual: 'keepalive', nextIntent: 'pending_remove' }
        : null
    case 'pending_remove':
      // 已系统化待移除，在保活分类下：
      // 开：保活即时生效（actual: keepalive, intent: pending_remove）
      // 关：退出保活白名单（actual: none, intent: pending_remove）
      return intent === 'on'
        ? { nextLogical: 'pending_remove', nextActual: 'keepalive', nextIntent: 'pending_remove' }
        : { nextLogical: 'pending_remove', nextActual: 'none', nextIntent: 'pending_remove' }
    case 'keepalive':
      // 已保活点关 → 撤销保活（S1）
      return intent === 'off'
        ? { nextLogical: 'normal', nextActual: 'none', nextIntent: 'none' }
        : null
  }

  return null
}

// =============================================================================
// 汇总：全局口径（与当前分类无关）
//   systemized = 已处理 = 物理已生效项 = 已系统化 + 已保活
//   pending    = 待重启 = pending_add + pending_remove
// 说明：叠加态（已系统化 + 已保活，即 keepaliveOnly 且 target 仍为 app）会同时计入两侧，
// 这是刻意的：保活此刻已生效（计入已处理），系统目录尚未摘除（计入待重启）。
// CLI 的 module.prop 描述用同一口径（见 main.rs build_description）。
// =============================================================================
export function computeSummary(apps: UiAppEntry[]): SummaryStats {
  let systemized = 0
  let pending = 0

  for (const app of apps) {
    if (app.logical === 'systemized' || app.logical === 'keepalive' || app.actual === 'keepalive') {
      systemized++
    }
    if (app.logical === 'pending_add' || app.logical === 'pending_remove' || app.intent === 'pending_remove' || app.intent === 'pending_add') {
      pending++
    }
  }

  return { systemized, pending }
}

// =============================================================================
// 从持久状态提取保活集合（keepaliveOnly 为 true 的包）。
// 此前 WebUI 为此单独跑一次 state-json，两次 exec 之间若有写入，
// 记录与保活集合就来自不同快照，界面会拼出「已系统化但保活开关灭了」的脏视图。
// =============================================================================
export function deriveKeepalivePackages(state: SystemizerState): Set<string> {
  const out = new Set<string>()
  for (const [pkg, record] of Object.entries(state.apps ?? {})) {
    if (record?.keepaliveOnly) out.add(pkg)
  }
  return out
}

// =============================================================================
// 视图过滤：根据 category 仅保留可见应用
// 设计意图（修复 issue 2）：在【仅保活】分类下必须能"看见全部应用"，
// 否则用户根本无法开启新的保活（列表为空时开关没有可点击目标）。
// 因此 keepalive 视图不主动按 logical 过滤，仅交给「仅看系统化/已生效」开关隐藏未启用项。
// =============================================================================
export function filterByCategory(apps: UiAppEntry[], category: Category): UiAppEntry[] {
  // 两类视图都展示全部应用；隐藏过滤由 onlySystemized 开关与空搜索框回车刷新承担。
  void category
  return apps
}

// =============================================================================
// 排序：分类感知的「三级严格置顶」算法
//
// 核心约束：置顶顺序必须与开关状态保持一致，严禁出现
// 「开关关闭项排在开关打开项之上」的倒挂（修复置顶逻辑倒挂）。
//
//   app 视图（开关 ON = pending_add | systemized）：
//     0 pending_add   ON   待系统化
//     1 systemized    ON   已系统化
//     2 pending_remove OFF  待移除
//     3 keepalive     OFF  已保活
//     4 normal        OFF  未处理
//
//   keepalive 视图（开关 ON = keepalive）：
//     0 keepalive        ON   已保活
//     1 pending_add      OFF  待系统化
//     2 systemized       OFF  已系统化
//     3 pending_remove   OFF  待移除
//     4 normal           OFF  未处理
//
// 同级一律使用 localeCompare(..., 'zh-Hans-CN') 保证中文名字典序稳定。
// =============================================================================
export function sortApps(apps: UiAppEntry[], category: Category = 'app'): UiAppEntry[] {
  const appPriority: Record<LogicalStatus, number> = {
    pending_add: 0,
    systemized: 1,
    pending_remove: 2,
    keepalive: 3,
    normal: 4,
  }

  const keepalivePriority: Record<LogicalStatus, number> = {
    keepalive: 0,
    pending_add: 1,
    systemized: 2,
    pending_remove: 3,
    normal: 4,
  }

  const priority = category === 'keepalive' ? keepalivePriority : appPriority

  return [...apps].sort((a, b) => {
    // 核心契约：当前视图下，开关打开的条目必须严格排在开关关闭的条目之上
    const onA = isSwitchOn(a.actual, a.intent, category)
    const onB = isSwitchOn(b.actual, b.intent, category)
    if (onA !== onB) return onA ? -1 : 1

    const pa = priority[a.logical]
    const pb = priority[b.logical]
    if (pa !== pb) return pa - pb
    return a.appName.localeCompare(b.appName, 'zh-Hans-CN')
  })
}

// =============================================================================
// 工厂函数：根据后端列表与持久状态构建 UI 视图
//
// 两条关键修复：
// 1. 意图继承：严禁无条件把 intent 抹成 'none'。已系统化应用即使被开启保活，
//    其 pending_remove 意图也必须保留，否则「待移除」黄字标记会丢失，
//    用户看不到重启后将被移出 system/app。
// 2. 纵深去重：多用户/双开/分身场景下同一 packageName 可能出现多次，
//    以首次出现的条目为准，后续重复项直接丢弃。
// =============================================================================
export function buildUiApps(
  apps: AppEntry[],
  persisted: SystemizerState,
  keepalivePackages: ReadonlySet<string> = new Set(),
): UiAppEntry[] {
  // 去重：保留首次出现的条目（首个 label 通常信息最全）
  const appMap = new Map<string, AppEntry>()
  for (const app of apps) {
    if (!appMap.has(app.packageName)) appMap.set(app.packageName, app)
  }

  const records = persisted.apps ?? {}
  const rows: UiAppEntry[] = []

  // 同一应用在 app 与 keepalive 两个分类下严格互斥，
  // 因此保活集合内不再强行为 keepalive 而抹掉真实意图。
  const buildRow = (
    app: AppEntry,
    pkg: string,
    fromStateOnly: boolean,
  ): UiAppEntry => {
    const record = records[pkg]
    const inKeepalive = keepalivePackages.has(pkg)
    const actual: ActualStatus =
      inKeepalive ? 'keepalive' : deriveActual(record)
    // 修复：无条件覆盖为 'none' 会丢失 pending_remove，导致待重启标记消失
    const intent: IntentStatus = deriveIntent(record)
    const logical = collapseLogical(actual, intent)

    return {
      ...app,
      logical,
      actual,
      intent,
      busy: false,
      fromStateOnly,
    }
  }

  for (const [pkg, app] of appMap) {
    rows.push(buildRow(app, pkg, false))
  }

  // 持久化中存在但当前 PackageManager 未返回的应用（例如已卸载但仍有待处理记录）
  for (const [pkg, record] of Object.entries(records)) {
    if (appMap.has(pkg)) continue
    const inKeepalive = keepalivePackages.has(pkg)
    const actual: ActualStatus =
      inKeepalive ? 'keepalive' : deriveActual(record)
    const intent: IntentStatus = deriveIntent(record)
    const logical = collapseLogical(actual, intent)

    rows.push({
      packageName: pkg,
      appName: pkg,
      isSystem: true,
      logical,
      actual,
      intent,
      busy: false,
      fromStateOnly: true,
    })
  }

  return rows
}

// =============================================================================
// 合并 UI busy 状态：避免在刷新时丢失"操作进行中"的标记
// =============================================================================
export function mergeBusyState(nextApps: UiAppEntry[], oldApps: UiAppEntry[]): UiAppEntry[] {
  const oldMap = new Map(oldApps.map(app => [app.packageName, app]))

  return nextApps.map(next => {
    const old = oldMap.get(next.packageName)
    if (!old || !old.busy) return next

    return { ...next, busy: old.busy }
  })
}
// =============================================================================
// 局部更新：根据开关点击结果，更新某条目的 logical/actual/intent
// =============================================================================
export function applyClickResult(app: UiAppEntry, result: ClickResult): UiAppEntry {
  return {
    ...app,
    logical: result.nextLogical,
    actual: result.nextActual,
    intent: result.nextIntent,
  }
}

// =============================================================================
// 是否有任何 pending（待重启）条目
// =============================================================================
export function hasPending(apps: UiAppEntry[]): boolean {
  return apps.some(app => app.logical === 'pending_add' || app.logical === 'pending_remove')
}
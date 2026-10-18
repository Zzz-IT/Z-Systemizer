// 兼容垫片：保留旧 API 入口
// 所有实现已迁移到 types.ts + stateMachine.ts（高内聚纯逻辑层）

export type {
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

// 兼容旧 UiStatus 命名
export type UiStatus = 'normal' | 'systemized' | 'pending-add' | 'pending-remove'

export {
  applyClickResult,
  buildUiApps,
  collapseLogical,
  computeNextOnClick,
  computeSummary,
  deriveActual,
  deriveIntent,
  filterByCategory,
  getDisplayStatus,
  hasPending,
  isSwitchOn,
  mergeBusyState,
  sortApps,
  type ClickResult,
  type SwitchIntent,
} from './stateMachine.ts'

import type { UiAppEntry } from './types.ts'

/**
 * @deprecated 仅供尚未迁移的旧 main.ts 调用；新代码请直接用 logical/actual/intent。
 */
export function uiStatusOf(
  pkg: string,
  persisted: import('./types').SystemizerState,
): UiStatus {
  const record = persisted.apps?.[pkg]
  if (!record) return 'normal'
  switch (record.status) {
    case 'active': return 'systemized'
    case 'pending_add': return 'pending-add'
    case 'pending_remove': return 'pending-remove'
    default: return 'normal'
  }
}

/**
 * @deprecated 旧字段别名映射（保持 main.ts 直接可编译）。
 */
export type UiAppEntryLegacy = UiAppEntry & { status: UiStatus }
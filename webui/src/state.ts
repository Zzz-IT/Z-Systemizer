import type { AppEntry, SystemizerState } from './api'

export type UiStatus = 'normal' | 'systemized' | 'pending-add' | 'pending-remove'

export interface UiAppEntry extends AppEntry {
  status: UiStatus
  busy: boolean
}

export function uiStatusOf(pkg: string, persisted: SystemizerState): UiStatus {
  const record = persisted.apps[pkg]
  if (!record) return 'normal'

  switch (record.status) {
    case 'active':
      return 'systemized'
    case 'pending_add':
      return 'pending-add'
    case 'pending_remove':
      return 'pending-remove'
    default:
      return 'normal'
  }
}

export function buildUiApps(
  apps: AppEntry[],
  state: SystemizerState,
): UiAppEntry[] {
  return apps
    .filter(app => !app.isSystem || state.apps[app.packageName])
    .map(app => ({
      ...app,
      status: uiStatusOf(app.packageName, state),
      busy: false,
    }))
}

export function mergeBusyState(nextApps: UiAppEntry[], oldApps: UiAppEntry[]): UiAppEntry[] {
  const oldMap = new Map(oldApps.map(app => [app.packageName, app]))

  return nextApps.map(next => {
    const old = oldMap.get(next.packageName)
    if (!old || !old.busy) return next

    return {
      ...next,
      busy: old.busy,
    }
  })
}

export function hasPending(apps: UiAppEntry[]): boolean {
  return apps.some(app => app.status === 'pending-add' || app.status === 'pending-remove')
}

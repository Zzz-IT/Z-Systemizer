import type { AppEntry } from './api'

export type PendingState = 'none' | 'add' | 'remove'

export interface UiAppEntry extends AppEntry {
  systemized: boolean
  pending: PendingState
  busy: boolean
}

export interface AppState {
  apps: UiAppEntry[]
  filter: string
  onlySystemized: boolean
  globalBusy: boolean
}

export function buildUiApps(
  apps: AppEntry[],
  systemized: Set<string>,
): UiAppEntry[] {
  return apps
    .filter(app => !app.isSystem || systemized.has(app.packageName))
    .map(app => ({
      ...app,
      systemized: systemized.has(app.packageName),
      pending: 'none' as PendingState,
      busy: false,
    }))
    .sort((a, b) => {
      if (a.systemized !== b.systemized) return a.systemized ? -1 : 1
      return a.appName.localeCompare(b.appName)
    })
}

export function mergePendingState(nextApps: UiAppEntry[], oldApps: UiAppEntry[]): UiAppEntry[] {
  const oldMap = new Map(oldApps.map(app => [app.packageName, app]))

  return nextApps.map(next => {
    const old = oldMap.get(next.packageName)
    if (!old || old.pending === 'none') return next

    return {
      ...next,
      pending: old.pending,
      busy: false,
      systemized: old.systemized,
    }
  })
}

export function hasPending(apps: UiAppEntry[]): boolean {
  return apps.some(app => app.pending !== 'none')
}

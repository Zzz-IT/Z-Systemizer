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

export function hasPending(apps: UiAppEntry[]): boolean {
  return apps.some(app => app.pending !== 'none')
}

import { exec, listPackages, getPackagesInfo } from 'kernelsu-alt'

export interface AppEntry {
  packageName: string
  appName: string
  isSystem: boolean
}

const CLI = '/data/adb/modules/ksu-systemizer/bin/systemizer'

export async function shell(command: string): Promise<string> {
  const result = await exec(command)

  if (result.errno !== 0) {
    throw new Error(result.stderr || result.stdout || `命令失败：${command}`)
  }

  return result.stdout.trim()
}

export async function diagnose(): Promise<string> {
  return shell(`${CLI} diagnose`)
}

export type AppStatus = 'active' | 'pending_add' | 'pending_remove'

export interface AppRecord {
  package: string
  target: 'app'
  status: AppStatus
  createdAt: number
  updatedAt: number
  pendingBootId: string | null
}

export interface SystemizerState {
  schemaVersion: number
  moduleId: string
  updatedAt: number
  bootId: string
  apps: Record<string, AppRecord>
}

export function emptySystemizerState(): SystemizerState {
  return {
    schemaVersion: 1,
    moduleId: 'ksu-systemizer',
    updatedAt: 0,
    bootId: '',
    apps: {},
  }
}

export async function getSystemizerState(): Promise<SystemizerState> {
  const out = await shell(`${CLI} state-json`)
  return JSON.parse(out)
}

export async function getSystemizerStateSafe(): Promise<SystemizerState> {
  try {
    return await getSystemizerState()
  } catch (e) {
    console.warn('state-json failed, using empty state', e)
    return emptySystemizerState()
  }
}

export async function getApps(): Promise<AppEntry[]> {
  const pkgs = await listPackages('all')
  const infos = await getPackagesInfo(pkgs)

  return pkgs.map((pkg: string, i: number) => ({
    packageName: pkg,
    appName: infos[i]?.appLabel || pkg,
    isSystem: infos[i]?.isSystem ?? false,
  }))
}

export async function getAppsSafe(): Promise<AppEntry[]> {
  try {
    return await getApps()
  } catch (e) {
    console.warn('KernelSU package API failed, fallback to CLI list-user-apps', e)

    const out = await shell(`${CLI} list-user-apps`)
    return out
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(pkg => ({
        packageName: pkg,
        appName: pkg,
        isSystem: false,
      }))
  }
}

export async function systemize(pkg: string): Promise<void> {
  await shell(`${CLI} systemize ${pkg} app`)
}

export async function unsystemize(pkg: string): Promise<void> {
  await shell(`${CLI} unsystemize ${pkg}`)
}

export async function rebootDevice(): Promise<void> {
  await shell('reboot')
}

export async function refreshDescription(): Promise<void> {
  await shell(`${CLI} refresh-description`)
}

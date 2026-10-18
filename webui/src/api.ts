// 【设备桥接层】KernelSU / APatch 交互，CLI Shell 指令封装

import { exec, listPackages, getPackagesInfo } from 'kernelsu-alt'
import type { SystemizerState } from './types.ts'

const CLI = '/data/adb/modules/ksu-systemizer/bin/systemizer'

export type { SystemizerState, AppEntry, AppRecord } from './types.ts'

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

export async function getSystemizerState(): Promise<SystemizerState> {
  const out = await shell(`${CLI} state-json`)
  return JSON.parse(out)
}

export async function getSystemizerStateSafe(): Promise<SystemizerState> {
  try {
    return await getSystemizerState()
  } catch (e) {
    console.warn('state-json failed, using empty state', e)
    return {
      schemaVersion: 1,
      moduleId: 'ksu-systemizer',
      updatedAt: 0,
      bootId: '',
      apps: {},
    }
  }
}

export async function getApps(): Promise<import('./types').AppEntry[]> {
  const rawPkgs = await listPackages('all')
  // 多用户 / 双开 / 分身场景下 listPackages 会返回重复 packageName，
  // 必须先去重，否则后续 DOM 节点 Map 键碰撞、统计双计数。
  const pkgs = Array.from(new Set(rawPkgs))
  const infos = await getPackagesInfo(pkgs)

  return pkgs.map((pkg: string, i: number) => ({
    packageName: pkg,
    appName: infos[i]?.appLabel || pkg,
    isSystem: infos[i]?.isSystem ?? false,
  }))
}

export async function getAppsSafe(): Promise<import('./types').AppEntry[]> {
  try {
    return await getApps()
  } catch (e) {
    console.warn('KernelSU package API failed, fallback to CLI list-user-apps', e)

    const out = await shell(`${CLI} list-user-apps`)
    // 与 getApps() 一致去重：pm list packages -3 在多用户/分身下同样会重复
    const pkgs = Array.from(new Set(
      out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ))
    return pkgs.map((pkg) => ({
      packageName: pkg,
      appName: pkg,
      isSystem: false,
    }))
  }
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function systemize(pkg: string): Promise<void> {
  await shell(`${CLI} systemize ${shQuote(pkg)} app`)
}

export async function unsystemize(pkg: string): Promise<void> {
  await shell(`${CLI} unsystemize ${shQuote(pkg)}`)
}

export async function rebootDevice(): Promise<void> {
  await shell('reboot')
}

export async function refreshDerived(): Promise<void> {
  await shell(`${CLI} refresh-derived`)
}

export async function setKeepalive(pkg: string, enabled: boolean): Promise<void> {
  // CLI 实际入口是 `keepalive <pkg> on|off`（见 main.rs set_keepalive_only）。
  await shell(`${CLI} keepalive ${shQuote(pkg)} ${enabled ? 'on' : 'off'}`)
}

export async function listKeepalive(): Promise<string[]> {
  try {
    // CLI 无独立 keepalive 列表命令，从 state-json 里筛 keepaliveOnly。
    const raw = await shell(`${CLI} state-json`)
    const parsed = JSON.parse(raw) as {
      apps?: Record<string, { keepaliveOnly?: boolean }>
    }
    return Object.entries(parsed.apps ?? {})
      .filter(([, rec]) => rec?.keepaliveOnly === true)
      .map(([pkg]) => pkg)
  } catch (e) {
    console.warn('list keepalive failed', e)
    return []
  }
}

export interface RiskInfo {
  package: string
  xposedModule: boolean
  riskLevel: 'high' | 'none'
  reasons: string[]
  blockedByDefault: boolean
}

export async function getRisk(pkg: string): Promise<RiskInfo> {
  const out = await shell(`${CLI} risk-json ${shQuote(pkg)}`)
  return JSON.parse(out)
}

export interface ModuleInfo {
  id: string
  name: string
  version: string
  versionCode: number
  description: string
  [key: string]: any
}

export async function getModuleInfo(): Promise<ModuleInfo> {
  const out = await shell(`${CLI} module-info-json`)
  return JSON.parse(out)
}
// 【预览专用】在桌面浏览器里用假数据替代 KernelSU 设备桥接层。
// 仅在 vite.preview.config.ts 下通过 resolveId 别名生效，不进正式构建，不触碰设备。

import type { AppEntry, AppRecord, SystemizerState } from '../src/types'

export interface ModuleInfo {
  id: string
  name: string
  version: string
  versionCode: number
  description: string
  [key: string]: unknown
}

export interface RiskInfo {
  package: string
  xposedModule: boolean
  riskLevel: 'high' | 'none'
  reasons: string[]
  blockedByDefault: boolean
}

type Kind =
  | 'normal'
  | 'pending_add'
  | 'systemized'
  | 'pending_remove'
  | 'keepalive'
  | 'keepalive_from_sys'
  | 'ghost'
  | 'system'

interface MockRecord {
  target: string
  status: 'active' | 'pending_add' | 'pending_remove'
  keepaliveOnly: boolean
}

// 覆盖全部 5 种逻辑态 + 边界态，以及「state 里有记录但 PackageManager 已看不到」的孤儿记录
const SEED: Array<{ app: AppEntry; kind: Kind }> = [
  { kind: 'normal', app: { packageName: 'com.tencent.mm', appName: '微信', isSystem: false } },
  { kind: 'normal', app: { packageName: 'com.tencent.mobileqq', appName: 'QQ', isSystem: false } },
  { kind: 'normal', app: { packageName: 'com.jingdong.app.mall', appName: '京东', isSystem: false } },
  { kind: 'normal', app: { packageName: 'com.tencent.qqlive', appName: '腾讯视频', isSystem: false } },
  { kind: 'pending_add', app: { packageName: 'com.eg.android.AlipayGphone', appName: '支付宝', isSystem: false } },
  { kind: 'pending_add', app: { packageName: 'com.xunmeng.pinduoduo', appName: '拼多多', isSystem: false } },
  { kind: 'pending_add', app: { packageName: 'com.xingin.xhs', appName: '小红书', isSystem: false } },
  { kind: 'pending_add', app: { packageName: 'com.zhihu.android', appName: '知乎', isSystem: false } },
  { kind: 'systemized', app: { packageName: 'com.ss.android.ugc.aweme', appName: '抖音', isSystem: false } },
  { kind: 'systemized', app: { packageName: 'com.taobao.taobao', appName: '淘宝', isSystem: false } },
  { kind: 'systemized', app: { packageName: 'com.alibaba.android.rimet', appName: '钉钉', isSystem: false } },
  { kind: 'systemized', app: { packageName: 'com.iflytek.inputmethod', appName: '讯飞输入法', isSystem: false } },
  { kind: 'systemized', app: { packageName: 'cn.wps.moffice_eng', appName: 'WPS Office', isSystem: false } },
  { kind: 'pending_remove', app: { packageName: 'com.autonavi.minimap', appName: '高德地图', isSystem: false } },
  { kind: 'keepalive_from_sys', app: { packageName: 'tv.danmaku.bili', appName: '哔哩哔哩', isSystem: false } },
  { kind: 'keepalive', app: { packageName: 'com.netease.cloudmusic', appName: '网易云音乐', isSystem: false } },
  { kind: 'keepalive', app: { packageName: 'com.coolapk.market', appName: '酷安', isSystem: false } },
  { kind: 'keepalive', app: { packageName: 'com.baidu.netdisk', appName: '百度网盘', isSystem: false } },
  { kind: 'system', app: { packageName: 'com.android.settings', appName: '系统设置', isSystem: true } },
  { kind: 'system', app: { packageName: 'com.android.vending', appName: 'Google Play 商店', isSystem: true } },
  { kind: 'ghost', app: { packageName: 'com.example.ghostapp', appName: '已卸载残留', isSystem: true } },
]

function seedRecord(kind: Kind): MockRecord | null {
  switch (kind) {
    case 'pending_add':
      return { target: 'app', status: 'pending_add', keepaliveOnly: false }
    case 'systemized':
      return { target: 'app', status: 'active', keepaliveOnly: false }
    case 'pending_remove':
    case 'ghost':
      return { target: 'app', status: 'pending_remove', keepaliveOnly: false }
    case 'keepalive':
      return { target: 'keepalive', status: 'active', keepaliveOnly: true }
    // 叠加态：已系统化后再开保活 —— target 留在原类别，status 转待移除，保活即时生效
    case 'keepalive_from_sys':
      return { target: 'app', status: 'pending_remove', keepaliveOnly: true }
    default:
      return null
  }
}

const records: Record<string, MockRecord> = {}
const apps: AppEntry[] = []

for (const item of SEED) {
  if (item.kind !== 'ghost') apps.push(item.app)
  const rec = seedRecord(item.kind)
  if (rec) records[item.app.packageName] = rec
}

export function labelOf(pkg: string): string | undefined {
  const hit = SEED.find((item) => item.app.packageName === pkg)
  return hit === undefined ? undefined : hit.app.appName
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function snapshot(): Record<string, AppRecord> {
  // AppRecord 的 TS 定义只声明了 target: 'app'，这里放宽成后端真实形状
  return records as unknown as Record<string, AppRecord>
}

export async function shell(command: string): Promise<string> {
  await wait(60)
  console.info('[preview] 拦截 shell 指令：' + command)
  return 'ok=true'
}

export async function getApps(): Promise<AppEntry[]> {
  await wait(200)
  return apps.map((app) => ({ ...app }))
}

export async function getAppsSafe(): Promise<AppEntry[]> {
  return getApps()
}

export async function getSystemizerState(): Promise<SystemizerState> {
  await wait(140)
  return {
    schemaVersion: 2,
    moduleId: 'ksu-systemizer',
    updatedAt: Date.now(),
    bootId: 'preview-boot',
    apps: snapshot(),
  }
}

export async function systemize(pkg: string): Promise<void> {
  await wait(260)
  records[pkg] = { target: 'app', status: 'pending_add', keepaliveOnly: false }
}

export async function unsystemize(pkg: string): Promise<void> {
  await wait(260)
  const rec = records[pkg]
  if (rec === undefined) return
  // 纯保活不落盘任何文件，删记录等价于关闭保活
  if (rec.keepaliveOnly && rec.target === 'keepalive') {
    delete records[pkg]
    return
  }
  if (rec.status === 'pending_add') {
    delete records[pkg]
    return
  }
  if (rec.status === 'pending_remove') {
    // 叠加态：保活还开着，撤销移除会让保活失去载体，保持不动
    if (rec.keepaliveOnly) return
    rec.status = 'active'
    return
  }
  rec.status = 'pending_remove'
}

export async function setKeepalive(pkg: string, enabled: boolean): Promise<void> {
  await wait(260)
  const rec = records[pkg] ?? { target: 'keepalive', status: 'active' as const, keepaliveOnly: false }
  records[pkg] = rec

  if (enabled) {
    // 与 CLI 一致：PendingAdd（已落盘、未重启）同样算叠加态，否则重启后会被挂成系统应用
    const wasSystemized =
      !rec.keepaliveOnly &&
      (rec.status === 'active' || rec.status === 'pending_add') &&
      rec.target !== 'keepalive'
    rec.keepaliveOnly = true
    if (wasSystemized) {
      rec.status = 'pending_remove'
    } else if (rec.target !== 'keepalive') {
      rec.target = 'keepalive'
      rec.status = 'active'
    }
    return
  }

  rec.keepaliveOnly = false
  if (rec.status !== 'pending_remove' && rec.target === 'keepalive') delete records[pkg]
}

export async function refreshDerived(): Promise<void> {
  await wait(60)
}

export async function rebootDevice(): Promise<void> {
  console.info('[preview] 拦截重启指令（预览模式不会真的重启）')
}

export async function diagnose(): Promise<string> {
  await wait(400)
  return [
    'module_dir=/data/adb/modules/ksu-systemizer',
    'state_schema=2',
    'boot_id=preview-boot',
    'pending_add=4',
    'pending_remove=2',
    'keepalive_only=4',
    'sysconfig_entries=8',
    'deviceidle_whitelist=4',
    'result=ok',
  ].join('\n')
}

export async function getRisk(pkg: string): Promise<RiskInfo> {
  await wait(120)
  return { package: pkg, xposedModule: false, riskLevel: 'none', reasons: [], blockedByDefault: false }
}

export async function getModuleInfo(): Promise<ModuleInfo> {
  await wait(120)
  return {
    id: 'ksu-systemizer',
    name: 'Z Systemizer',
    version: '1.2.5-preview',
    versionCode: 125,
    description: '前端预览模式：全部数据为假数据，按钮点击只改内存，不触碰设备。',
  }
}

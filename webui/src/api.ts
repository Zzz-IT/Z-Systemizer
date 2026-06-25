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

export async function getSystemizedPackages(): Promise<Set<string>> {
  const out = await shell(`${CLI} list-systemized`)

  const pkgs = out
    .split('\n')
    .map(line => line.trim().split(/\s+/)[0])
    .filter(Boolean)

  return new Set(pkgs)
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

export async function systemize(pkg: string): Promise<void> {
  await shell(`${CLI} systemize ${pkg} app`)
}

export async function unsystemize(pkg: string): Promise<void> {
  await shell(`${CLI} unsystemize ${pkg}`)
}

export async function rebootDevice(): Promise<void> {
  await shell('reboot')
}

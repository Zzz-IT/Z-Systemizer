/// <reference types="vite/client" />

declare module '*.scss' {
  const content: string
  export default content
}

declare module 'kernelsu-alt' {
  export interface ExecResult {
    errno: number
    stdout: string
    stderr: string
  }
  export function exec(command: string): Promise<ExecResult>
  export function listPackages(scope: 'all' | 'user' | 'system'): Promise<string[]>
  export interface PackageInfo {
    packageName: string
    appLabel: string
    isSystem: boolean
  }
  export function getPackagesInfo(pkgs: string[]): Promise<PackageInfo[]>
}
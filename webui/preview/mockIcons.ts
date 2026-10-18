// 【预览专用】浏览器无法解析 ksu://icon/<pkg>，这里就地生成彩色字母图标。
import { IconController as BaseIconController } from '../src/icons'
import type { IconControllerOptions } from '../src/icons'
import { labelOf } from './mockApi'

const PALETTE = ['#4C7DF0', '#F2994A', '#27AE60', '#EB5757', '#9B51E0', '#2D9CDB', '#E2B93B', '#00B8A9']

function hashCode(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0
  return Math.abs(hash)
}

function makeIcon(pkg: string): string {
  const color = PALETTE[hashCode(pkg) % PALETTE.length]
  const char = Array.from(labelOf(pkg) ?? pkg)[0] ?? '?'
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
    '<rect width="96" height="96" rx="24" fill="' + color + '"/>' +
    '<text x="48" y="50" font-size="44" font-family="sans-serif" fill="#ffffff" ' +
    'text-anchor="middle" dominant-baseline="central">' + char + '</text></svg>'
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

export class IconController extends BaseIconController {
  constructor(options: IconControllerOptions = {}) {
    super({ iconUrl: makeIcon, ...options })
  }
}

export type { IconControllerOptions, IconScopeElements } from '../src/icons'

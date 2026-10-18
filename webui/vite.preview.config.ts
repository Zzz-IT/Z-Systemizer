// 【预览专用】把设备桥接层与图标层替换成假数据，用真实 index.html 直接在桌面浏览器看样式。
// 用法：cd webui && npx vite --config vite.preview.config.ts
// 可选 URL 参数：?view=keepalive（切到保活分类） / ?only=1（仅看已处理和待重启） / ?q=微信（预填搜索）
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const mockApi = resolve(here, 'preview/mockApi.ts')
const mockIcons = resolve(here, 'preview/mockIcons.ts')

const presetScript = [
  '(function () {',
  "  var p = new URLSearchParams(location.search);",
  "  if (p.get('only') === '1') { localStorage.setItem('onlySystemized', 'true'); }",
  "  if (p.get('only') === '0') { localStorage.removeItem('onlySystemized'); }",
  "  if (p.get('q')) { window.__previewQuery = p.get('q'); }",
  "  if (p.get('view') === 'keepalive') { window.__previewView = 'keepalive'; }",
  '})();',
].join('\n')

const driveScript = [
  '(function () {',
  '  function run() {',
  "    var q = window.__previewQuery;",
  "    var v = window.__previewView;",
  "    if (q) {",
  "      var input = document.querySelector('.search-input');",
  "      if (input) {",
  "        input.value = q;",
  "        input.dispatchEvent(new Event('input', { bubbles: true }));",
  "      }",
  '    }',
  "    if (v === 'keepalive') {",
  "      var block = document.querySelector('.summary-category');",
  "      if (block) { block.click(); }",
  '    }',
  '  }',
  "  window.addEventListener('load', function () { setTimeout(run, 900); });",
  '})();',
].join('\n')

const badgeStyle =
  'position:fixed;left:10px;bottom:10px;z-index:99999;' +
  'padding:5px 10px;border-radius:999px;font-size:11px;line-height:1;' +
  'background:rgba(76,125,240,.92);color:#fff;' +
  'font-family:system-ui,-apple-system,sans-serif;' +
  'box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none;'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
  },
  plugins: [
    {
      name: 'systemizer-preview-mock',
      enforce: 'pre',
      resolveId(source: string) {
        if (source === './api') return mockApi
        if (source === './icons') return mockIcons
        return null
      },
      transformIndexHtml() {
        return [
          { tag: 'script', children: presetScript, injectTo: 'head-prepend' },
          {
            tag: 'div',
            attrs: { class: 'preview-badge', style: badgeStyle },
            children: '预览模式 · 假数据',
            injectTo: 'body',
          },
          { tag: 'script', children: driveScript, injectTo: 'body' },
        ]
      },
    },
  ],
})

// 【交互组件】二次确认弹窗、Toast 浮层

export interface ConfirmOptions {
  title: string
  message?: string
  htmlMessage?: string
  cancelText: string
  confirmText: string
  danger?: boolean
  diagnostic?: boolean
}

function waitForRemoval(node: Element): Promise<void> {
  if (!node.isConnected) return Promise.resolve()
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (node.isConnected) return
      observer.disconnect()
      resolve()
    })
    observer.observe(document.body, { childList: true })
  })
}

export async function showConfirm(options: ConfirmOptions): Promise<boolean> {
  // 同一时刻只允许一个弹窗。早先的实现发现已有 backdrop 就直接 resolve(false)，
  // 于是连点两次开关时，第二次确认会被静默当成「用户取消」，动作凭空丢失。
  // 改为排队：等当前弹窗关闭后再弹自己的。
  const existing = document.querySelector<HTMLElement>('.dialog-backdrop')
  if (existing) await waitForRemoval(existing)

  return new Promise((resolve) => {
    const dialog = document.createElement('div')
    dialog.className = `dialog-backdrop ${options.diagnostic ? 'is-diagnostic' : ''}`

    const messageContent = options.htmlMessage
      ? options.htmlMessage
      : escapeHtml(options.message || '').replaceAll('\n', '<br>')

    dialog.innerHTML = `
      <div class="dialog">
        <div class="dialog-title">${escapeHtml(options.title)}</div>
        <div class="dialog-message">${messageContent}</div>
        <div class="dialog-actions">
          <button class="dialog-cancel">${escapeHtml(options.cancelText)}</button>
          <button class="dialog-confirm ${options.danger ? 'danger' : ''}">${escapeHtml(options.confirmText)}</button>
        </div>
      </div>
    `

    document.body.appendChild(dialog)
    requestAnimationFrame(() => dialog.classList.add('show'))

    const closeDialog = (result: boolean) => {
      dialog.classList.remove('show')
      setTimeout(() => {
        dialog.remove()
        resolve(result)
      }, 180)
    }

    dialog.querySelector<HTMLButtonElement>('.dialog-cancel')!.onclick = () => closeDialog(false)
    dialog.querySelector<HTMLButtonElement>('.dialog-confirm')!.onclick = () => closeDialog(true)
  })
}

const TOAST_VISIBLE_MS = 2200
const TOAST_FADE_MS = 250

export function toast(message: string): void {
  const node = document.createElement('div')
  node.className = 'toast'
  node.textContent = message
  document.body.appendChild(node)

  requestAnimationFrame(() => node.classList.add('show'))
  setTimeout(() => {
    node.classList.remove('show')
    setTimeout(() => node.remove(), TOAST_FADE_MS)
  }, TOAST_VISIBLE_MS)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
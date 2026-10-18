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

export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (document.querySelector('.dialog-backdrop')) {
      resolve(false)
      return
    }

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
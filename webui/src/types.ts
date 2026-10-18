// 【领域模型】核心接口契约、状态枚举定义
// 不依赖 DOM、可在任何纯 JS 环境下测试

export type ActualStatus = 'systemized' | 'keepalive' | 'none'
export type IntentStatus = 'pending_add' | 'pending_remove' | 'none'
export type Category = 'app' | 'keepalive'

// 应用在两维度状态机下被压缩后的「组合语义」枚举，等价于文档 S1~S5
export type LogicalStatus =
  | 'normal'           // S1
  | 'pending_add'      // S2
  | 'systemized'       // S3
  | 'pending_remove'   // S4
  | 'keepalive'        // S5

export interface AppEntry {
  packageName: string
  appName: string
  isSystem: boolean
}

// 后端持久化记录的精简视图，仅取渲染所需的字段
export interface AppRecord {
  package: string
  target: 'app'
  status: 'active' | 'pending_add' | 'pending_remove'
  pendingBootId?: string | null
}

export interface SystemizerState {
  apps: Record<string, AppRecord>
  bootId?: string
  updatedAt?: number
  schemaVersion?: number
  moduleId?: string
}

// 跨前端模块复用的 UI 扩展条目
export interface UiAppEntry extends AppEntry {
  logical: LogicalStatus
  actual: ActualStatus
  intent: IntentStatus
  busy: boolean
  fromStateOnly: boolean
}

// 白黄双色小字契约的输出（v1.2.1：白字部分统一使用 '未处理'/'已系统化'/'已保活'）
export interface AppDisplayStatus {
  actualText: '已系统化' | '已保活' | '未处理'
  intentText: '待系统化' | '待移除' | '待移除系统化' | null
  formattedHtml: string
  plainText: string
}

export interface SummaryStats {
  /** 已处理：物理已生效项 = 已系统化 + 已保活 */
  systemized: number
  /** 待重启：所有 pending_add + pending_remove，与分类无关 */
  pending: number
}
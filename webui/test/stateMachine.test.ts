// 状态机纯函数单元测试
// 使用 Node.js 原生测试运行器（node --test）
// 详细规范见 REFACTOR_AND_OPERATION_MANUAL.md §2.4

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildUiApps,
  collapseLogical,
  computeNextOnClick,
  computeSummary,
  deriveActual,
  deriveIntent,
  filterByCategory,
  getDisplayStatus,
  isSwitchOn,
  sortApps,
} from '../src/stateMachine.ts'

import type {
  ActualStatus,
  AppEntry,
  Category,
  IntentStatus,
  LogicalStatus,
  SystemizerState,
  UiAppEntry,
} from '../src/types.ts'

// ============================================================================
// §2.2 isSwitchOn 互斥定理
// ============================================================================

test('isSwitchOn: 系统化视图互斥判定', () => {
  assert.equal(isSwitchOn('systemized', 'none', 'app'), true, 'S3: 已系统化 == 开')
  assert.equal(isSwitchOn('systemized', 'pending_remove', 'app'), false, 'S4: 待移除 == 关')
  assert.equal(isSwitchOn('none', 'pending_add', 'app'), true, 'S2: 待系统化 == 开')
  assert.equal(isSwitchOn('none', 'none', 'app'), false, 'S1: 普通应用 == 关')
})

test('isSwitchOn: 仅保活视图互斥判定', () => {
  assert.equal(isSwitchOn('keepalive', 'none', 'keepalive'), true, 'S5: 已保活 == 开')
  assert.equal(isSwitchOn('systemized', 'none', 'keepalive'), false, 'S3: 已系统化 == 关')
  assert.equal(isSwitchOn('none', 'pending_add', 'keepalive'), false, 'S2: 待系统化 == 关')
  assert.equal(isSwitchOn('none', 'none', 'keepalive'), false, 'S1: 普通应用 == 关')
})

test('isSwitchOn: 同一应用在两个分类下永远不可能同时为开', () => {
  // 红线 3
  const cases: Array<[ActualStatus, IntentStatus]> = [
    ['systemized', 'none'],
    ['systemized', 'pending_remove'],
    ['none', 'pending_add'],
    ['none', 'none'],
    ['keepalive', 'none'],
  ]
  for (const [actual, intent] of cases) {
    const appOn = isSwitchOn(actual, intent, 'app')
    const keepOn = isSwitchOn(actual, intent, 'keepalive')
    assert.ok(
      !(appOn && keepOn),
      `互斥失败：actual=${actual} intent=${intent}`,
    )
  }
})

// ============================================================================
// §2.3 白黄双色小字契约
// ============================================================================

test('getDisplayStatus: 5 态文案映射', () => {
  // S1 普通应用（v1.2.1：未系统化 → 未处理）
  assert.deepEqual(getDisplayStatus('none', 'none'), {
    actualText: '未处理',
    intentText: null,
    formattedHtml: '<span class="status-actual">未处理</span>',
    plainText: '未处理',
  })

  // S3 已系统化
  assert.deepEqual(getDisplayStatus('systemized', 'none'), {
    actualText: '已系统化',
    intentText: null,
    formattedHtml: '<span class="status-actual">已系统化</span>',
    plainText: '已系统化',
  })

  // S5 已保活
  assert.deepEqual(getDisplayStatus('keepalive', 'none'), {
    actualText: '已保活',
    intentText: null,
    formattedHtml: '<span class="status-actual">已保活</span>',
    plainText: '已保活',
  })
})

test('getDisplayStatus: 待系统化时白字+黄字+单个半角空格（红线 2）', () => {
  const r = getDisplayStatus('none', 'pending_add')
  assert.equal(r.intentText, '待系统化')
  assert.equal(r.plainText, '未处理 待系统化', '白字与黄字间必须恰好 1 个半角空格')
  assert.ok(
    r.formattedHtml.includes('</span> <span'),
    'formattedHtml 中应存在单个空格的 span 间隔',
  )
  // 红线 1：不存在"待保活"
  assert.equal(r.intentText !== ('待保活' as any), true)
})

test('getDisplayStatus: 待移除时白字 + 黄字 + 单空格', () => {
  const r = getDisplayStatus('systemized', 'pending_remove')
  assert.equal(r.plainText, '已系统化 待移除')
  assert.equal(r.intentText, '待移除')
  assert.ok(r.formattedHtml.includes('status-intent'))
})

test('getDisplayStatus: S3→S5 黄字必须为「待移除系统化」（消除主语歧义）', () => {
  // 红线：actual='keepalive' + pending_remove 时，单纯说「待移除」会让用户
  // 误读为「保活被移除」，实际是「system/app 身份被移出」。
  const r = getDisplayStatus('keepalive', 'pending_remove')
  assert.equal(r.plainText, '已保活 待移除系统化')
  assert.equal(r.intentText, '待移除系统化')
  assert.ok(r.formattedHtml.includes('status-intent'))
})

// ============================================================================
// §2.4 S1~S5 状态流转矩阵
// ============================================================================

function click(
  cur: LogicalStatus,
  cat: Category,
  intent: 'on' | 'off',
): { logical: LogicalStatus; actual: ActualStatus; intent: IntentStatus } | null {
  const r = computeNextOnClick(cur, cat, intent)
  return r ? { logical: r.nextLogical, actual: r.nextActual, intent: r.nextIntent } : null
}

test('流转 S1→S2→S1（普通应用开启系统化再取消）', () => {
  const a = click('normal', 'app', 'on')
  assert.deepEqual(a, { logical: 'pending_add', actual: 'none', intent: 'pending_add' })
  const b = click('pending_add', 'app', 'off')
  assert.deepEqual(b, { logical: 'normal', actual: 'none', intent: 'none' })
})

test('流转 S3→S4→S3（已系统化标记移除再撤销）', () => {
  const a = click('systemized', 'app', 'off')
  assert.deepEqual(a, { logical: 'pending_remove', actual: 'systemized', intent: 'pending_remove' })
  const b = click('pending_remove', 'app', 'on')
  assert.deepEqual(b, { logical: 'systemized', actual: 'systemized', intent: 'none' })
})

test('流转 S5→S1（已保活关闭）', () => {
  const a = click('keepalive', 'keepalive', 'off')
  assert.deepEqual(a, { logical: 'normal', actual: 'none', intent: 'none' })
})

test('流转 S1→S5 即时生效（普通应用开启保活）', () => {
  const a = click('normal', 'keepalive', 'on')
  assert.deepEqual(a, { logical: 'keepalive', actual: 'keepalive', intent: 'none' })
})

test('边界：S3（已系统化）开启保活 → 立即加入保活白名单并标记待移除', () => {
  // 关键边界场景：已系统化应用在保活分类开启保活，开关必须显示打开
  const a = click('systemized', 'keepalive', 'on')
  assert.deepEqual(a, { logical: 'pending_remove', actual: 'keepalive', intent: 'pending_remove' })
  assert.equal(isSwitchOn(a!.actual, a!.intent, 'keepalive'), true, '保活分类下开关必须为打开')
  // 此时保活即时生效，渲染契约：白字已保活 + 黄字待移除系统化
  const display = getDisplayStatus(a!.actual, a!.intent)
  assert.equal(display.plainText, '已保活 待移除系统化')
  assert.equal(display.intentText, '待移除系统化')
})

test('边界：S5→S2 互斥（已保活开启系统化）', () => {
  const a = click('keepalive', 'app', 'on')
  assert.deepEqual(a, { logical: 'pending_add', actual: 'none', intent: 'pending_add' })
})

test('边界：S2 在保活视图开启 → 立即转 S5（互斥取消待系统化）', () => {
  const a = click('pending_add', 'keepalive', 'on')
  assert.deepEqual(a, { logical: 'keepalive', actual: 'keepalive', intent: 'none' })
})

test('边界：S4 在保活视图开启 → 保持保活且开关打开', () => {
  const a = click('pending_remove', 'keepalive', 'on')
  assert.deepEqual(a, { logical: 'pending_remove', actual: 'keepalive', intent: 'pending_remove' })
  assert.equal(isSwitchOn(a!.actual, a!.intent, 'keepalive'), true, '保活分类下开关必须为打开')
})

test('边界：S4 在保活视图关闭 → 退出保活白名单且开关关闭', () => {
  const a = click('pending_remove', 'keepalive', 'off')
  assert.deepEqual(a, { logical: 'pending_remove', actual: 'none', intent: 'pending_remove' })
  assert.equal(isSwitchOn(a!.actual, a!.intent, 'keepalive'), false, '保活分类下开关必须为关闭')
})

// ============================================================================
// deriveActual / deriveIntent / collapseLogical
// ============================================================================

test('deriveActual: pending_add 表示用户标记了、但未重启，应为 none', () => {
  // 修复 issue 3：未重启时物理基准仍是 none，不能错算成 systemized
  assert.equal(
    deriveActual({ package: 'x', target: 'app', status: 'pending_add', pendingBootId: 'b' }),
    'none',
    'S2: pending_add 物理现状必须返回 none',
  )
})

test('deriveActual: pending_remove 在重启前物理基准仍为 systemized', () => {
  assert.equal(
    deriveActual({ package: 'x', target: 'app', status: 'pending_remove', pendingBootId: 'b' }),
    'systemized',
    'S4: 待移除，开机前 APK 仍在 system/app',
  )
})

test('getDisplayStatus: S2 必须显示 「未处理 待系统化」', () => {
  // 修复 issue 3 验证用例：pending_add 物理基准为 'none'，白字部分为「未处理」
  const r = getDisplayStatus('none', 'pending_add')
  assert.equal(r.plainText, '未处理 待系统化')
  assert.ok(r.formattedHtml.includes('未处理'))
  assert.ok(r.formattedHtml.includes('待系统化'))
})

test('getDisplayStatus: 白字文案只能是 已系统化/已保活/未处理（v1.2.1 契约）', () => {
  const allowed = new Set(['已系统化', '已保活', '未处理'])
  for (const actual of ['none', 'systemized', 'keepalive'] as const) {
    for (const intent of ['none', 'pending_add', 'pending_remove'] as const) {
      const r = getDisplayStatus(actual, intent)
      assert.ok(allowed.has(r.actualText), `actual=${actual} intent=${intent} -> ${r.actualText}`)
      assert.notEqual(r.actualText, '未系统化', 'v1.2.1 起不再使用「未系统化」')
    }
  }
})

test('deriveActual: pending_add 必须返回 none（软重启转正的判定基准）', () => {
  // 关键语义：未重启落盘前物理上仍是普通应用；
  // 软重启后由 CLI reconcile_pms_paths 通过 `pm path` 命中 /system/app 才转正为 active
  assert.equal(deriveActual({ package: 'x', target: 'app', status: 'pending_add', pendingBootId: 'b' }), 'none')
  assert.equal(deriveActual({ package: 'x', target: 'app', status: 'active', pendingBootId: null }), 'systemized')
  assert.equal(deriveActual({ package: 'x', target: 'app', status: 'pending_remove', pendingBootId: null }), 'systemized')
  assert.equal(deriveActual(undefined), 'none')
})

test('deriveIntent: 意图推导', () => {
  assert.equal(deriveIntent(undefined), 'none')
  assert.equal(deriveIntent({ package: 'x', target: 'app', status: 'active', pendingBootId: null }), 'none')
  assert.equal(deriveIntent({ package: 'x', target: 'app', status: 'pending_add', pendingBootId: 'b' }), 'pending_add')
  assert.equal(deriveIntent({ package: 'x', target: 'app', status: 'pending_remove', pendingBootId: 'b' }), 'pending_remove')
})

test('collapseLogical: 维度折叠', () => {
  assert.equal(collapseLogical('none', 'none'), 'normal')
  assert.equal(collapseLogical('none', 'pending_add'), 'pending_add')
  assert.equal(collapseLogical('systemized', 'none'), 'systemized')
  assert.equal(collapseLogical('systemized', 'pending_remove'), 'pending_remove')
  assert.equal(collapseLogical('keepalive', 'none'), 'keepalive')
  // intent 优先于 actual
  assert.equal(collapseLogical('systemized', 'pending_add'), 'pending_add')
})

// ============================================================================
// buildUiApps：注入 keepalive 集合后 actual 切换为 keepalive
// ============================================================================

function makeApp(pkg: string, name: string, isSystem = false): AppEntry {
  return { packageName: pkg, appName: name, isSystem }
}

test('buildUiApps: 保活集合内应用 actual 应为 keepalive', () => {
  const persisted: SystemizerState = {
    apps: {
      'com.x': { package: 'com.x', target: 'app', status: 'active', pendingBootId: null },
    },
  }
  const apps = [makeApp('com.x', 'X'), makeApp('com.y', 'Y')]
  const out = buildUiApps(apps, persisted, new Set(['com.y']))
  const x = out.find((a) => a.packageName === 'com.x')!
  const y = out.find((a) => a.packageName === 'com.y')!
  assert.equal(x.actual, 'systemized')
  assert.equal(y.actual, 'keepalive')
  assert.equal(y.logical, 'keepalive')
})

test('buildUiApps: 持久化中存在的孤儿包也会被补齐', () => {
  const persisted: SystemizerState = {
    apps: {
      'com.gone': { package: 'com.gone', target: 'app', status: 'pending_remove', pendingBootId: 'b' },
    },
  }
  const out = buildUiApps([], persisted, new Set())
  const ghost = out.find((a) => a.packageName === 'com.gone')
  assert.ok(ghost, 'ghost row 必须存在')
  assert.equal(ghost!.logical, 'pending_remove')
  assert.equal(ghost!.fromStateOnly, true)
})

// ============================================================================
// computeSummary / filterByCategory / sortApps
// ============================================================================

function uiEntry(pkg: string, logical: LogicalStatus): UiAppEntry {
  const base: Pick<UiAppEntry, 'logical' | 'actual' | 'intent'> = {
    logical,
    actual: 'none',
    intent: 'none',
  }
  if (logical === 'systemized') base.actual = 'systemized'
  if (logical === 'pending_add') {
    base.actual = 'none'
    base.intent = 'pending_add'
  }
  // 待移除的物理基准仍是 systemized，但 intent 必须为 pending_remove，
  // 否则 isSwitchOn 会误判为 ON（S3），与真实数据不符。
  if (logical === 'pending_remove') {
    base.actual = 'systemized'
    base.intent = 'pending_remove'
  }
  if (logical === 'keepalive') base.actual = 'keepalive'

  return {
    packageName: pkg,
    appName: pkg,
    isSystem: false,
    busy: false,
    fromStateOnly: false,
    ...base,
  }
}

test('computeSummary: 全局口径 = 已处理(systemized+keepalive) + 待重启(pending)', () => {
  // v1.2.1：统计与当前分类解耦；同一应用不会同时计入两侧（互斥定理保证不双计数）
  const apps = [
    uiEntry('a', 'systemized'),
    uiEntry('b', 'pending_add'),
    uiEntry('c', 'pending_remove'),
    uiEntry('d', 'normal'),
    uiEntry('e', 'keepalive'),
  ]
  const s = computeSummary(apps)
  assert.equal(s.systemized, 2, '已处理 = 已系统化 1 + 已保活 1')
  assert.equal(s.pending, 2, '待重启 = 待系统化 1 + 待移除 1')
})

test('computeSummary: 与 category 解耦（两个视图读数一致）', () => {
  const apps = [
    uiEntry('a', 'systemized'),
    uiEntry('b', 'keepalive'),
    uiEntry('c', 'pending_add'),
  ]
  const appView = computeSummary(apps)
  const keepView = computeSummary(apps)
  assert.deepEqual(appView, keepView)
  assert.equal(appView.systemized, 2)
  assert.equal(appView.pending, 1)
})

test('filterByCategory: 保活视图必须能看见全部应用（修复 issue 2）', () => {
  // 关键设计意图：keepalive 视图不应过滤掉普通/已系统化应用，
  // 否则用户根本无法开启新的保活（列表为空时开关没有可点击目标）。
  const apps = [
    uiEntry('a', 'systemized'),
    uiEntry('b', 'keepalive'),
    uiEntry('c', 'pending_add'),
    uiEntry('d', 'normal'),
  ]
  const filtered = filterByCategory(apps, 'keepalive')
  assert.equal(filtered.length, 4, '保活视图不能过滤掉非保活应用')
})

test('sortApps: app 视图三级严格置顶（ON 项必须全部排在 OFF 项之上）', () => {
  // 修复置顶逻辑倒挂：app 视图开关 ON = pending_add | systemized，
  // 因此它们必须排在 OFF 的 pending_remove / keepalive / normal 之前。
  const apps = [
    uiEntry('b', 'normal'),
    uiEntry('a', 'pending_remove'),
    uiEntry('c', 'pending_add'),
    uiEntry('d', 'systemized'),
    uiEntry('e', 'keepalive'),
  ]
  const sorted = sortApps(apps, 'app')
  assert.deepEqual(
    sorted.map((a) => a.logical),
    ['pending_add', 'systemized', 'pending_remove', 'keepalive', 'normal'],
  )
  // 结构性断言：排序后的开关状态序列必须满足 全 ON 在前、全 OFF 在后，不允许出现 ON 排在 OFF 之后
  const onOff = sorted.map((a) => isSwitchOn(a.actual, a.intent, 'app'))
  assert.deepEqual(onOff, [true, true, false, false, false], '严禁开关关闭项排在开关打开项之上')
})

test('sortApps: keepalive 视图三级严格置顶', () => {
  const apps = [
    uiEntry('b', 'normal'),
    uiEntry('a', 'pending_remove'),
    uiEntry('c', 'pending_add'),
    uiEntry('d', 'systemized'),
    uiEntry('e', 'keepalive'),
  ]
  const sorted = sortApps(apps, 'keepalive')
  assert.deepEqual(
    sorted.map((a) => a.logical),
    ['keepalive', 'pending_add', 'systemized', 'pending_remove', 'normal'],
  )
  assert.equal(sorted[0].logical, 'keepalive', '进入保活分类时已生效项必须置顶')

  // keepalive 视图唯一 ON 项是 keepalive，必须排在首位
  const onOff = sorted.map((a) => isSwitchOn(a.actual, a.intent, 'keepalive'))
  assert.deepEqual(onOff, [true, false, false, false, false])
})

test('sortApps: 同级使用中文应用名字典序（zh-Hans-CN）', () => {
  const apps = [
    uiEntry('p1', 'normal'),
    uiEntry('p2', 'normal'),
    uiEntry('p3', 'normal'),
  ]
  apps[0].appName = '支付宝'
  apps[1].appName = '抖音'
  apps[2].appName = '淘宝'

  const sorted = sortApps(apps, 'app')
  const expected = [...apps].sort((a, b) => a.appName.localeCompare(b.appName, 'zh-Hans-CN'))
  assert.deepEqual(
    sorted.map((a) => a.appName),
    expected.map((a) => a.appName),
  )
})

test('sortApps: 不修改入参数组（纯函数）', () => {
  const apps = [uiEntry('a', 'normal'), uiEntry('b', 'systemized')]
  const snapshot = apps.map((a) => a.packageName)
  sortApps(apps, 'app')
  assert.deepEqual(apps.map((a) => a.packageName), snapshot)
})

// ============================================================================
// buildUiApps：意图继承与去重（修复跨分类互斥错乱 / 双开分身重复）
// ============================================================================

test('buildUiApps: 已系统化应用被开启保活后必须保留 pending_remove 意图', () => {
  // 修复关键缺陷：旧实现无条件把 intent 覆盖为 'none'，导致「待移除」黄字标记丢失，
  // 用户看不到"重启后将移出 system/app"，也无法正确统计待重启项。
  const persisted: SystemizerState = {
    apps: {
      'com.x': { package: 'com.x', target: 'app', status: 'pending_remove', pendingBootId: 'b' },
    },
  }
  const out = buildUiApps([makeApp('com.x', 'X')], persisted, new Set(['com.x']))
  const x = out.find((a) => a.packageName === 'com.x')!
  assert.equal(x.actual, 'keepalive', '保活集合内 actual 应为 keepalive')
  assert.equal(x.intent, 'pending_remove', '严禁把真实 intent 抹成 none')
  assert.equal(x.logical, 'pending_remove', '折叠后仍应体现待移除')
  // 渲染契约：白字已保活 + 黄字待移除系统化，且中间恰好一个半角空格
  const display = getDisplayStatus(x.actual, x.intent)
  assert.equal(display.plainText, '已保活 待移除系统化')
  assert.equal(display.intentText, '待移除系统化')
  assert.ok(display.formattedHtml.includes('</span> <span'))
})

test('buildUiApps: 待系统化应用被开启保活后保留 pending_add 记录', () => {
  const persisted: SystemizerState = {
    apps: {
      'com.y': { package: 'com.y', target: 'app', status: 'pending_add', pendingBootId: 'b' },
    },
  }
  const out = buildUiApps([makeApp('com.y', 'Y')], persisted, new Set(['com.y']))
  const y = out.find((a) => a.packageName === 'com.y')!
  assert.equal(y.actual, 'keepalive')
  assert.equal(y.intent, 'pending_add')
})

test('buildUiApps: 双开/多用户/分身重复 packageName 必须去重', () => {
  // 修复：重复键会导致 renderedCards Map 键碰撞与统计双计数
  const apps = [
    makeApp('com.dup', '应用'),
    makeApp('com.dup', '应用（分身）'),
    makeApp('com.dup', '应用（多用户）'),
    makeApp('com.solo', '独有'),
  ]
  const out = buildUiApps(apps, { apps: {} }, new Set())
  const dups = out.filter((a) => a.packageName === 'com.dup')
  assert.equal(dups.length, 1, '同一 packageName 只允许出现一次')
  assert.equal(out.length, 2)
  // 保留首次出现的条目
  assert.equal(dups[0].appName, '应用')
})

test('buildUiApps: 去重后 computeSummary 不双计数', () => {
  const apps = [
    makeApp('com.dup', '应用'),
    makeApp('com.dup', '应用分身'),
  ]
  const persisted: SystemizerState = {
    apps: {
      'com.dup': { package: 'com.dup', target: 'app', status: 'active', pendingBootId: null },
    },
  }
  const out = buildUiApps(apps, persisted, new Set())
  const s = computeSummary(out)
  assert.equal(s.systemized, 1, '重复包名不得导致已处理计数翻倍')
})
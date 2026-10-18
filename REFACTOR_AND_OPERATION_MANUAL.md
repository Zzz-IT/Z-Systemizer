# Z-Systemizer 架构重构、状态机规范与详细实操手册

本文档针对 **Z-Systemizer** 项目，系统性地梳理**前后端解耦合与高内聚重构方案**、**两类别（系统化 vs 仅保活）互斥闭环状态机模型**、**双色小字与交互渲染规范**，以及**开发、测试、打包与运维全流程操作指引**。

---

## 目录

1. [系统整体架构与解耦合设计](#一系统整体架构与解耦合设计)
   - [1.1 WebUI 前端模块拆分（高内聚、纯逻辑分离）](#11-webui-前端模块拆分高内聚纯逻辑分离)
   - [1.2 Rust CLI 后端模块结构](#12-rust-cli-后端模块结构)
2. [双类别互斥闭环状态机规范](#二双类别互斥闭环状态机规范)
   - [2.1 状态维度与数学定义](#21-状态维度与数学定义)
   - [2.2 开关互斥判定准则](#22-开关互斥判定准则)
   - [2.3 白黄双色小字渲染契约](#23-白黄双色小字渲染契约)
   - [2.4 状态流转矩阵（完整 5 态流转）](#24-状态流转矩阵完整-5-态流转)
   - [2.5 核心边界场景详解：已系统化应用开启仅保活](#25-核心边界场景详解已系统化应用开启仅保活)
3. [UI 交互与渲染规范](#三ui-交互与渲染规范)
   - [3.1 概览卡片交互（类别点击切换 + FLIP 过渡）](#31-概览卡片交互类别点击切换--flip-过渡)
   - [3.2 列表平滑刷新机制（零卡顿保障）](#32-列表平滑刷新机制零卡顿保障)
   - [3.2.1 双开 / 多用户 / 分身应用去重](#321-双开--多用户--分身应用去重)
   - [3.2.2 跨分类互斥原子清理](#322-跨分类互斥原子清理)
   - [3.2.3 意图继承：严禁无条件抹除 intent](#323-意图继承严禁无条件抹除-intent)
   - [3.3 AOSP 全版本保活能力矩阵（Android 8 ~ 17）](#33-aosp-全版本保活能力矩阵android-8--17)
4. [软重启转正机制（Reconcile via `pm path`）](#四软重启转正机制reconcile-via-pm-path)
   - [4.1 场景](#41-场景)
   - [4.2 策略（用户确认）](#42-策略用户确认)
   - [4.3 触发入口（零额外功耗）](#43-触发入口零额外功耗)
5. [详细实操手册（从开发到打包）](#五详细实操手册从开发到打包)
   - [5.1 本地开发与调试](#51-本地开发与调试)
   - [5.2 自动化测试执行](#52-自动化测试执行)
   - [5.3 交叉编译与模块打包](#53-交叉编译与模块打包)
   - [5.4 真机测试与诊断指令](#54-真机测试与诊断指令)
6. [规范总结与自检红线](#六规范总结与自检红线)

---

## 一、系统整体架构与解耦合设计

### 1.1 WebUI 前端模块拆分（高内聚、纯逻辑分离）

WebUI 源码位于 `webui/src/`，按职责拆分为 6 个高内聚模块：

| 模块 | 职责 | 约束 |
| :--- | :--- | :--- |
| `types.ts` | 全部类型契约（`ActualStatus` / `IntentStatus` / `Category` / `SummaryStats` / `AppDisplayStatus`） | 零运行时逻辑 |
| `stateMachine.ts` | 双维度状态机与全部纯函数 | **禁止依赖 DOM**，可独立测试 |
| `api.ts` | 与 Rust CLI 的进程桥接（`exec` / `list` / `systemize` 等） | 唯一允许出现 shell 调用的模块 |
| `icons.ts` | 应用图标懒加载（`IntersectionObserver`，`rootMargin: 120px`） | 内部维护 observer 缓存 |
| `dialogs.ts` | 确认弹窗、Toast 提示、关于弹窗 | 纯 DOM 副作用封装 |
| `main.ts` | 协调器：状态持有、列表渲染、FLIP 动画、事件绑定 | 唯一可变全局状态的模块 |
| `state.ts` | **兼容垫片**：re-export 新模块公开 API | 避免破坏既有 import 路径，逐步废弃 |

#### 拆分收益

1. **可测试性**：`stateMachine.ts` 无 DOM 依赖，可在 Node 原生测试器中直接跑；
2. **可维护性**：渲染、通信、弹窗、图标各自独立演进；
3. **可回退性**：`state.ts` 垫片保证旧引用不炸，支持渐进迁移。

---

### 1.2 Rust CLI 后端模块结构

CLI 源码位于 `cli/src/main.rs`，采用单文件内聚分区，核心函数按职责分组：

| 函数组 | 职责 |
| :--- | :--- |
| `read_state` / `write_state_atomic` | `systemizer-state.json` 原子读写（含 `.bak` 回滚） |
| `acquire_state_lock` | 写前抢 `systemizer-state.lock`（`create_new`，5 s 超时，60 s 判陈旧） |
| `systemize` / `unsystemize` | 系统化 / 反系统化主流程 |
| `reconcile` | 开机三段位（`install` / `post-fs-data` / `manual`）状态落定 |
| `expected_keepalive_packages` / `expected_keepalive_entries` | 从单文件状态提取保活包集合（含 `keepalive_only` 叠加态） |
| `KeepaliveCapabilities` / `apply_keepalive_multi_tiered` | 全版本保活能力矩阵（见 §3.3） |
| `after_state_changed` | 状态变更统一出口（描述 + sysconfig + 运行时同步） |
| `build_description` | 动态模块描述生成，口径与 WebUI 概览一致 |
| `reconcile_pms_paths` | 软重启转正（见第四章） |

#### 关键设计决策

1. **单一状态文件**：系统化意图与保活意图同存于 `systemizer-state.json`，保活用 `keepalive_only`
   标记而非第二份文件 —— 两处意图不可能互相漂移，WebUI 一次 `state-json` 就能拿到完整快照；
2. **`after_state_changed` 单一出口**：任何状态变更都必须经过它，保证派生数据不会漂移；
3. **Windows 编译兼容**：`PermissionsExt` 与 `set_file_perm` 用 `#[cfg(unix)]` 守护，使主机端 `cargo check` / `cargo build` 可跑通。

---

## 二、双类别互斥闭环状态机规范

### 2.1 状态维度与数学定义

应用状态由两个相互解耦的维度决定：

```typescript
// 1. 实际物理归属（开机/落盘现状，不可由前端凭空伪造）
export type ActualStatus =
  | 'systemized'  // 物理位于 system/app，是真正的系统应用
  | 'keepalive'   // 物理在 /data/app，仅运行时白名单保活
  | 'none'        // 普通用户应用

// 2. 待重启生效意图（下一次开机要进行的动作）
export type IntentStatus =
  | 'pending_add'     // 待系统化（已生成 APK 缓存，等待开机挂载）
  | 'pending_remove'  // 待移除（已标记删除，等待开机彻底清理）
  | 'none'            // 无待重启意图（即时状态或与物理现状一致）

// 3. 当前查看的界面分类
export type Category = 'app' | 'keepalive'
```

> **`pending_add` 的物理基准必须为 `none`**：APK 缓存已生成但尚未重启落盘，
> 此时 `pm path` 仍指向 `/data/app`，若谎报 `systemized` 会误导用户。

---

### 2.2 开关互斥判定准则

对于任意应用，在当前分类视图 `category` 下，**开关是否开启由以下纯函数唯一定义**：

```typescript
export function isSwitchOn(actual: ActualStatus, intent: IntentStatus, category: Category): boolean {
  if (category === 'app') {
    // 在系统化视图：物理已系统化且未被标记移除，或用户刚刚开启了待系统化
    if (actual === 'systemized') {
      return intent !== 'pending_remove'
    }
    return intent === 'pending_add'
  }

  if (category === 'keepalive') {
    // 在仅保活视图：仅当物理现状为保活时开启
    return actual === 'keepalive'
  }

  return false
}
```

> **互斥定理**：
> 因为 `actual` 是单选枚举（不可能既是 `systemized` 又是 `keepalive`），且开启保活直接生效（`intent` 为 `none`），因此**同一个应用在 `app` 和 `keepalive` 两个页面中的开关状态是严格互斥的，绝不可能在两边同时呈现打开状态**。
>
> 该定理在测试套件中通过**遍历全部 `ActualStatus × IntentStatus × Category` 组合**并断言 `!(appOn && keepOn)` 得到机器证明。

---

### 2.3 白黄双色小字渲染契约

应用条目副标题文本严格遵守：**白字表示开机现状事实，黄字表示待重启意图，两者以单个半角空格间隔**。

```typescript
export function getDisplayStatus(actual: ActualStatus, intent: IntentStatus) {
  // actualText 取值被类型系统收紧为：'已系统化' | '已保活' | '未处理'
  switch (actual) {
    case 'systemized': return { actualText: '已系统化', actualClass: 'ok', ... }
    case 'keepalive':  return { actualText: '已保活',   actualClass: 'ka', ... }
    case 'none':       return { actualText: '未处理',   actualClass: 'muted', ... }
  }
}
```

| actual | intent | 渲染结果 | 备注 |
| :--- | :--- | :--- | :--- |
| `systemized` | `none` | `已系统化` | — |
| `systemized` | `pending_remove` | `已系统化 待移除` | app 视图的「待移除」 |
| `none` | `pending_add` | `未处理 待系统化` | — |
| `keepalive` | `none` | `已保活` | — |
| `keepalive` | `pending_remove` | `已保活 待移除系统化` | **S3→S5 边界态**，黄字按 `actual==='keepalive'` 升级，补齐动作方向与对象 |
| `none` | `none` | `未处理` | — |
| `none` | `pending_remove` | —— **不可达** | `deriveActual` 对 `status === 'pending_remove'` 恒返回 `'systemized'`（重启前仍驻留 system/app，物理基准是 systemized），因此该组合永不产生；实际渲染走上一行「已系统化 待移除」。**不要**为它补回落分支 |

#### 渲染红线

1. **白字**（`actualText`）颜色为 `var(--muted)`，禁止加 `text-shadow`；
2. **黄字**（`intentText`）颜色为 `#ff9500`，禁止改为 `#ffca28` 等其他色值；
3. 两者之间**必须且仅能有一个半角空格** `' '`，测试中以字面量断言；
4. **禁止出现「待保活」**文案 —— 保活是即时白名单注入，打开即纯白「已保活」。

---

### 2.4 状态流转矩阵（完整 5 态流转）

```
        ┌─────────────┬──────────────┬──────────────┬─────────────┬─────────────┐
        │  S1 普通    │  S2 待系统化  │  S3 已系统化  │  S4 待移除   │  S5 已保活  │
├───────┼─────────────┼──────────────┼──────────────┼─────────────┼─────────────┤
│ actual│    none     │     none     │  systemized  │  systemized │  keepalive  │
│ intent│    none     │  pending_add │     none     │pending_remove│   none      │
├───────┼─────────────┼──────────────┼──────────────┼─────────────┼─────────────┤
│ 文案  │   未处理    │ 未处理 待系统化│  已系统化    │已系统化 待移除│   已保活    │
├───────┼─────────────┼──────────────┼──────────────┼─────────────┼─────────────┤
│ 重启  │     否      │      是      │      否      │     是      │     否      │
└───────┴─────────────┴──────────────┴──────────────┴─────────────┴─────────────┘

        ┌──────────────────────┐
        │ S3→S5 边界态（运行中）│
├───────┼──────────────────────┤
│ actual│     keepalive       │
│ intent│   pending_remove    │
├───────┼──────────────────────┤
│ 文案  │ 已保活 待移除系统化  │
├───────┼──────────────────────┤
│ 重启  │        是           │
└───────┴──────────────────────┘
```

> **S3→S5 边界态**：白字派生自 `actual==='keepalive'`，黄字因此**升级为「待移除系统化」**
> （[stateMachine.ts:96-103](webui/src/stateMachine.ts#L96-L103)），补齐动作方向与对象，避免
> 「保活被移除」的误读。该态在 app 视图中开关自动关闭（互斥），仅在保活视图中可见。
> 物理上 `system/app/<pkg>` 已被立刻删除，重启后记录与 APK 缓存一并清空。

#### 关键流转路径

1. **S1 → S2 → S1**（取消待系统化）：回滚到物理基准 `none`，删除 APK 缓存；
2. **S1 → S2 → S3**（重启生效）：开机 `reconcile --phase post-fs-data` 落定；
3. **S3 → S4 → S1**（反系统化并重启）：清理 `/system/app/<pkg>` 与缓存；
4. **S3 → S5 边界态**（已系统化应用开启仅保活）：**仅在 WebUI 保活视图中可达**，
   实际行为见 §2.5——保活立即生效 + 立即撤销系统化身份，下一次重启后清理残留；
5. **S5 → S1**（关闭仅保活）：仅清除运行时白名单，不动 `/system/app` 文件。

---

### 2.5 核心边界场景详解：已系统化应用开启仅保活

> ⚠️ 本节是 WebUI `doKeepaliveFromSystemized`（[main.ts:519-538](webui/src/main.ts#L519-L538)）
> 调用链路的真实实现，**与 v1.2.0 文档存在差异**，按现行代码为准。

当用户在 `keepalive` 视图对已系统化（S3）应用打开开关时，WebUI 只发一条 CLI 命令：

```
keepalive <pkg> on
```

**`set_keepalive_only(pkg, true)`（[main.rs:646](cli/src/main.rs#L646)）**

1. 按**物理事实**判定「原本是否已系统化」：`system/app/<pkg>` 目录存在，且记录为
   `Active` / `PendingAdd`、`keepalive_only=false`；
2. 是 → **立刻 `remove_dir_all`** 摘掉模块里的 `system/app/<pkg>`（应用进程仍在跑，无感知），
   记录置 `keepalive_only=true` + `status=pending_remove` + `pending_boot_id`；
   `target` 保留原类别，因为 `reconcile` 要靠它定位待清理目录；
3. 否 → 纯保活：`target=keepalive`、`status=active`；
4. 立即下发全版本保活能力矩阵（§3.3）—— `deviceidle whitelist` / `standby-bucket active` /
   三条 AppOps / TARE VIP / `am unfreeze` / `oom_score_adj=200`；
5. 写入 `system/etc/sysconfig/z-systemizer-aosp-keepalive.xml` 静态白名单。

「保活白名单已生效」与「系统化身份被撤销」在**同一条命令内**完成，
中间不存在「既保活又仍挂载在 system/app」的窗口。v1.2.6 之前 WebUI 连发
`keepalive on` + `unsystemize` 两条命令，两条之间失败就会留下不一致的中间态，现已合并。

**界面上看到什么（依据 `actual` 派生，与视图无关）**

| 位置 | 表现 |
| :--- | :--- |
| 仅保活视图小字 | 白字 **已保活** + 黄字 **待移除系统化**（按 `actual==='keepalive'` 派生） |
| 仅保活视图开关 | **ON** |
| app 视图开关 | **自动 OFF**（`isSwitchOn` 保证互斥） |
| 概览第一栏「已处理」 | 不变（叠加态仍计入已处理，只是归类从「系统化」变成「保活」） |
| 概览第二栏「待重启」 | **+1** |
| Toast | 「已加入保活白名单，重启后将移出 system/app」 |

**关闭仅保活的语义**

在保活视图关掉：清 `keepalive_only` 标记 + 撤销运行时白名单。纯保活记录
（`target=keepalive`）整条删除；叠加态记录**保留** `pending_remove` 意图。
得到一个既不保活、又会被下次开机移除的应用，**不会自动恢复系统化身份**。
若想恢复系统化，必须在 app 视图打开开关（撤销移除），`systemize` 走
`PendingRemove + apks 缓存存在 → restored` 分支，并顺带清掉保活标记。
注意：**`apks` 缓存一旦丢失，撤销会失败**，会退化为 `pending_add` 重新拷贝 APK。

---

## 三、UI 交互与渲染规范

### 3.1 概览卡片交互（类别点击切换 + FLIP 过渡）

界面顶部 Summary Card 采用 `display: grid; grid-template-columns: repeat(3, 1fr)` 三等分网格：

```
┌────────────────────┬────────────────────┬────────────────────────┐
│         12         │         2          │   app    (可点击切换)    │
│      已处理        │       待重启       │       system/app       │
└────────────────────┴────────────────────┴────────────────────────┘
```

#### 统计口径（与 CLI `build_description` 严格一致，双视图全局共享）

| 栏位 | 口径 | 说明 |
| :--- | :--- | :--- |
| 第一栏「已处理」 | 物理已生效项 | `keepalive_only` 记录一律计入；`target≠keepalive` 的再计入「系统化」子项 |
| 第二栏「待重启」 | `pending_add` + `pending_remove` | **与第一栏不互斥**：叠加态（已保活 + 待移除系统化）两栏同时计入 |
| 第三栏「类别」 | `app` ⇄ `仅保活` | 可点击切换；`keepalive` 视图副标题显示 `实时生效` |

> **设计理由**：概览是对设备整体状态的陈述，不应随用户切换列表视图而改变读数。
> 叠加态刻意同时计入两栏——保活此刻已生效（计入已处理），系统目录尚未摘除（计入待重启）。
> CLI 侧 `build_description` 从同一份 `systemizer-state.json` 用同一口径计算，
> 保证 KernelSU 管理器、WebUI 概览、模块介绍三处数字永远一致。

#### 交互细节

1. **触发方式**：第三栏 `cursor: pointer`，用户点击在 `app` 和 `仅保活` 间平滑切换。
2. **文本与副标题动态绑定**：
   * **处于 `app` 分类模式**：主标题 `app`，下方小字 `system/app`；
   * **处于 `仅保活` 分类模式**：主标题 `仅保活`，下方小字 **`实时生效`**。
3. **分类感知三级严格置顶排序**：`sortApps(apps, category)` 按当前视图调整优先级。

   > **核心约束（修复置顶逻辑倒挂）**：置顶顺序必须与开关状态保持一致，
   > **严禁出现「开关关闭项排在开关打开项之上」的倒挂**。

   * `app` 视图（开关 ON = `pending_add` | `systemized`）：

     | 优先级 | 状态 | 开关 |
     | :--- | :--- | :--- |
     | 0 | `pending_add` 待系统化 | ON |
     | 1 | `systemized` 已系统化 | ON |
     | 2 | `pending_remove` 待移除 | OFF |
     | 3 | `keepalive` 已保活 | OFF |
     | 4 | `normal` 未处理 | OFF |

   * `仅保活` 视图（开关 ON = `keepalive`）：

     | 优先级 | 状态 | 开关 |
     | :--- | :--- | :--- |
     | 0 | `keepalive` 已保活 | ON |
     | 1 | `pending_add` 待系统化 | OFF |
     | 2 | `systemized` 已系统化 | OFF |
     | 3 | `pending_remove` 待移除 | OFF |
     | 4 | `normal` 未处理 | OFF |

   * 同级一律使用 `appName.localeCompare(..., 'zh-Hans-CN')`，保证中文应用名字典序稳定。
4. **FLIP 过渡动画**：在 `category` 切换**与开关点击导致重排**时启用。
   * 采集阶段：`captureCardRects()` 用 `getBoundingClientRect()` 记录全部可见卡片坐标；
   * **Invert 阶段**：显式 `transition: 'none'` → 立即写入 `transform = translate(dx, dy)` → **强制回流**（读取 `offsetHeight`）；
   * **Play 阶段**：`requestAnimationFrame` 中显式声明 `transition: 'transform 360ms cubic-bezier(0.2,0.8,0.2,1)'` 并清空 `transform`；
   * 380ms 后清理 `is-flipping` 类与内联 `transition`；
   * **单卡片 busy 态等不改变排序键的局部更新走 `updateCardDOM(pkg)` 节点复用，不触发 FLIP**（兼顾体验与性能）。

   > **为什么必须强制回流**：若缺少 `void list.offsetHeight`，同一帧内的
   > 「开启 transition + 清除 transform」会被浏览器合并为一次样式变更，动画直接丢失，
   > 卡片表现为瞬间跳变而非平滑滑动。

---

### 3.2 列表平滑刷新机制（零卡顿保障）

为了保证在 100+ 应用长列表中拥有 60fps 丝滑体验，严格沿用以下机制：

1. **节点复用（Differential DOM Update）**：
   * 采用 `renderedCards` Map 缓存所有卡片 DOM；
   * 就地更新 `.app-status` 的 HTML 与 `.switch` 的 Class，**禁止调用 `list.innerHTML = ''` 全量重绘**。
2. **两种更新通道，按是否改变排序键选择**：

   | 函数 | 适用场景 | 是否重排 | 是否 FLIP |
   | :--- | :--- | :--- | :--- |
   | `updateCardDOM(pkg)` | busy 态切换、错误回滚（排序键不变） | 否 | 否 |
   | `updateCardAndReorder(pkg)` | 开关点击后 `logical` 已变（排序键改变） | 是 | 是 |

   > **关键修复**：`logical` 即排序键。开关点击若只调 `updateCardDOM`，
   > 会出现「已置顶项仍排在开关关闭项之下」的倒挂与概览计数错乱。
3. **虚拟层级与 CSS Order 排序**：
   * 卡片排序不改变物理 DOM 树，仅动态设置 `card.style.order = String(index)`，避免昂贵的重排（Reflow）。
4. **图标按需懒加载（IntersectionObserver）**：
   * 设置 `rootMargin: '120px'`，应用滑入视口前 120px 提前加载图标；滑出后解除引用，防止显存泄漏。
5. **FLIP 只操作 `transform`**：
   * 动画期间仅改 `transform`，不触发 layout / paint；`is-flipping` 类设 `z-index: 2` 避免叠放瑕疵。

---

### 3.2.1 双开 / 多用户 / 分身应用去重

Android 多用户、应用双开与系统分身场景下，`listPackages('all')` 与 `pm list packages -3`
会为同一 `packageName` 返回多条记录。若不处理，将导致：

* `renderedCards` Map 键碰撞，卡片 DOM 相互覆盖；
* `mergeBusyState` / `appMap` 按包名索引错乱；
* 概览统计双计数。

**规范（双层纵深防御）**：

1. `api.ts` `getApps()`：`Array.from(new Set(rawPkgs))` 去重后再取应用信息；
2. `api.ts` `getAppsSafe()` 回退路径同样去重；
3. `stateMachine.ts` `buildUiApps()` 内建 `seenPackages` 语义的 Map 去重，保留首次出现条目。

---

### 3.2.2 跨分类互斥原子清理

状态机保证「同一应用在 `app` 与 `keepalive` 两个分类下永远不可能同时为 ON」（红线 3），
但仅靠前端推导不足以保证物理状态一致，必须在 **Rust CLI 侧做原子清理**：

| 入口 | 互斥动作 | 实现 |
| :--- | :--- | :--- |
| `systemize(pkg, target)` | 清除该包的 `keepalive_only` 标记，并同步重算 AOSP sysconfig 白名单标签 | `systemize` 内保活清理分支 |
| `set_keepalive(pkg, true)` | 若该应用处于 `pending_add`（待系统化），自动取消该意图并移除记录 | `set_keepalive` 内 `should_cancel` 分支 |

> 清理失败仅记 `warn=*`，**绝不阻塞主流程**；最终一致性由 WebUI 二次同步与
> 开机 `refresh-derived` 链路保证。

---

### 3.2.3 意图继承：严禁无条件抹除 `intent`

`buildUiApps` 旧实现中 `const intent = inKeepalive ? 'none' : deriveIntent(record)`
会把已系统化应用的 `pending_remove` 意图强制抹掉，造成：

* 「待移除」黄字标记丢失，用户看不到「重启后将移出 system/app」；
* 概览「待重启」计数漏算。

**修复后规范**：`intent` 一律由 `deriveIntent(record)` 推导，
保活集合只影响 `actual`（置为 `'keepalive'`），**不得覆盖真实意图**。
渲染契约随之变为白字 `已保活` + 单个半角空格 + 黄字 `待移除`。

---

### 3.3 AOSP 全版本保活能力矩阵（Android 8 ~ 17）

两类应用各尽其才：**系统化应用**凭 `FLAG_SYSTEM` 身份获得原生豁免；**仅保活应用**无系统身份，
必须依 AOSP 演进历史自底向上实施五级防御，并通过版本侦测实现零报错优雅降级。

#### 3.3.1 系统化应用（`system/app`）的保活闭环

| 能力 | 机制 | 实现位置 |
| :--- | :--- | :--- |
| 原生身份 | 豁免 Android 8.0 后台服务启动限制、可直接声明系统级受保护权限 | `/system/app/<pkg>` 落盘 |
| 静态 XML 白名单 | `allow-in-power-save` / `allow-in-power-save-except-idle` / `allow-in-data-usage-save` / `allow-unthrottled-location` | `update_aosp_keepalive_sysconfig` → `system/etc/sysconfig/z-systemizer-aosp-keepalive.xml` |
| 待机桶锁定 | `am set-standby-bucket <pkg> active` | `apply_keepalive_multi_tiered` Level 2 |
| LMK 权重钳制 | `/proc/<pid>/oom_score_adj` 写 `200` | `set_oom_score_adj_clamp` |

#### 3.3.2 仅保活应用（`/data/app`）五级防御矩阵

| 防御层级 | 机制 | 解决痛点 | 版本区间 | 核心命令 |
| :--- | :--- | :--- | :--- | :--- |
| **Level 1** 基础级 | Doze 模式豁免 | 息屏断网、WakeLock 失效 | API 23+ | `cmd deviceidle whitelist +<pkg>` + sysconfig 静态注入 |
| **Level 2** 调度级 | App Standby 待机桶提升 | JobScheduler / Alarm 降频 | API 28+ | `am set-standby-bucket <pkg> active` |
| **Level 3** 行为级 | AppOps 后台权限免除 | 切后台被拦截广播、禁启动 Service | API 26+ / 29+ | `cmd appops set <pkg> RUN_IN_BACKGROUND allow`、`RUN_ANY_IN_BACKGROUND`、`WAKE_LOCK`；`SYSTEM_ALERT_WINDOW` 需 API 29+ |
| **Level 4** 资源级 | TARE 经济特权 & 幽灵进程豁免 | Android 12+ 杀子进程、13+ 电池信用点耗尽 | API 31~33 / 33+ | `device_config put activity_manager max_phantom_processes 128`；`cmd tare set-vip 0 <pkg> true`；`pm grant <pkg> android.permission.POST_NOTIFICATIONS` |
| **Level 5** 内核级 | cgroup 解冻 & LMK 压制 | Android 11+ 进程被内核冻结、内存紧张被杀 | API 30+ | `am unfreeze <pkg>`；`/proc/<pid>/oom_score_adj` = `200` |

#### 3.3.3 版本侦测与能力阶梯调度器

```rust
fn get_android_sdk_level() -> u32 {
    run_command("getprop", &["ro.build.version.sdk"])
        .ok()
        .and_then(|out| out.trim().parse::<u32>().ok())
        .unwrap_or(26) // 兜底 API 26 = Android 8.0（模块最低支持版本）
}
```

`KeepaliveCapabilities::detect()` 按 API Level 门控 8 项能力布尔位：
`has_deviceidle(23+)` / `has_appops_bg(26+)` / `has_standby_bucket(28+)` / `has_bg_activity_ops(29+)` /
`has_app_freezer(30+)` / `has_phantom_proc(31~33)` / `has_tare_vip(33+)` / `has_post_notifications(33+)`。

**为什么必须做版本侦测**：在 Android 10 上执行 `cmd tare set-vip` 会抛 `No service: tare`，
在 Android 8 上执行 `am set-standby-bucket` 会抛 `Error: unknown command`。缺乏拦截会导致 CLI 报错中断、
产生未定义状态。

#### 3.3.4 隔离沙箱原则

`apply_keepalive_multi_tiered(pkg, enabled, caps)` 中每个层级的命令**独立隔离**：
单项失败仅向 stderr 输出 `warn=*` 键值对，**绝不阻塞主流程、绝不中断 CLI**。
因此本模块在 Android 8 到 Android 17 之间做到「低版本不执行未知命令，高版本尽享最新特权」。

#### 3.3.5 纯保活应用的同步链路（关键架构约束）

`expected_keepalive_packages(state)` / `expected_keepalive_entries(state)` **必须同时收两类记录**：
`keepalive_only=true` 的（纯保活 + 叠加态），以及 `target≠keepalive` 且状态为
`Active` / `PendingAdd` 的。
否则纯保活应用（从未系统化）会在开机同步链路 `sync_runtime_deviceidle` / `sync_standby_buckets` /
`update_aosp_keepalive_sysconfig` 中被完全漏掉，导致其保活能力全部失效。

`after_state_changed` 在 `WebUi` / `Manual` 模式下额外调用 `sync_runtime_keepalive_from_state`，
对纯保活包做幂等补齐。

#### 3.3.6 诊断可观测性

`systemizer diagnose` 输出能力矩阵快照，便于真机排查版本降级是否符合预期：

```
keepalive_sdk_level=34
keepalive_cap_deviceidle=true
keepalive_cap_appops_bg=true
keepalive_cap_standby_bucket=true
keepalive_cap_bg_activity_ops=true
keepalive_cap_app_freezer=true
keepalive_cap_phantom_proc=false
keepalive_cap_tare_vip=true
keepalive_cap_post_notifications=true
```

---

## 四、软重启转正机制（Reconcile via `pm path`）

### 4.1 场景

用户在 WebUI 标记「待系统化」（`pending_add`），随后通过**软重启**（zygote 重启 / crash 恢复）
让 `/system/app/<pkg>` 已被 PackageManager 重新扫描。此时开机 `bootId` 未变，
常规 `reconcile` 不会落定 `pending_add`，界面会一直停在「未处理 待系统化」。

### 4.2 策略（用户确认）

只要 `pm path <pkg>` 命中 `/system/app/<pkg>/...` 或 `/system/system/app/<pkg>/...`：

1. `pending_add` **立刻转正**为 `AppStatus::Active`，清空 `pending_boot_id`；
2. `pending_remove` 若已从 `/system/app` 消失则**清理记录**，回到普通应用；
3. 落定后调 `after_state_changed` 更新 `module.prop`：`diagnose` 与 `refresh-derived` 会调（分别走 `ApplyMode::WebUi` / `Manual`）；**`state-json` 只写盘不调** —— 它是高频只读路径（WebUI 每次刷新都打），挂上 `deviceidle`/`appops` 下发会让每次轮询都跑一遍 shell，派生状态统一交给紧随其后的 `refresh-derived` 收敛。

写盘仍由 `write_state_atomic` 的 `.bak` 回滚兜底。注意：**探测失败不算证据**，
见 §4.4 安全不变量第 1 条 —— 策略在「探测不可用」这一档上是保守的，不是激进的。

### 4.3 触发入口（零额外功耗）

| 入口 | 说明 |
| :--- | :--- |
| `systemizer state-json` | WebUI 读取状态前先转正 |
| `systemizer diagnose` | 函数首行，使诊断输出反映物理现状 |
| `systemizer refresh-derived` | 先转正再刷新 |

**不加定时任务** —— 仅在用户主动触发时探测一次。

### 4.4 实现（已落地）

`cli/src/main.rs`：

- `pm_reports_system_apk(pkg) -> Option<bool>`（`:276`）—— 直接跑 `pm path <pkg>`，
  逐行解析 `package:` 前缀，命中 `.apk` 且路径落在 system 分区即 `Some(true)`；
  `pm` 缺失 / 非零退出一律返回 `None`。
- `is_system_apk_path(path)`（`:260`）—— 用 `components().windows(2)` 匹配
  `system/app` 与 `system/priv-app`，因此 `/system/system/app/...` 叠加挂载点同样命中
  （`priv-app` 仅用于识别历史遗留挂载，模块本身不再生成该目录）。
- `settle_action(status, keepalive_only, pm_system) -> SettleAction`（`:1400`）—— 纯函数状态机，
  四档：`Keep` / `PromoteToActive` / `CollapseToKeepalive` / `Drop`；
  `pm_system == None` 时**一律 `Keep`**（核心安全不变量）。
- `settle_pending_via_pm(&mut StateFile) -> bool`（`:1430`）—— 遍历记录套用上述状态机，
  返回是否改动。

#### 安全不变量（改动前必读）

1. **探测失败 ≠ 已移除**。`pm` 在受限 shell 上下文（KernelSU WebUI）里可能不存在；
   若把 `None` 当成 `Some(false)`，一次失败的探测就会把排队中的 `pending_add`/`pending_remove`
   记录整条删掉。故 `pm_reports_system_apk` 显式三态，`settle_action` 对 `None` 恒 `Keep`。
2. **叠加态永不被 `Drop`。`PendingRemove + keepalive_only` 且物理已不在 system →
   `CollapseToKeepalive`（target→`keepalive`、status→`Active`、清空 `pending_boot_id`），
   与冷启动 `reconcile --phase post-fs-data` 的收尾行为完全一致。
3. `PendingAdd` 未生效时**只等不删**（`Some(false)` → `Keep`），避免和 fs 对账抢跑。

---

## 五、详细实操手册（从开发到打包）

### 5.1 本地开发与调试

#### 前置环境要求

* **Node.js**: v20+ 或 v24+
* **Rust**: 1.75+（需安装 Android 目标库）
* **Android 交叉编译工具链**: `aarch64-linux-android`

#### 前端热重载启动

```bash
# 1. 进入 WebUI 目录
cd webui

# 2. 安装依赖（首次运行）
npm install

# 3. 启动 Vite 开发调试服务器
npm run dev
# 浏览器访问：http://localhost:5173 即可预览界面
```

---

### 5.2 自动化测试执行

本项目支持纯逻辑的无浏览器原生测试（基于 Node.js 24 原生测试运行器）：

```bash
# 进入 webui 目录并运行状态机测试
cd webui
node --test --experimental-strip-types test/stateMachine.test.ts
```

#### 预期测试覆盖项

* [x] `isSwitchOn` 在两类别下的绝对互斥性测试（遍历全部组合）
* [x] `getDisplayStatus` 白黄小字与单个半角空格排版测试
* [x] `'未处理' -> '待系统化' -> 取消待系统化` 回滚基准测试
* [x] `'已系统化' -> '仅保活开启' -> '已保活 待移除系统化'` 转移测试（v1.2.1：白字切到「已保活」，黄字升级补齐动作方向）
* [x] `'已保活' -> '系统化开启' -> '未处理 待系统化'` 互斥测试
* [x] `computeSummary` 全局口径（`systemized + keepalive` / `pending_add + pending_remove`）
* [x] `computeSummary` 与 `category` 解耦（两个视图读数一致）
* [x] `sortApps` 分类感知三级严格置顶（app 视图 + keepalive 视图，ON 项必须全部排在 OFF 项之上）
* [x] `sortApps` 同级中文应用名字典序（`zh-Hans-CN`）与纯函数不修改入参
* [x] `filterByCategory` 保活视图必须能看见全部应用
* [x] `buildUiApps` 意图继承：保活集合内 `pending_remove` / `pending_add` 严禁被抹成 `none`
* [x] `buildUiApps` 双开/多用户/分身重复 `packageName` 去重，且 `computeSummary` 不双计数
* [x] `deriveActual` 软重启转正语义（`pending_add` 必须返回 `none`）

---

### 5.3 交叉编译与模块打包

#### 1. 编译前端生产静态资源

```bash
cd webui
npm run build
# 产物将输出至 webui/dist/
```

#### 2. 交叉编译 Rust 核心执行器（CLI）

必须针对 Android 64 位目标（`aarch64-linux-android`）进行静态发布编译：

```bash
cd cli
cargo build --release --target aarch64-linux-android
# 产物位置：cli/target/aarch64-linux-android/release/systemizer
```

> **前置条件**：需安装 Android NDK，并将其 `toolchains/llvm/prebuilt/<host>/bin`
> 加入 `PATH`，或配置 `~/.cargo/config.toml` 的 `target.aarch64-linux-android.linker`。
> 缺失 NDK 时 `cargo build --target aarch64-linux-android` 会因找不到 `cc` 链接器而失败。

#### 3. 组装并生成一键刷入 Zip 模块

在项目根目录下通过 PowerShell 执行自动化组装打包：

```powershell
# 1. 拷贝前端静态资源至模块目录
Copy-Item -Path "webui/dist/*" -Destination "module-template/webroot/" -Recurse -Force

# 2. 拷贝并赋予 CLI 二进制文件执行路径
New-Item -ItemType Directory -Path "module-template/bin/arm64-v8a" -Force | Out-Null
Copy-Item -Path "cli/target/aarch64-linux-android/release/systemizer" -Destination "module-template/bin/arm64-v8a/systemizer" -Force

# 3. 自动生成模块 SHA256 校验清单
New-Item -ItemType Directory -Path "module-template/checksums" -Force | Out-Null
Get-FileHash "module-template/bin/arm64-v8a/systemizer" -Algorithm SHA256 | ForEach-Object { "$($_.Hash.ToLower())  bin/arm64-v8a/systemizer" } | Out-File -FilePath "module-template/checksums/SHA256SUMS" -Encoding ascii

# 4. 压缩生成刷机包
New-Item -ItemType Directory -Path "out" -Force | Out-Null
Compress-Archive -Path "module-template/*" -DestinationPath "out/Z-Systemizer-v1.2.1-release.zip" -Force
Write-Host "打包完成：out/Z-Systemizer-v1.2.1-release.zip" -ForegroundColor Green
```

---

### 5.4 真机测试与诊断指令

将生成的 `zip` 在 KernelSU / APatch / Magisk 中刷入并重启，可通过 ADB 终端直接调试验证：

```bash
# 1. 查看模块落盘 JSON 完整状态（含软重启转正）
su -c "/data/adb/modules/ksu-systemizer/bin/systemizer state-json"

# 2. 验证保活白名单注入情况（AOSP DeviceIdle）
su -c "dumpsys deviceidle whitelist"

# 3. 运行全链路健康自检（含能力矩阵快照）
su -c "/data/adb/modules/ksu-systemizer/bin/systemizer diagnose"

# 4. 测试手动开启某应用仅保活（实时生效，无需重启）
su -c "/data/adb/modules/ksu-systemizer/bin/systemizer set-keepalive com.tencent.mm true"

# 5. 测试手动设置系统化（待重启）
su -c "/data/adb/modules/ksu-systemizer/bin/systemizer systemize com.eg.android.AlipayGphone app"
```

---

## 六、规范总结与自检红线

- **红线 1**：严禁出现「待保活」小字，保活是即时白名单注入，打开即为纯白「已保活」。
- **红线 2**：白字和黄字之间必须且仅能使用**单个半角空格**间隔。
- **红线 3**：同一应用在 `app` 和 `仅保活` 下的开关状态必须绝对互斥。
- **红线 4**：概览卡片第三栏承担类别切换，小字在保活模式下必须为 **`实时生效`**。
- **红线 5**：前端代码严格解耦，`stateMachine.ts` 保持纯函数且脱离 DOM，确保可靠性。
- **红线 6**：`expected_keepalive_packages` / `expected_keepalive_entries` 必须合并两份状态文件的包集合，纯保活应用不得被同步链路漏掉。
- **红线 7**：`apply_keepalive_multi_tiered` 每一层必须独立隔离，单项失败仅 warn，绝不中断主流程。
- **红线 8**：概览「已处理」口径 = `systemized + keepalive`，「待重启」口径 = `pending_add + pending_remove`，且与 `build_description` 严格一致。
- **红线 9**：置顶排序必须与开关状态一致，严禁「开关关闭项排在开关打开项之上」的倒挂；开关点击后必须走 `updateCardAndReorder` 联动重排。
- **红线 10**：`buildUiApps` 严禁无条件把 `intent` 覆盖为 `'none'`，`pending_add` / `pending_remove` 真实意图必须保留。
- **红线 11**：`api.ts` 与 `buildUiApps` 必须对 `packageName` 去重，双开/多用户/分身不得产生重复卡片或双计数。
- **红线 12**：互斥必须在 CLI 侧原子落地——`systemize` 剔除保活条目，`set_keepalive(pkg, true)` 取消 `pending_add`。
- **红线 13**：FLIP 的 Invert 阶段必须显式 `transition: 'none'` 并强制回流（`offsetHeight`），否则动画会被合并丢弃。

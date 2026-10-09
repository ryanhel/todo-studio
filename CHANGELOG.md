# 变更清单

## 0.3.3 —— 提醒的"亮点"重做：一态一色说到做到

**现象**：列表里「即将到期」和「已提醒」是**同一种琥珀色**（README 里写着"一态一色"，实际撞色），
一眼分不出"快到了"和"已经提醒过"；到点条目那几秒的呼吸高亮偏软（3px 左条 + 只有整条背景在闪），
窗口一多就很难注意到是哪一条在响。

**原因**：两个状态共用了 `--warn-soft / --warn-line` 一套令牌，差异只落在文案上。

| # | 变更 | 文件 |
| --- | --- | --- |
| 1.1 | 新增「已提醒」专用令牌 `--fired-bg / --fired-line / --fired-ink`（深色板：实心琥珀 + 深褐字；浅色板：淡填充 + 深琥珀字），并同步到"跟随系统"兜底块 | `style.css`（`tools/sync-light-theme.js`） |
| 1.2 | 芯片分档：**即将到期 = 空心琥珀**（还没发生）／**已提醒 = 实心琥珀 + 加粗**（已经发生，等你处理）—— 深浅两套外观都改 | `style.css` |
| 1.3 | 详情里的提醒块同步分档（`.remind-block.is-fired` 用实心琥珀，`.is-soon` 保持空心） | `style.css` |
| 1.4 | 到点高亮更好认但更克制：左侧亮条 3px → **4px**、加**整圈琥珀描边**（静态可见），呼吸 1.4s×4 → **1.2s×3** | `style.css` |
| 1.5 | 文档：状态表的两行琥珀改成"空心 / 实心"说明，高亮描述补上新样式 | `README.md` |
| 1.6 | 版本号 0.3.2 → 0.3.3 | `tinyjs.json` `README.md` |

> 验证方式：把 `style.css` 内联进一张对照页（七态芯片 + 正常/高亮条目并排），
> 用系统 QuickLook（WebKit，与运行时的引擎同源）分别按 `:root`（深色）与 `data-theme="light"`（浅色）
> 渲染成图逐张核对 —— 深浅两套都能一眼区分「空心琥珀 / 实心琥珀」。

## 0.3.2 —— 提醒状态按语义重做（"已取消"不再乱贴）

**现象**：一条待办被标记完成后，它的提醒芯片显示「已取消」；已经**提醒过**（弹出过系统通知）的条目
在完成之后同样显示「已取消」—— "取消"读起来像是用户主动关掉的，语义不对；另外"已过期"曾被同时用在
"已经提醒过、等你处理"和"到点了却一次都没送出去"两种完全不同的情况上。

**原因**：状态只按"开关是不是开着"分（enabled / disabled + cancelReason），没有区分
**"送出去过"、"到点但没送出"、"因为完成而结束"、"用户手动取消"**。

| # | 变更 | 文件 |
| --- | --- | --- |
| 1.1 | 状态从一个 `overdue` 拆成按语义的七态：**已设置 / 即将到期 / 已提醒（`firedCount ≥ 1`）/ 已过期（到点但从没送出）/ 已结束（完成时结束）/ 重复已结束 / 已取消（用户手动）** | `model.js` |
| 1.2 | 新增 `REMINDER_END_DETAIL`：把"为什么结束"写清楚（手动取消，设置保留 / 已完成，提醒随之结束 / 重复次数或截止日期已到），详情块直接拼在状态后面 | `model.js` `ui.js` |
| 1.3 | 芯片文案与配色按语义给：已提醒（琥珀，带具体时间）/ 已过期（红）/ 已结束 与 重复已结束（灰，**无删除线**）/ 已取消（灰 + 删除线） | `model.js` `style.css` |
| 1.4 | `reminderStats` / `reminderQueue`（"到点"横幅）改按 已提醒 + 已过期 统计 | `model.js` |
| 1.5 | 保存提示、完成/恢复提示改用新文案（"提醒已结束（已完成，提醒随之结束）"），不再说"已自动取消" | `app.js` |
| 1.6 | 详情里"尚未触发过"改为「尚未提醒过」，并在有台账时显示"最近提醒：…" | `ui.js` |
| 1.7 | 单元测试补三组语义断言（已提醒 ≠ 已过期 ≠ 已取消；重复走完；完成结束） | `tools/model.test.js` |
| 1.8 | 端到端自检改用**按标题定位芯片**的辅助函数（列表里可能同时有多个芯片），并分别覆盖"重复提醒滚到下一轮"与"一次性提醒停在已提醒"两条路径；自检同时纳入 `todo.settings.v1` 的重置（不然上一轮的通知设置会干扰下一轮断言） | `tools/selftest.js` |
| 1.9 | 版本号 0.3.1 → 0.3.2 | `tinyjs.json` `README.md` |

> 语义小结（README「提醒与通知」里也有表格）：**已提醒 = 送出去过**，**已过期 = 到点但没送出**，
> **已结束 = 完成时结束**，**已取消 = 用户手动关掉**；重复提醒触发后不停在"已提醒"，
> 而是直接滚到下一轮，送出去的证据留在详情的"最近提醒"里。

## 0.3.1 —— 修复：通知推送里的台账"慢一拍"

**现象**：到点弹出系统通知后，点回应用里的**详情面板仍显示「尚未触发过」**（"最近提醒"一行是空的），
列表芯片也停在旧状态；**关掉应用再打开才显示正确**的"最近提醒：2026-10-08 21:28"。

**原因**：后端到点推送的 `reminder-due` 里塞的是**投递之前**的日程对象 —— `firedCount: 0`、
`lastFiredAt: null`（重复提醒还带着上一轮的时间），页面据此写回条目，于是应用内看到的是"还没触发过"；
而重启时页面会做一次同步往返，从后端台账里把正确的值取回来 —— 这正是"关掉再进就对了"的由来。

| # | 变更 | 文件 |
| --- | --- | --- |
| 1.1 | `check()` 改为把**推进之后**的日程交给 `deliver()`：`firedCount` / `lastFiredAt` 已更新，重复提醒的 `at` 已滚到下一轮，整条结束则 `enabled=false` | `src/main.js` |
| 1.2 | `deliver()` 用 `info.at`（刚触发的那个时刻）拼横幅副标题与事件的 `at`，与"推进后的 `reminder.at`"区分开 —— 通知写的是"刚提醒的那一轮"，页面写回的是"下一轮" | `src/main.js` |
| 1.3 | 页面收到推送、写回台账后回同步一次（`scheduleReminderSync`），两边状态立即对齐 | `src/frontend/js/app.js` |
| 1.4 | 回归测试：断言推送里的 `firedCount` / `lastFiredAt` / 下一轮时间 / 结束状态都必须是"投递之后"的值（一次性 / 重复 / 次数结束三种） | `tools/reminder.test.js` |
| 1.5 | 版本号 0.3.0 → 0.3.1 | `tinyjs.json` `README.md` |

## 0.3.0 —— 待办定时提醒与系统级通知

需求：每条待办可设置提醒（日期时间 / 提前量 / 重复规则与结束条件），到点走**操作系统原生通知**而
不只是应用内提示；应用未聚焦、窗口关掉、甚至应用没打开时都要能按时（或补发）提醒；点击通知要能
聚焦窗口、跳到对应待办并高亮；同时给出通知权限、总开关、免打扰与提示音的控制。

### 1. 提醒模型（`src/frontend/js/model.js`）

| # | 变更 | 文件 |
| --- | --- | --- |
| 1.1 | 待办新增可选字段 `reminder`：`enabled / at / advance / repeat / endType / endCount / endDate / onDone / firedCount / lastFiredAt / cancelledAt / cancelReason` | `model.js` |
| 1.2 | 新增枚举与文案：提前量（准时·5 分钟…2 天）、重复（不重复 / 每天 / 每周 / 工作日）、结束条件（不限 / 按次数 / 按日期）、完成后处置（自动取消 / 保留） | `model.js` |
| 1.3 | 新增纯函数：`reminderDueAt`（触发时刻 = 提醒时间 − 提前量）、`reminderState`（已设置 / 即将到期 / 已过期 / 已取消）、`reminderPending`、`reminderActive` | `model.js` |
| 1.4 | 新增重复推进 `stepOccurrence` / `nextOccurrence`（用 `Date` 构造器做加法，跨月 / 跨年 / 夏令时交给平台日历）与 `advanceReminder`（一次性停在原地、重复推进到下一轮、次数或日期用尽即结束） | `model.js` |
| 1.5 | 新增输入校验 `normalizeReminderInput`（过去的时间被拒；`keepAt` 允许保留"已到点"的原时间）与表单态 `reminderForm` | `model.js` |
| 1.6 | 新增文案：`reminderTiming` / `reminderAdvanceText` / `reminderRepeatText` / `reminderSummary` / `reminderChipText` / `dayLabel` / `toLocalInput` / `fromLocalInput` | `model.js` |
| 1.7 | 新增总览与队列：`reminderStats`（条数 / 活跃 / 到点 / 即将到期 / 待补发）、`reminderQueue`（按触发时刻排序） | `model.js` |
| 1.8 | `sanitize()` 归一化 `reminder`（结构坏了就当作没设置）；`validate` / `create` / `patch` 携带并校验提醒；`patch` 同日程保留台账（改标题不会重置"已触发次数"） | `model.js` |
| 1.9 | `setStatus` 按 `onDone` 处置提醒（默认完成后自动取消），恢复为未完成时自动重开"因完成而取消、且时间未到"的提醒 | `model.js` |
| 1.10 | 新增通知设置模型：`DEFAULT_NOTIFICATIONS` / `sanitizeNotifications` / `inQuietHours`（支持跨零点）/ `quietHoursText` | `model.js` |

### 2. 后端提醒调度（`src/main.js`）

| # | 变更 | 文件 |
| --- | --- | --- |
| 2.1 | 新增调度器：`syncReminders` / `reminderState` / `clearReminders` / `testNotification` 四个 API，页面仍是数据拥有者（每次变更整体同步） | `main.js` |
| 2.2 | 15 秒 tick 的定时器 `check()` + `processEntry()`：到点的提醒一律当场送出，睡眠唤醒 / 时钟跳变后靠"到点就补"兜底 | `main.js` |
| 2.3 | 通知投递 `deliver()`：`app.notify({ title, body, subtitle, id, sound })` —— 标题＝待办标题、副标题＝分类 · 提醒时间、正文＝提前量 / 补发说明；同时 `app.push('reminder-due')` 让页面即时更新 | `main.js` |
| 2.4 | 送达台账按**轮次**记账（`firedAt`）并落盘 `reminders.json`：页面刷新、窗口关掉、应用重启后不会重复弹同一条 | `main.js` |
| 2.5 | 重复提醒由后端推进周期（每天 / 每周 / 工作日，跳过已过去的多轮，只补发一条并标注"错过 N 次"） | `main.js` |
| 2.6 | 结束条件：次数 / 截止日期用尽后整条提醒结束（`cancelReason: series-end`），并把结果回写页面 | `main.js` |
| 2.7 | 通知总开关与免打扰时段在投递侧生效：被挡下时不弹横幅，但仍推送应用内事件（`skipped: disabled / quiet-hours`） | `main.js` |
| 2.8 | 通知点击回流：`export function onNotificationClick(id)` → `app.push('reminder-open')`，页面据此聚焦窗口并高亮 | `main.js` |
| 2.9 | 启动钩子 `init(app)`：先读回台账 → 补发"关闭期间到点"的提醒 → 挂定时器 | `main.js` |

### 3. 桥接层（`src/frontend/js/app-ns.js`）

| # | 变更 | 文件 |
| --- | --- | --- |
| 3.1 | **修复** `bridge.notify`：原来调用不存在的 `tiny.app.notify(...)`（页面 API 是顶层 `tiny.notify(title, body, opts)`），错误被 catch 吞掉 → 系统通知从未发出；现在按正确签名调用 | `app-ns.js` |
| 3.2 | 新增权限：`notifyPermission` / `requestNotifyPermission`（`tiny.app.permissions`）+ `openNotificationSettings`（被拒后的引导） | `app-ns.js` |
| 3.3 | 新增事件：`onNotifyClick`（通知点击）/ `onReminderDue`（后端到点推送） | `app-ns.js` |
| 3.4 | 新增日程：`syncReminders` / `reminderState` / `clearReminders` / `testNotify` | `app-ns.js` |
| 3.5 | 新增环境：`capabilities`（判 `caps.notifications !== false`）/ `focusWindow` / `windowFocused` / `loginItem` / `setLoginItem` | `app-ns.js` |
| 3.6 | 版本号常量 0.1.0 → 0.3.0（导出备份里会用到） | `app-ns.js` |

### 4. 视图层（`src/frontend/js/ui.js` + `style.css`）

| # | 变更 | 文件 |
| --- | --- | --- |
| 4.1 | 新建 / 编辑表单新增「提醒」字段组：开关 + `datetime-local` + 提前量 + 重复 + 结束条件（次数 / 日期）+ 完成后处置 + 实时确认文案 | `ui.js` |
| 4.2 | 列表条目新增提醒芯片 `⏰ …`，四态四色：已设置（蓝）/ 即将到期（琥珀）/ 已过期（红）/ 已取消（灰、删除线），重复提醒带 `↻` | `ui.js` `style.css` |
| 4.3 | 展开条目与查看面板新增提醒块：时间 + 提前量 + 重复 + 状态 + 上次提醒（累计次数） | `ui.js` |
| 4.4 | 左栏头部新增「有 N 条提醒到点」横幅，可一键跳到最近一条或收起 | `ui.js` `style.css` |
| 4.5 | 到点条目呼吸式高亮 6 秒（`is-reminding`），点击通知 / 横幅后自动褪去 | `ui.js` `style.css` |
| 4.6 | 新增「通知」面板（第六个页签，`⌘,` 或菜单栏进入）：权限状态卡（已授权 / 已被拒绝 / 尚未授权 / 当前环境不支持，各自给出下一步）+ 总开关 + 提示音 + 免打扰时段 + 错过补发 + 登录时自动启动 + 测试通知 + 提醒概览 + 机制与边界说明 | `ui.js` `style.css` |
| 4.7 | 新增开关 / 权限卡 / 设置分组 / 提醒芯片等组件样式，全部走既有主题令牌（深浅两套自动跟随） | `style.css` |

### 5. 控制器（`src/frontend/js/app.js`）

| # | 变更 | 文件 |
| --- | --- | --- |
| 5.1 | 提醒日程同步：`reminderEntry` / `syncReminders`（防抖 120ms）/ `applySchedule`（把后端推进过的提醒时间与台账写回条目） | `app.js` |
| 5.2 | 到点事件 `handleReminderDue`：写台账 → 应用内提示 → 高亮；通知点击 `openReminder`：聚焦窗口 → 选中 → 高亮 → 滚动到可见 | `app.js` |
| 5.3 | 提醒动作：`cancelReminder`（保留设置、标记用户取消）、`snoozeReminder`（稍后 10 分钟，提前量归零） | `app.js` |
| 5.4 | 通知设置动作：`toggleNotifySwitch`（总开关 / 提示音 / 免打扰 / 补发）、`setDndTime`、`toggleAutoStart`、`requestPermission`、`refreshPermission`、`sendTestNotification`，设置持久化到 `todo.settings.v1` | `app.js` |
| 5.5 | 表单接线：草稿里存提醒输入态，`onInput` 只更新草稿与确认文案（不重绘，datetime 选择器不被打断），`onChange` 才重绘结构 | `app.js` |
| 5.6 | 表单校验合并提醒错误（`reminderAt` / `reminderEnd`），保存提示里带上提醒状态（含"提醒已取消"） | `app.js` |
| 5.7 | 完成 / 恢复时提示提醒的处置结果；删除条目时同步撤掉它的日程 | `app.js` |
| 5.8 | 页面侧定时器：每 20 秒重算提醒状态（跨过阈值才重绘）；浏览器预览模式下自己补发到点提醒（应用内提示 + 浏览器 Notification） | `app.js` |
| 5.9 | 菜单栏新增「通知设置…」（`⌘,`），页面内快捷键同步支持 | `app.js` |
| 5.10 | **首次用上提醒时请求权限**：保存第一条带提醒的待办时，若权限仍是"未决定"，先弹应用内说明再请求系统授权（仅在打包后的 `.app` 里；`tiny.app.info().tinyjs === 'dev'` 视为 dev 不请求） | `app.js` `app-ns.js` |

### 6. 持久化（`src/frontend/js/store.js`）

| # | 变更 | 文件 |
| --- | --- | --- |
| 6.1 | 新增键 `todo.settings.v1`（通知设置），`loadSettings` / `saveSettings`，并纳入 `clearAll()` | `store.js` |
| 6.2 | 后端台账 `reminders.json` 写在应用数据目录（与 `store.json` 同目录），与应用数据一起备份 / 删除 | `main.js` |

### 7. 测试

| # | 变更 | 文件 |
| --- | --- | --- |
| 7.1 | 模型层单测 28 → **48 项**：提醒归一化 / 状态推导 / 重复推进 / 输入校验 / 文案 / 统计队列 / 完成处置 / 通知设置 | `tools/model.test.js` |
| 7.2 | 新增后端调度单测 **18 项**（Node + `tjs` 桩）：到点投递 / 台账落盘 / 重复滚动 / 次数与日期结束 / 工作日跳过周末 / 长时间关闭只补一条 / 页面刷新不重复弹 / 总开关与免打扰 / 名单撤销 / 测试通知 / 点击回流 | `tools/reminder.test.js` |
| 7.3 | 端到端自检新增提醒与通知用例：表单 → 芯片 → 详情块 → 校验拦截 → 到点推送 → 高亮 → 完成处置 → 取消 / 稍后 → 通知设置交互 → 重载后台账与设置仍在 → 后端日程对齐 | `tools/selftest.js` |

### 8. 文档与版本

| # | 变更 | 文件 |
| --- | --- | --- |
| 8.1 | README 新增「提醒与通知」一节：字段语义、触发链路、权限与引导、总开关 / 免打扰 / 提示音、**机制与限制**（应用退出期间无法提醒、dev 下回落到「脚本编辑器」、打包才有原生横幅、专注模式、Linux 无回复框…） | `README.md` |
| 8.2 | README 功能特性 / 鼠标表 / 快捷键表 / 数据存储表 / 测试说明 / 目录结构同步更新 | `README.md` |
| 8.3 | 版本号 0.2.3 → 0.3.0（`tinyjs.json`、README 示例、前端版本常量） | `tinyjs.json` `README.md` `app-ns.js` |

## 0.2.3 —— README 精简

按发布口径收敛文档：去掉「贡献指南」「联系方式」两节，许可证一节只保留授权与免责说明。无功能改动。

| # | 变更 | 文件 |
| --- | --- | --- |
| 1.1 | 移除「贡献指南」一节（测试门槛 / 提交信息规范 / 代码约定）与目录中对应条目 | `README.md` |
| 1.2 | 移除「联系方式」一节（仓库地址 / Issues / 作者）与目录中对应条目 | `README.md` |
| 1.3 | 「许可证」一节收敛为三行：开源声明 + 授权范围 + 免责声明；删去框架署名、跟踪范围与"如何换许可证"的补充说明 | `README.md` |
| 1.4 | 版本号 0.2.2 → 0.2.3，README「配置项」里的示例版本号同步 | `tinyjs.json` `README.md` |

## 0.2.2 —— 开源准备（仓库、许可与文档）

把工程收拾成可以直接公开在 GitHub 上的样子：**没有功能改动**，只有仓库初始化、忽略规则、许可证与文档。

### 1. 仓库与忽略规则

| # | 变更 | 文件 |
| --- | --- | --- |
| 1.1 | 初始化 Git 仓库，主分支定为 `main`；首次提交收录应用源码、测试脚本、类型提示与文档 | `.git/` |
| 1.2 | 新增忽略规则：构建产物（`dist/`、`.build/`、`tools/build/`）、依赖（`node_modules/`）、缓存、日志、本地环境与密钥（`.env*` / `*.pem` / `*.key` / `*.p12` / `secrets/`）、macOS 与编辑器杂物 | `.gitignore` |
| 1.3 | tinyjs 脚手架附带的 agent skill 文档（`.claude/`、`.agents/`，两份内容完全重复）默认不跟踪，需要时删掉两行即可 | `.gitignore` |
| 1.4 | 不跟踪派生自检页 `tools/build/selftest.html`（由 `tools/build-selftest.js` 现场生成，手工编辑无效） | `.gitignore` |

### 2. 许可证

| # | 变更 | 文件 |
| --- | --- | --- |
| 2.1 | 采用 MIT 许可证（© 2026 Ryanhel） | `LICENSE` |
| 2.2 | README 增加「许可证」一节：授权范围，以及本仓库与框架（tinyjs，同为 MIT）的边界 —— 运行时与 CLI 随安装脚本分发，不随仓库 | `README.md` |

### 3. 文档与素材

| # | 变更 | 文件 |
| --- | --- | --- |
| 3.1 | README 重写为可直接展示给外人的结构：一句话简介 + 目录 + 深浅两套界面截图 + 布局说明 | `README.md` |
| 3.2 | 新增「技术栈」：窗口（系统 WebView）/ 运行时（txiki.js）/ 桥（`tiny.*`，socket 无端口）/ 前端（零依赖经典脚本）/ 样式（令牌分层）/ 打包 / 测试 | `README.md` |
| 3.3 | 新增「运行环境要求」：macOS 15+、tinyjs ≥ 0.47.1（`minTinyjsVersion` 强制）、无需 Node、无 npm 依赖 | `README.md` |
| 3.4 | 新增「安装与启动」：CLI 安装命令、`git clone` + `tinyjs dev`、首次启动的种子数据、浏览器里直接调样式、`TINYJS_HTML` 独立运行 | `README.md` |
| 3.5 | 新增「构建与分发」：`build` / `--arch` / `--universal` / `--dmg` / `publish` / `notarize` 用法，以及三条容易踩的坑（宿主 CPU、发布前改 `id`、ad-hoc 签名不能分发、不能跨系统打包） | `README.md` |
| 3.6 | 新增「使用说明与关键交互」：鼠标操作表、快捷键表、反馈与容错（状态栏 / 标题计数 / 草稿保护 / 空态只给引导） | `README.md` |
| 3.7 | 新增「配置项」：`tinyjs.json` 字段逐条说明、外观三态与令牌分层、数据存储位置 / 重置 / 备份 / 容错、环境变量表 | `README.md` |
| 3.8 | 新增「贡献指南」（测试门槛、提交信息规范、五条代码约定）与「联系方式」 | `README.md` |
| 3.9 | 截图落库：`docs/screenshots/dark.jpg`、`light.jpg` 取自自检页真实运行结果，README 写明重新生成的命令 | `docs/screenshots/` |
| 3.10 | 版本号 0.2.1 → 0.2.2 | `tinyjs.json` |

## 0.2.1 —— 外观模式收敛成顶栏单按钮

需求：顶栏只保留**一颗**外观按钮（不再三档并列）；默认跟随系统，未点击前始终按系统设置自动适配；
点一下即在浅色 / 深色之间来回切换并退出跟随系统；图标随当前模式变化且点击后立即更新；
手动选择持久化，刷新与重开仍保持。

### 1. 单按钮切换

| # | 变更 | 文件 |
| --- | --- | --- |
| 1.1 | 顶栏三档分段控件（`role="radiogroup"` + 三颗 `data-act="set-theme"` 按钮）**替换为单按钮** `#theme-toggle`（`data-act="toggle-theme"`） | `ui.js` |
| 1.2 | 图标与文案统一为"**点击后得到的模式**"：深色时显示 `☀ 浅色`、浅色时显示 `☾ 深色`；点击后立即翻转（同一颗按钮重画） | `ui.js` |
| 1.3 | 按钮 `title` / `aria-label` 分"自动 / 手动"两种措辞，写明当前状态与"点下去会得到什么" | `ui.js` |
| 1.4 | 新增 `toggleTheme()`：切到"当前所见外观"的反面；跟随系统时先解析系统结果、再取其反面，同时退出跟随 | `app.js` |
| 1.5 | `setThemeMode(mode, viaToggle)` 增加来源标记：来自单按钮且原先是自动模式时，提示补一句「已退出跟随系统」 | `app.js` |
| 1.6 | 跟随系统时按钮补一枚「自动」状态牌 + 虚线边（**状态提示，不是第二个入口**）；手动选择后自动消失 | `ui.js` `style.css` |
| 1.7 | 样式：`.theme-switch / .theme-btn`（分段控件）→ `.theme-slot / .theme-toggle / .theme-auto`；配色仍全走令牌，两种外观下表现一致 | `style.css` |
| 1.8 | 原生菜单：外观三项（跟随系统 / 浅色 / 深色带勾选）收敛为「切换外观」（⌘T，标题实时显示 `→ 浅色 / → 深色`）+「外观：跟随系统」（勾选态 = 正在自动，**回到自动的唯一入口**） | `app.js` |
| 1.9 | `themeMode` 持久化语义不变（`todo.ui.v1`）：手动选择后刷新 / 重开沿用；未点击过则为 `system`，继续跟随 | — |

### 2. 测试与文档

| # | 变更 | 文件 |
| --- | --- | --- |
| 2.1 | 自检的外观段落重写为单按钮语义：唯一按钮 / 无并列选项 / 图标=目标模式（深浅两向）/ 点击退出跟随 / 两档来回切 / 自动态小牌 / 系统翻转时图标同步 / 手动选择后忽略系统变化 | `tools/selftest.js` |
| 2.2 | phase2 的深浅快照改用"最多点两次对齐到目标档"的写法，不再引用已删除的旧控件 | `tools/selftest.js` |
| 2.3 | 断言数 114 → **132**（phase1 118 + phase2 14），全绿、0 页面异常 | `tools/selftest.js` |
| 2.4 | README：外观特性说明、职责划分表新增「切换外观」行（含"回到自动走菜单栏"的边界）、⌘T 快捷键、测试计数同步 | `README.md` |

## 0.2.0 —— 职责划分 / 待办分类 / 外观模式

### 1. 顶栏与操作面板的职责划分（去重）

| # | 变更 | 文件 |
| --- | --- | --- |
| 1.1 | **删除**顶栏重复的「列表」折叠按钮（`#btn-toggle-list`）；折叠列表只剩左栏头部一个视觉控件，⌘L 与菜单项是它的非视觉入口 | `ui.js` `app.js` |
| 1.2 | 整表折叠的状态真相唯一化：原先"两处按钮 + 面板类名"三处同步，改为只读 `state.ui.listCollapsed` 一个字段驱动左栏头部控件与面板状态类 | `ui.js` `app.js` |
| 1.3 | **删除**空态里的「创建第一条 / 新建待办」按钮与未选中占位面板里的「新建待办」按钮，改为引导文案（指向顶栏唯一入口 + 快捷键） | `ui.js` |
| 1.4 | 面板模式条不再提供「新建」点击入口：新建态只显示一块不可点击的状态牌（`<span class="tab is-indicator">`），入口统一为顶栏按钮 / ⌘N / 菜单 | `ui.js` |
| 1.5 | 「编辑 / 删除」保留在查看面板（依赖选中项，属详情面板作用域），页签、⌘E / ⌘D、菜单为同源等价通道 | `ui.js` `app.js` |
| 1.6 | 提示条（toast）下移到顶栏下方，不再遮挡外观切换与新建按钮 | `style.css` |

### 2. 待办分类

| # | 变更 | 文件 |
| --- | --- | --- |
| 2.1 | 新增分类模型：`defaultCategories / makeCategory / validateCategoryName / sanitizeCategories / categoryById / resolveCategoryId / assignCategories / groupByCategory / countBy`，以及颜色槽位 `CATEGORY_COLORS`（`c1`…`c8`）与 `nextCategoryColor` | `model.js` |
| 2.2 | 待办数据新增 `categoryId` 字段；`create` / `patch` / `validate` 支持并强制校验分类（未选 → `请选择分类`，失效 → `所选分类已不存在，请重新选择`） | `model.js` |
| 2.3 | 存储新增独立键 `todo.categories.v1`（首次运行写入「工作 / 生活 / 周末 / 默认」四个种子分类）；`clearAll` 一并清理 | `store.js` |
| 2.4 | 新增「分类」面板模式：列表 + 内联改名 + 点色块换色 + 删除（二次确认、默认分类禁删、删除时显示"N 条转默认"）+ 新增表单 + 重名/空名错误提示 | `ui.js` `app.js` |
| 2.5 | 左栏改为**按分类分组**：分组头 = 折叠开关（色点 + 名称 + 未完成/总数 + chevron）+ 「◎ 只看该分类」；空分类也保留为分组 | `ui.js` `style.css` |
| 2.6 | 新增分类维度的折叠 `state.ui.collapsedCategories`（与整表折叠相互独立），并随 UI 状态持久化、自动清理已删分类 | `app.js` |
| 2.7 | 新增「只看某分类」聚焦筛选：左栏头部出现可关闭的聚焦胶囊；与状态筛选（全部/未完成/已完成）正交，两个维度互不干扰 | `ui.js` `app.js` |
| 2.8 | 表单加入分类选择器（色点胶囊）；新建时预选「上次用过的分类」（`lastCategoryId`），编辑时预选条目所属分类 | `ui.js` `app.js` |
| 2.9 | 查看面板显示分类胶囊 + 「分类」信息行；创建/保存提示带出分类名，如 `已创建：写周报（工作）` | `ui.js` `app.js` |
| 2.10 | 删除分类时其条目自动转入「默认」并落盘；聚焦 / 上次分类 / 折叠状态同步收敛 | `app.js` |

### 3. 外观模式

| # | 变更 | 文件 |
| --- | --- | --- |
| 3.1 | 顶栏新增外观三档切换（浅色 / 深色 / 跟随系统），`aria-checked` 与激活态同步；跟随系统时提示当前解析结果 | `ui.js` `style.css` `app.js` |
| 3.2 | 主题解析落地为 `<html data-theme="light|dark">` + `data-theme-mode`；`themeMode` 随 `todo.ui.v1` 持久化，重载后沿用 | `app.js` `store.js` |
| 3.3 | 系统主题**实时响应**：`bridge.onSystemTheme()` 同时挂 `tiny.theme.on`（launcher 推送，首选）与 `prefers-color-scheme` 媒体查询（兜底）；仅"跟随系统"模式改外观，显式选择时忽略系统变化 | `app-ns.js` `app.js` |
| 3.4 | 样式层重构为令牌制：结构令牌（共用）+ 深色板 + 浅色板 + 分类色槽；**把原有组件规则里所有硬编码色值（约 50 处 rgba/hex）替换为令牌**，因此换肤不需要改任何组件样式 | `style.css` |
| 3.5 | 浅色板完成全组件适配（面板、列表、表单、按钮、输入、提示、滚动条、进度条、徽标、折叠提示条），科技蓝主色在浅色下改用更深的 `#2563eb / #1d4ed8` 并以白字落在实心按钮上保证对比度 | `style.css` |
| 3.6 | 浅色令牌写两份：`:root[data-theme="light"]`（显式选择）与 `@media (prefers-color-scheme: light) :root:not([data-theme])`（JS 未跑时的首帧兜底，避免白闪）；第二份由新增工具 `tools/sync-light-theme.js` 从第一份机械复制（幂等），改配色只需改一份 | `style.css` `tools/sync-light-theme.js` |
| 3.7 | `color-scheme` 随主题切换，使原生控件（滚动条、选择框）跟随；打印/PDF 视觉自检保留配色 | `style.css` |
| 3.8 | 原生菜单新增外观三项，并用 `tiny.menu.update` 实时打勾当前模式 | `app-ns.js` `app.js` |

### 4. 顺带修复的真实缺陷（均由自检/单测发现）

| # | 缺陷 | 文件 |
| --- | --- | --- |
| 4.1 | 聚焦某分类时忘了调用 `renderFocusChip()`，聚焦胶囊不显示、关闭按钮点了报错 | `ui.js` |
| 4.2 | 聚焦某分类时没有过滤分组，其余分类仍全部渲染 | `ui.js` |
| 4.3 | 自检自身：上一次中断留下的数据会让后续计数断言集体漂移；现在 phase1 带清场守卫（最多重试 2 次后报错终止，避免无限重载） | `selftest.js` |
| 4.4 | 提示条遮挡顶栏控件（见 1.6） | `style.css` |

### 5. 测试与文档

| # | 变更 | 文件 |
| --- | --- | --- |
| 5.1 | 单元测试补充分类用例（种子分类 / 名称校验 / 归一化 / 颜色槽位 / 兜底解析 / 归组 / 必选分类）：19 → **28 项** | `tools/model.test.js` |
| 5.2 | 端到端自检扩展到 **114 项断言**（phase1 102 + phase2 12），新增入口唯一性、分类 CRUD、分组折叠、聚焦筛选、外观三模式、系统主题实时推送（`__emit` 真实通道）、主题/分类的跨重载持久化；收尾导出深浅两套 PDF 快照（`/tmp/todo-ui-dark.pdf`、`/tmp/todo-ui-light.pdf`） | `selftest.js` |
| 5.3 | README 新增「入口与职责划分（去重方案）」与「数据与存储」两节，更新功能清单、目录结构、测试说明 | `README.md` |
| 5.4 | 应用版本号 0.1.0 → 0.2.0 | `tinyjs.json` |
| 5.5 | **测试产物移出发布包**：`tinyjs build` 会把 `src/frontend/` 整个复制进 `dist`，而 tinyjs 清单没有排除机制，所以把自检驱动 `selftest.js` 移到 `tools/`、自检页产物改为 `tools/build/selftest.html`（`build-selftest.js` 相应改为从 index.html 同一批源码 + `tools/selftest.js` 内联），发布目录不再混入测试代码 | `tools/` `README.md` |

> 验证结果：`node tools/model.test.js` **28/28 通过**；
> 端到端自检 **114/114 通过，0 页面异常**（含两套主题 UI 快照人工复核）。

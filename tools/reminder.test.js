/* =============================================================================
 * 后端提醒调度单元测试（Node，零依赖）
 *   node tools/reminder.test.js
 *
 * 测的是 src/main.js 里"页面做不到"的那部分：定时排期、重复推进、结束条件、
 * 迟到补发、送达台账、总开关与免打扰对系统通知的拦截。
 * 它跑在 txiki.js 上，所以这里给 tjs 打一层最小桩（只有文件 API 与几个只读字段）；
 * app 句柄同样是桩：notify() 记下发出去的横幅，push() 记下推给页面的事件。
 *
 * 时间不注入：用例全部使用"相对现在的时间戳"，断言的是行为而不是绝对值。
 * ========================================================================== */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = path.join(__dirname, '..', 'src', 'main.js');
/** 本仓库没有 package.json，Node 会把 .js 当 CommonJS；复制成 .mjs 才能 import */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-reminder-'));
const MODULE = path.join(WORK, 'main.mjs');
fs.copyFileSync(SRC, MODULE);

const DATA = path.join(WORK, 'data');
const files = new Map();

/* ------------------------------------------------------------------ 桩 */

globalThis.tjs = {
  homeDir: WORK,
  version: '0.0.0-test',
  hostName: 'test-host',
  pid: 1,
  system: { cpus: [{ model: 'test-cpu' }], userInfo: { userName: 'tester' } },
  makeDir: async function () {},
  writeFile: async function (p, text) { files.set(p, String(text)); },
  readFile: async function (p) {
    if (!files.has(p)) throw new Error('ENOENT: ' + p);
    return files.get(p);
  },
};

const sent = [];      // 系统通知（横幅）
const pushed = [];    // 推给页面的事件
const app = {
  paths: { data: DATA },
  notify: async function (opts) { sent.push(opts); return true; },
  push: function (event, data) { pushed.push({ event: event, data: data }); },
};

/* ------------------------------------------------------------ 测试框架 */

let passed = 0;
let failed = 0;

async function test(name, fn) {
  sent.length = 0;
  pushed.length = 0;
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + (error && error.message));
  }
}

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** 默认一小时后的提醒 */
function soon(offsetMs) {
  return Date.now() + (offsetMs == null ? 60 * MIN : offsetMs);
}

/** 每条用例默认用新的待办 id（否则"同一个 id"会走"改日程"的合并分支） */
let idSeq = 0;

function entry(fields) {
  idSeq++;
  return Object.assign({
    id: 't' + idSeq, title: '写周报', category: '工作',
    at: soon(), advance: 0, repeat: 'none', endType: 'never', endCount: null, endDate: null,
    onDone: 'cancel', enabled: true, firedCount: 0, lastFiredAt: null,
  }, fields || {});
}

function dueEvents() {
  return pushed.filter(function (item) { return item.event === 'reminder-due'; })
    .map(function (item) { return item.data; });
}

(async function run() {
  const main = await import(pathToFileURL(MODULE).href);
  const api = main.api;
  await main.init(app);

  console.log('main.js 提醒调度单元测试\n');

  /* --------------------------------------------------------------- 基本 */

  await test('未来的提醒只排期，不弹也不推', async () => {
    const result = await api.syncReminders({ list: [entry({ at: soon(2 * 60 * MIN) })] }, app);
    assert.equal(sent.length, 0);
    assert.equal(dueEvents().length, 0);
    assert.equal(result.entries.length, 1);
    assert.ok(result.entries[0].nextAt != null, '应排到下一次检查时触发');
  });

  await test('到点的一次性提醒：弹通知 + 推事件 + 记台账', async () => {
    const item = entry({ at: Date.now() - 5 * MIN });
    const result = await api.syncReminders({ list: [item] }, app);

    assert.equal(sent.length, 1, '应弹一条系统通知');
    assert.equal(sent[0].title, '写周报');
    assert.match(sent[0].subtitle, /工作 · /);
    assert.equal(sent[0].id, item.id);
    assert.equal(sent[0].sound, true);

    const events = dueEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].late, true, '落后于计划时刻 → 标记为补发');
    assert.equal(events[0].id, item.id);
    assert.equal(events[0].at, item.at, '事件里的 at = 刚触发的那个时刻（横幅副标题用）');
    // 回归：推送必须带"投递之后"的台账，否则页面会一直显示"尚未触发过"
    assert.equal(events[0].reminder.firedCount, 1, '推送里的 firedCount 应当是 1');
    assert.ok(events[0].reminder.lastFiredAt >= item.at, '推送里的 lastFiredAt 应当已写入');
    assert.equal(events[0].reminder.at, item.at, '一次性提醒触发后时间不变（停在"已过期"）');

    const saved = result.entries[0];
    assert.equal(saved.nextAt, null, '一次性提醒触发后不再排期');
    assert.equal(saved.reminder.enabled, true, '保留"已过期"状态等用户处理');
    assert.equal(saved.reminder.firedCount, 1);
    assert.ok(saved.reminder.lastFiredAt >= item.at);
  });

  await test('台账落盘：reminders.json 里有条目与送达时间', async () => {
    const text = files.get(path.join(DATA, 'reminders.json'));
    assert.ok(text, '应写出 reminders.json');
    const data = JSON.parse(text);
    assert.equal(data.version, 1);
    assert.ok(data.entries[0].lastFiredAt > 0);
  });

  await test('重复提醒：触发后自动推进到下一个周期', async () => {
    const at = Date.now() - MIN;
    const id = 'rep-daily';
    const result = await api.syncReminders({ list: [entry({ id: id, at: at, repeat: 'daily' })] }, app);

    assert.equal(sent.length, 1);
    const firstRun = sent.length;
    const saved = result.entries[0].reminder;
    assert.equal(saved.firedCount, 1);
    assert.equal(saved.enabled, true);
    assert.ok(saved.at > Date.now(), '推进后的时间必须还在未来');

    // 推送里也要是"推进之后"的日程：重复提醒的下一轮时间必须已经在事件里
    const fired = dueEvents();
    assert.equal(fired.length, 1);
    assert.ok(fired[0].at < Date.now(), '事件里的 at 是刚触发的那一轮（过去）');
    assert.equal(fired[0].reminder.at, saved.at, '推送里的下一轮时间应当已推进');
    assert.equal(fired[0].reminder.firedCount, 1);
    assert.ok(fired[0].reminder.lastFiredAt > 0);

    // 同一条待办：页面把推进后的时间同步回来（真实流程就是这样的）
    const again = await api.syncReminders({
      list: [entry({
        id: id, at: saved.at, repeat: 'daily',
        lastFiredAt: saved.lastFiredAt, firedCount: saved.firedCount,
      })],
    }, app);
    assert.equal(sent.length, firstRun, '推进后的那一轮不该重复弹');
    assert.ok(again.entries[0].nextAt > Date.now());
    assert.equal(again.entries[0].reminder.firedCount, 1, '不该重复计数');
  });

  await test('页面先送过一次的提醒，后端同步时不重复弹（模拟窗口关着时后端送过）', async () => {
    const at = Date.now() - MIN;
    const id = 'rep-race';
    await api.syncReminders({ list: [entry({ id: id, at: at, repeat: 'daily' })] }, app);
    assert.equal(sent.length, 1);
    sent.length = 0;

    // 页面这次带的是"旧数据"（还没应用推送）：at 还是刚才那一轮
    const stale = await api.syncReminders({ list: [entry({ id: id, at: at, repeat: 'daily' })] }, app);
    assert.equal(sent.length, 0, '后端记得这一轮送过 → 不能再弹一次');
    assert.ok(stale.entries[0].nextAt > Date.now());
  });

  await test('重复按次数结束：最后一次触发后整条结束', async () => {
    const result = await api.syncReminders({
      list: [entry({ at: Date.now() - MIN, repeat: 'daily', endType: 'count', endCount: 2, firedCount: 1 })],
    }, app);

    assert.equal(sent.length, 1);
    const saved = result.entries[0];
    assert.equal(saved.reminder.firedCount, 2);
    assert.equal(saved.reminder.enabled, false);
    assert.equal(saved.reminder.cancelReason, 'series-end');
    assert.equal(saved.nextAt, null);
    // 推送里也要能看出"整条已结束"，否则页面会一直显示"即将到期"
    assert.equal(dueEvents()[0].reminder.enabled, false);
    assert.equal(dueEvents()[0].reminder.cancelReason, 'series-end');
  });

  await test('重复按日期结束：下一轮超出截止日期就停', async () => {
    const result = await api.syncReminders({
      list: [entry({ at: Date.now() - MIN, repeat: 'daily', endType: 'date', endDate: Date.now() + MIN })],
    }, app);

    assert.equal(sent.length, 1);
    assert.equal(result.entries[0].reminder.enabled, false);
    assert.equal(result.entries[0].reminder.cancelReason, 'series-end');
  });

  await test('工作日规则会跳过周末', async () => {
    const friday = new Date(2026, 9, 9, 9, 0, 0, 0);          // 2026-10-09 是周五
    const result = await api.syncReminders({
      list: [entry({ at: friday.getTime(), repeat: 'weekdays', lastFiredAt: friday.getTime() - MIN })],
    }, app);
    const next = new Date(result.entries[0].reminder.at);
    assert.equal(next.getDay() === 0 || next.getDay() === 6, false, '下一轮不能落到周末');
  });

  await test('长时间关闭：只补发一条，并带上"错过 N 次"', async () => {
    const result = await api.syncReminders({
      list: [entry({ at: Date.now() - 5 * DAY, repeat: 'daily' })],
    }, app);

    assert.equal(sent.length, 1, '积压多轮也只补发一条');
    const events = dueEvents();
    assert.equal(events[0].late, true);
    assert.ok(events[0].missed >= 4, '应说明期间错过了几次，实际=' + events[0].missed);
    assert.ok(result.entries[0].reminder.at > Date.now(), '当轮结束后应回到未来');
  });

  await test('页面已记过台账的那一轮不重复弹（刷新页面安全）', async () => {
    const result = await api.syncReminders({
      list: [entry({ at: Date.now() - MIN, repeat: 'daily', lastFiredAt: Date.now(), firedCount: 3 })],
    }, app);
    assert.equal(sent.length, 0, 'lastFiredAt 已经盖过这一轮的触发时刻');
    assert.ok(result.entries[0].nextAt > Date.now());
  });

  /* ------------------------------------------------------- 开关与免打扰 */

  await test('系统通知总开关关闭：不弹横幅，但仍推事件（应用内照旧）', async () => {
    await api.syncReminders({
      list: [entry({ at: Date.now() - MIN })],
      options: { enabled: false },
    }, app);

    assert.equal(sent.length, 0);
    const events = dueEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].skipped, 'disabled');
    assert.equal(events[0].silent, true);
  });

  await test('免打扰时段内：横幅被拦下，事件照推', async () => {
    await api.syncReminders({
      list: [entry({ at: Date.now() - MIN })],
      options: { enabled: true, dndEnabled: true, dndFrom: '00:00', dndTo: '23:59' },
    }, app);

    assert.equal(sent.length, 0);
    assert.equal(dueEvents()[0].skipped, 'quiet-hours');
  });

  await test('免打扰关闭后：横幅照常发出', async () => {
    await api.syncReminders({
      list: [entry({ at: Date.now() - MIN })],
      options: { enabled: true, dndEnabled: false, dndFrom: '00:00', dndTo: '23:59' },
    }, app);
    assert.equal(sent.length, 1);
  });

  await test('提示音开关会带进通知参数', async () => {
    await api.syncReminders({
      list: [entry({ at: Date.now() - MIN })],
      options: { enabled: true, sound: false, dndEnabled: false },
    }, app);
    assert.equal(sent[0].sound, false);
  });

  /* --------------------------------------------------------- 名单与收尾 */

  await test('同步的名单是权威：不在名单里的提醒会被撤掉', async () => {
    const empty = await api.syncReminders({ list: [], options: { enabled: true } }, app);
    assert.equal(empty.entries.length, 0);
    assert.equal(sent.length, 0);

    const state = await api.reminderState({}, app);
    assert.equal(state.entries.length, 0);
  });

  await test('测试通知走 app.notify，且不受免打扰影响', async () => {
    const result = await api.testNotification({ title: '测试', body: '正文' }, app);
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, '测试');
  });

  await test('点击通知 → 推 reminder-open（页面据此聚焦并高亮）', async () => {
    main.onNotificationClick('t1', app);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].event, 'reminder-open');
    assert.equal(pushed[0].data.id, 't1');
  });

  await test('clearReminders 清空日程', async () => {
    await api.syncReminders({ list: [entry({ at: soon() })] }, app);
    const cleared = await api.clearReminders({}, app);
    assert.equal(cleared.ok, true);
    const state = await api.reminderState({}, app);
    assert.equal(state.entries.length, 0);
  });

  /* ------------------------------------------------------------------ 结果 */

  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_e) { /* 忽略清理失败 */ }
  process.exit(failed === 0 ? 0 : 1);
})().catch(function (error) {
  console.log('测试运行失败：' + (error && error.stack ? error.stack : error));
  process.exit(1);
});

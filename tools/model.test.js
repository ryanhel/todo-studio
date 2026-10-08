/* =============================================================================
 * 模型层单元测试（Node，零依赖）
 *   node tools/model.test.js
 *
 * 只测纯逻辑：校验规则 / 创建 / 修改 / 状态流转 / 排序分组 / 统计 /
 * 防御性归一化 / 时间格式化。DOM 与 tiny.* 不由这一层负责 ——
 * 它们在真实 WebKit 里由 selftest.html 端到端验证。
 * ========================================================================== */
'use strict';

const assert = require('node:assert/strict');
const model = require('../src/frontend/js/model.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + (error && error.message));
  }
}

console.log('model.js 单元测试\n');

/* ------------------------------------------------------------------ 校验 */

test('空标题被拒绝，并给出可读错误', () => {
  const result = model.validate({ title: '   ' });
  assert.equal(result.ok, false);
  assert.match(result.errors.title, /不能为空/);
});

test('标题超长被拒绝（>120 字）', () => {
  const result = model.validate({ title: 'x'.repeat(model.LIMIT.title + 1) });
  assert.equal(result.ok, false);
  assert.match(result.errors.title, /最多 120 字/);
});

test('备注超长被拒绝（>500 字）', () => {
  const result = model.validate({ title: 'ok', note: 'n'.repeat(model.LIMIT.note + 1) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.note);
});

test('非法优先级回退为 normal，文本首尾空格被裁掉', () => {
  const result = model.validate({ title: '  写周报  ', priority: 'urgent' });
  assert.equal(result.ok, true);
  assert.equal(result.value.title, '写周报');
  assert.equal(result.value.priority, 'normal');
});

/* ------------------------------------------------------------ 创建与修改 */

test('create 产出一条未完成待办，时间戳一致', () => {
  const at = 1700000000000;
  const result = model.create({ title: '买咖啡', note: '浅烘', priority: 'high' }, at);
  assert.equal(result.ok, true);
  assert.equal(result.todo.status, 'open');
  assert.equal(result.todo.createdAt, at);
  assert.equal(result.todo.updatedAt, at);
  assert.equal(result.todo.doneAt, null);
  assert.ok(result.todo.id.length > 4);
});

test('create 在标题非法时不产出条目', () => {
  const result = model.create({ title: '' });
  assert.equal(result.ok, false);
  assert.equal(result.todo, undefined);
});

test('patch 只改文本字段，不碰状态与创建时间', () => {
  const base = model.create({ title: 'A', note: 'note', priority: 'low' }, 1000).todo;
  const done = model.setStatus(base, 'done', 2000);
  const patched = model.patch(done, { title: 'B', note: 'n2', priority: 'high' }, 3000);
  assert.equal(patched.ok, true);
  assert.equal(patched.todo.title, 'B');
  assert.equal(patched.todo.status, 'done');
  assert.equal(patched.todo.doneAt, 2000);
  assert.equal(patched.todo.createdAt, 1000);
  assert.equal(patched.todo.updatedAt, 3000);
});

test('patch 校验失败时返回错误且不产出条目', () => {
  const base = model.create({ title: 'A' }, 1000).todo;
  const patched = model.patch(base, { title: '  ' }, 2000);
  assert.equal(patched.ok, false);
  assert.ok(patched.errors.title);
});
/* -------------------------------------------------------------- 状态流转 */

test('setStatus 维护 doneAt 与 updatedAt', () => {
  const todo = model.create({ title: 'A' }, 1000).todo;
  const done = model.setStatus(todo, 'done', 5000);
  assert.equal(done.status, 'done');
  assert.equal(done.doneAt, 5000);
  assert.equal(done.updatedAt, 5000);

  const reopened = model.setStatus(done, 'open', 6000);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.doneAt, null);
});

test('setStatus 状态未变化时返回原对象（不产生多余更新）', () => {
  const todo = model.create({ title: 'A' }, 1000).todo;
  assert.equal(model.setStatus(todo, 'open', 9999), todo);
});

/* -------------------------------------------------------------- 列表操作 */

test('add 置顶，remove 只删目标，replace 就地替换', () => {
  const a = model.create({ title: 'A' }, 1000).todo;
  const b = model.create({ title: 'B' }, 2000).todo;
  let list = model.add(model.add([], a), b);
  assert.deepEqual(list.map((t) => t.title), ['B', 'A']);

  list = model.replace(list, Object.assign({}, a, { title: 'A2' }));
  assert.equal(model.byId(list, a.id).title, 'A2');

  list = model.remove(list, b.id);
  assert.deepEqual(list.map((t) => t.title), ['A2']);
  assert.equal(model.byId(list, 'nope'), null);
});

/* -------------------------------------------------------------- 排序分组 */

test('排序：未完成在前 → 高优先级在前 → 最近更新在前', () => {
  const at = 1000;
  const low = model.create({ title: 'low', priority: 'low' }, at).todo;
  const high = model.create({ title: 'high', priority: 'high' }, at).todo;
  const oldDone = model.setStatus(
    model.create({ title: 'done', priority: 'high' }, at).todo, 'done', at);
  const fresh = model.create({ title: 'fresh', priority: 'high' }, at + 60000).todo;

  const sorted = model.sort([low, oldDone, high, fresh]);
  assert.deepEqual(sorted.map((t) => t.title), ['fresh', 'high', 'low', 'done']);
});

test('分组与筛选', () => {
  const open = model.create({ title: 'open' }, 1000).todo;
  const done = model.setStatus(model.create({ title: 'done' }, 2000).todo, 'done', 3000);

  const groups = model.group([open, done]);
  assert.deepEqual(groups.open.map((t) => t.title), ['open']);
  assert.deepEqual(groups.done.map((t) => t.title), ['done']);

  assert.equal(model.filter([open, done], 'all').length, 2);
  assert.equal(model.filter([open, done], 'done').length, 1);
  assert.equal(model.filter([open, done], 'nonsense').length, 2); // 未知筛选按全部处理
});

test('统计含完成率', () => {
  const open = model.create({ title: 'a' }, 1000).todo;
  const done = model.setStatus(model.create({ title: 'b' }, 1000).todo, 'done', 1000);
  const stats = model.stats([open, done]);
  assert.deepEqual([stats.total, stats.open, stats.done], [2, 1, 1]);
  assert.equal(stats.ratio, 0.5);
  assert.deepEqual(model.stats([]), { total: 0, done: 0, open: 0, ratio: 0 });
});

test('摘要：压缩空白并截断', () => {
  assert.equal(model.excerpt('  a\n\n  b  ', 20), 'a b');
  assert.equal(model.excerpt('x'.repeat(80), 10), 'x'.repeat(9) + '…');
  assert.equal(model.excerpt('', 10), '');
});
/* ---------------------------------------------------------- 防御性归一化 */

test('sanitize 丢弃脏数据、修复重复 id 并补齐缺失字段', () => {
  const clean = model.sanitize([
    null, 'string', 42, {},
    { id: 'k1', title: '  正常  ' },
    { id: 'k1', title: '重复 id 的第二条' },
    { id: '', title: '没有 id' },
    { id: 'k2', title: 'x'.repeat(300), status: 'weird', priority: 'huge', createdAt: 'nope' },
  ]);

  // 4 条合法数据全部保留：重复 / 缺失 id 用新 id 修复，而不是丢数据
  assert.equal(clean.length, 4);
  assert.equal(new Set(clean.map((t) => t.id)).size, 4, 'id 必须两两不同');
  assert.equal(clean.find((t) => t.id === 'k1').title, '正常');
  assert.ok(clean.some((t) => t.title === '重复 id 的第二条'));

  const long = clean.find((t) => t.id === 'k2');
  assert.equal(long.title.length, model.LIMIT.title);
  assert.equal(long.status, 'open');        // 非法状态回退
  assert.equal(long.priority, 'normal');    // 非法优先级回退
  assert.ok(Number.isFinite(long.createdAt));
});

test('sanitize 对非数组输入返回空列表', () => {
  assert.deepEqual(model.sanitize(null), []);
  assert.deepEqual(model.sanitize({ items: [] }), []);
  assert.deepEqual(model.sanitize(undefined), []);
});

/* -------------------------------------------------------------- 时间显示 */

test('相对时间分档', () => {
  const now = 1700000000000;
  assert.equal(model.relativeTime(now - 5000, now), '刚刚');
  assert.equal(model.relativeTime(now - 5 * 60000, now), '5 分钟前');
  assert.equal(model.relativeTime(now - 5 * 3600000, now), '5 小时前');
  assert.equal(model.relativeTime(now - 5 * 86400000, now), '5 天前');
  assert.equal(model.relativeTime(Number.NaN, now), '—');
});

test('绝对时间按本地时区补零', () => {
  const stamp = new Date(2026, 0, 2, 3, 4).getTime();
  assert.equal(model.absoluteTime(stamp), '2026-01-02 03:04');
});

/* -------------------------------------------------------------- 分类模型 */

const cats = model.defaultCategories();

test('种子分类覆盖工作 / 生活 / 周末 / 默认', () => {
  assert.equal(cats.length, 4);
  assert.deepEqual(cats.map((c) => c.name), ['工作', '生活', '周末', '默认']);
  assert.equal(cats[cats.length - 1].id, model.DEFAULT_CATEGORY_ID);
  assert.equal(model.categoryById(cats, model.DEFAULT_CATEGORY_ID).builtin, true);
  assert.equal(new Set(cats.map((c) => c.color)).size, 4, '种子分类颜色应互不相同');
});

test('分类名校验：空 / 超长 / 重名', () => {
  assert.match(model.validateCategoryName('  ', cats, null).errors.name, /不能为空/);
  assert.match(model.validateCategoryName('x'.repeat(model.CATEGORY_LIMIT.name + 1), cats, null).errors.name, /最多/);
  assert.equal(model.validateCategoryName('工作', cats, null).ok, false, '与其他分类重名要拦下');
  const self = model.categoryById(cats, 'cat-work');
  assert.equal(model.validateCategoryName('工作', cats, self.id).ok, true, '改成自己原来的名字要放行');
  assert.equal(model.validateCategoryName('  学习  ', cats, null).value, '学习', '首尾空格要裁掉');
});

test('sanitizeCategories：丢弃脏数据、修复重复 id 并保证默认分类存在', () => {
  const cleaned = model.sanitizeCategories([
    { id: 'a', name: '项目', color: 'c3' },
    { id: 'a', name: '撞车 id', color: 'c9' },    // id 撞车 → 换新 id 保留；非法颜色 → 回退
    { id: 'b', name: '   ', color: 'c1' },        // 空名字 → 丢弃
    null, 'not-an-object',                        // 非对象 → 丢弃
  ]);
  // 数据保留优先：撞 id 的条目改 id 留下（与 sanitize 对待待办的策略一致），
  // 而不是整条丢掉 —— 丢名字比丢一条引用更容易让用户困惑。
  assert.deepEqual(cleaned.map((c) => c.name), ['项目', '撞车 id', '默认']);
  assert.equal(cleaned[0].id, 'a');
  assert.notEqual(cleaned[1].id, 'a');
  assert.equal(new Set(cleaned.map((c) => c.id)).size, cleaned.length, 'id 必须唯一');
  assert.equal(cleaned[0].color, 'c3');
  assert.equal(cleaned[1].color, 'c5', '非法颜色槽位回退到默认槽位');
  assert.equal(cleaned[2].id, model.DEFAULT_CATEGORY_ID);
  assert.equal(model.sanitizeCategories('坏的输入').length, 1, '非数组输入也要得到默认分类');
});

test('分类颜色槽位循环且合法', () => {
  assert.equal(model.nextCategoryColor('c1'), 'c2');
  assert.equal(model.nextCategoryColor('c8'), 'c1', '末尾回到第一个槽位');
  model.CATEGORY_COLORS.forEach((color) => assert.ok(model.CATEGORY_COLOR_NAME[color], color + ' 应有中文名'));
});

test('resolveCategoryId：非法 / 缺失的分类落到默认分类', () => {
  assert.equal(model.resolveCategoryId('cat-work', cats), 'cat-work');
  assert.equal(model.resolveCategoryId('不存在', cats), model.DEFAULT_CATEGORY_ID);
  assert.equal(model.resolveCategoryId(undefined, cats), model.DEFAULT_CATEGORY_ID);
});

test('assignCategories：把失效分类的条目改写到默认分类', () => {
  const todos = [
    { id: 't1', title: 'A', categoryId: 'cat-work' },
    { id: 't2', title: 'B', categoryId: '已删除的分类' },
    { id: 't3', title: 'C' },
  ];
  const fixed = model.assignCategories(todos, cats);
  assert.equal(fixed[0].categoryId, 'cat-work');
  assert.equal(fixed[1].categoryId, model.DEFAULT_CATEGORY_ID);
  assert.equal(fixed[2].categoryId, model.DEFAULT_CATEGORY_ID);
  assert.equal(fixed[0], todos[0], '已经正确的条目应保持同一引用（不做无谓复制）');
});

test('groupByCategory：按分类顺序分组，空分类也保留', () => {
  const todos = [
    { id: 't1', categoryId: 'cat-life' },
    { id: 't2', categoryId: 'cat-work' },
    { id: 't3', categoryId: '幽灵分类' },
  ];
  const buckets = model.groupByCategory(todos, cats);
  assert.deepEqual(buckets.map((b) => b.category.id),
    ['cat-work', 'cat-life', 'cat-weekend', model.DEFAULT_CATEGORY_ID]);
  assert.deepEqual(buckets[0].items.map((t) => t.id), ['t2']);
  assert.equal(buckets[2].items.length, 0, '空分类仍作为一个分组存在');
  assert.deepEqual(buckets[3].items.map((t) => t.id), ['t3'], '未知分类并入默认分类');
  assert.equal(model.countBy(buckets[1].items).total, 1);
  assert.deepEqual(model.countBy([{ status: 'done' }, { status: 'open' }, { status: 'done' }]),
    { total: 3, done: 2, open: 1 });
});

test('新建与编辑都必须带有效分类', () => {
  assert.match(model.validate({ title: 'A', categoryId: '' }, cats).errors.categoryId, /请选择分类/);
  assert.match(model.validate({ title: 'A', categoryId: '不存在' }, cats).errors.categoryId, /已不存在/);
  assert.equal(model.validate({ title: 'A', categoryId: 'cat-life' }, cats).ok, true);

  const created = model.create({ title: '带分类的新条目', categoryId: 'cat-life' }, 1700000000000, cats);
  assert.equal(created.ok, true);
  assert.equal(created.todo.categoryId, 'cat-life');
  assert.equal(created.todo.status, 'open');

  const rejected = model.create({ title: '缺分类' }, 1700000000000, cats);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.categoryId);

  const edited = model.patch(created.todo, { title: '改过标题', categoryId: 'cat-work' }, 1700000001000, cats);
  assert.equal(edited.ok, true);
  assert.equal(edited.todo.categoryId, 'cat-work');
  assert.equal(edited.todo.title, '改过标题');
});

test('sanitize 保留分类字段，缺省时给空串（由 assignCategories 兜底）', () => {
  const list = model.sanitize([{ title: 'A', categoryId: 'cat-work' }, { title: 'B' }]);
  assert.equal(list[0].categoryId, 'cat-work');
  assert.equal(list[1].categoryId, '');
  assert.equal(model.sanitize([{ title: 'C', categoryId: 42 }])[0].categoryId, '');
});

/* ---------------------------------------------------------------- 提醒 */

test('sanitizeReminder：坏数据一律当作"没有提醒"', () => {
  assert.equal(model.sanitizeReminder(null), null);
  assert.equal(model.sanitizeReminder('明天'), null);
  assert.equal(model.sanitizeReminder({ enabled: true }), null);          // 缺 at
  assert.equal(model.sanitizeReminder({ at: 'soon' }), null);             // at 不是数字
});

test('sanitizeReminder：非法枚举回退，不重复就没有结束条件', () => {
  const r = model.sanitizeReminder({
    at: 1700000000000, advance: 7, repeat: 'yearly', endType: 'count',
    endCount: 3, onDone: 'whatever', firedCount: -5, lastFiredAt: 'x',
  });
  assert.equal(r.advance, 0);          // 7 不是合法提前量 → 准时
  assert.equal(r.repeat, 'none');
  assert.equal(r.endType, 'never');    // 不重复 → 结束条件清空
  assert.equal(r.endCount, null);
  assert.equal(r.onDone, 'cancel');
  assert.equal(r.firedCount, 0);
  assert.equal(r.lastFiredAt, null);
});

test('reminderDueAt：触发时刻 = 提醒时间 − 提前量', () => {
  const at = 1700000000000;
  assert.equal(model.reminderDueAt({ at: at, advance: 0 }), at);
  assert.equal(model.reminderDueAt({ at: at, advance: 5 }), at - 5 * 60000);
  assert.equal(model.reminderDueAt({ at: at, advance: 1440 }), at - 24 * 60 * 60000);
});

test('reminderState：已设置 / 即将到期 / 已提醒 / 已过期 / 已结束 / 已取消', () => {
  const now = Date.now();
  const base = { enabled: true, at: now + 10 * 60 * 60000, advance: 0, repeat: 'none' };
  assert.equal(model.reminderState(base, now).key, 'scheduled');
  assert.equal(model.reminderState(Object.assign({}, base, { at: now + 10 * 60000 }), now).key, 'soon');

  // 到点之后分两种：送出去过 = 已提醒；从没送出去 = 已过期（真的错过）
  const past = Object.assign({}, base, { at: now - 60000 });
  assert.equal(model.reminderState(past, now).key, 'missed');
  assert.equal(model.reminderState(past, now).label, '已过期');
  const fired = Object.assign({}, past, { firedCount: 1, lastFiredAt: now - 30000 });
  assert.equal(model.reminderState(fired, now).key, 'fired');
  assert.equal(model.reminderState(fired, now).label, '已提醒');

  // 三种"结束"要分得清：完成 / 重复走完 / 用户取消
  const done = model.cancelReminder(base, now, 'done');
  assert.equal(model.reminderState(done, now).key, 'done');
  assert.equal(model.reminderState(done, now).label, '已结束');
  assert.match(model.reminderState(done, now).detail, /已完成/);

  const ended = model.cancelReminder(base, now, 'series-end');
  assert.equal(model.reminderState(ended, now).key, 'ended');
  assert.equal(model.reminderState(ended, now).label, '重复已结束');

  const off = model.cancelReminder(base, now, 'user');
  assert.equal(model.reminderState(off, now).key, 'off');
  assert.equal(model.reminderState(off, now).label, '已取消');
  assert.match(model.reminderState(off, now).detail, /手动取消/);

  assert.equal(model.reminderState(null, now).key, 'none');
});

test('reminderState：提前量为 1 天时，提前一天就进入"即将到期"', () => {
  const now = Date.now();
  const r = { enabled: true, at: now + 26 * 60 * 60000, advance: 1440, repeat: 'none' };
  assert.equal(model.reminderState(r, now).key, 'scheduled');   // 触发时刻还在 2 小时后
  assert.equal(model.reminderState(r, now + 23 * 60 * 60000).key, 'missed');  // 触发时刻已过、还没送出
});

test('normalizeReminderInput：过去的时间被拒绝，原时间可以保留', () => {
  const now = Date.now();
  const past = model.toLocalInput(now - 60 * 60000);

  const rejected = model.normalizeReminderInput({ enabled: true, atText: past }, now);
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.reminderAt, /已经过去/);

  const kept = model.normalizeReminderInput(
    { enabled: true, atText: past, keepAt: model.fromLocalInput(past) }, now);
  assert.equal(kept.ok, true);
  assert.equal(kept.value.enabled, true);
});

test('normalizeReminderInput：重复次数与截止日期的边界', () => {
  const now = Date.now();
  const at = model.toLocalInput(now + 60 * 60000);

  const zero = model.normalizeReminderInput(
    { enabled: true, atText: at, repeat: 'daily', endType: 'count', endCount: 0 }, now);
  assert.equal(zero.ok, false);
  assert.match(zero.errors.reminderEnd, /1 – 99/);

  const tooMany = model.normalizeReminderInput(
    { enabled: true, atText: at, repeat: 'daily', endType: 'count', endCount: 200 }, now);
  assert.equal(tooMany.ok, false);

  const early = model.normalizeReminderInput(
    { enabled: true, atText: at, repeat: 'daily', endType: 'date', endDateText: '2020-01-01' }, now);
  assert.equal(early.ok, false);
  assert.match(early.errors.reminderEnd, /早于提醒时间/);

  const good = model.normalizeReminderInput(
    { enabled: true, atText: at, repeat: 'daily', endType: 'count', endCount: 3, advance: 5, onDone: 'keep' },
    now);
  assert.equal(good.ok, true);
  assert.equal(good.value.endCount, 3);
  assert.equal(good.value.advance, 5);
  assert.equal(good.value.onDone, 'keep');
});

test('nextOccurrence：每天 / 每周 / 工作日（跳过周末）', () => {
  const friday = new Date(2026, 9, 9, 9, 0, 0).getTime();      // 2026-10-09 周五 09:00
  const daily = new Date(model.nextOccurrence(friday, 'daily', friday));
  assert.equal(daily.getDate(), 10);
  assert.equal(daily.getHours(), 9, '时:分沿用原时间');

  const weekly = new Date(model.nextOccurrence(friday, 'weekly', friday));
  assert.equal(weekly.getDate(), 16);

  const workday = new Date(model.nextOccurrence(friday, 'weekdays', friday));
  assert.equal(workday.getDay(), 1, '周五的下一个是周一');
  assert.equal(workday.getDate(), 12);

  assert.equal(model.nextOccurrence(friday, 'none', friday), null);
});

test('nextOccurrence：跳过已过去的周期（关闭几天后不会补一堆）', () => {
  const start = new Date(2026, 9, 1, 8, 0, 0).getTime();
  const now = new Date(2026, 9, 5, 12, 0, 0).getTime();
  const next = new Date(model.nextOccurrence(start, 'daily', now));
  assert.equal(next.getDate(), 6, '直接给下一个未来时刻');
});

test('advanceReminder：一次性提醒停在原地，重复提醒推进', () => {
  const now = Date.now();
  const oneOff = { enabled: true, at: now - 60000, advance: 0, repeat: 'none', firedCount: 0 };
  const firedOne = model.advanceReminder(oneOff, now);
  assert.equal(firedOne.at, oneOff.at, '一次性提醒不改时间（UI 显示"已过期"）');
  assert.equal(firedOne.firedCount, 1);
  assert.equal(firedOne.lastFiredAt, now);
  assert.equal(firedOne.enabled, true);

  const daily = { enabled: true, at: now - 60000, advance: 0, repeat: 'daily', firedCount: 0 };
  const firedDaily = model.advanceReminder(daily, now);
  assert.ok(firedDaily.at > now, '重复提醒推进到下一个未来时刻');
  assert.equal(firedDaily.firedCount, 1);
});

test('advanceReminder：次数用尽 / 超出截止日期 → 结束整条提醒', () => {
  const now = Date.now();
  const counted = model.advanceReminder(
    { enabled: true, at: now - 60000, advance: 0, repeat: 'daily', endType: 'count', endCount: 2, firedCount: 1 },
    now);
  assert.equal(counted.enabled, false);
  assert.equal(counted.cancelReason, 'series-end');
  assert.equal(counted.firedCount, 2);

  const dated = model.advanceReminder(
    { enabled: true, at: now - 60000, advance: 0, repeat: 'daily', endType: 'date', endDate: now + 60000, firedCount: 0 },
    now);
  assert.equal(dated.enabled, false);
  assert.match(model.reminderState(dated, now).label, /重复已结束/);
});

test('reminderPending：到点但没送过才算"待触发"', () => {
  const now = Date.now();
  const pending = { enabled: true, at: now - 60000, advance: 0, repeat: 'none', lastFiredAt: null };
  assert.equal(model.reminderPending(pending, now), true);
  assert.equal(model.reminderPending(Object.assign({}, pending, { lastFiredAt: now }), now), false);
  assert.equal(model.reminderPending(Object.assign({}, pending, { enabled: false }), now), false);
  assert.equal(model.reminderPending({ enabled: true, at: now + 60000, advance: 0 }, now), false);
});

test('create / patch 带上提醒；同日程改标题不会丢台账', () => {
  const now = Date.now();
  const at = now + 60 * 60000;
  const cats = model.defaultCategories(now);
  const input = {
    title: '带提醒的待办', categoryId: 'cat-work',
    reminder: { enabled: true, atText: model.toLocalInput(at), advance: 5, repeat: 'daily' },
  };

  const created = model.create(input, now, cats);
  assert.equal(created.ok, true);
  assert.equal(created.todo.reminder.at, model.fromLocalInput(model.toLocalInput(at)));
  assert.equal(created.todo.reminder.advance, 5);

  const fired = Object.assign({}, created.todo, {
    reminder: Object.assign({}, created.todo.reminder, { firedCount: 2, lastFiredAt: now - 1000 }),
  });
  const edited = model.patch(fired, {
    title: '改过标题', categoryId: 'cat-work',
    reminder: { enabled: true, atText: model.toLocalInput(at), advance: 5, repeat: 'daily' },
  }, now, cats);
  assert.equal(edited.ok, true);
  assert.equal(edited.todo.reminder.firedCount, 2, '同日程保留已触发次数');
  assert.equal(edited.todo.reminder.lastFiredAt, now - 1000);

  const changed = model.patch(fired, {
    title: '换了时间', categoryId: 'cat-work',
    reminder: { enabled: true, atText: model.toLocalInput(at + 3600000), advance: 5, repeat: 'daily' },
  }, now, cats);
  assert.equal(changed.todo.reminder.firedCount, 0, '换了日程就是新的一轮');
});

test('create：关闭提醒时不产生 reminder 字段', () => {
  const now = Date.now();
  const cats = model.defaultCategories(now);
  const created = model.create({ title: '没有提醒', categoryId: 'cat-work', reminder: { enabled: false } }, now, cats);
  assert.equal(created.ok, true);
  assert.equal(created.todo.reminder, null);
});

test('setStatus：完成按 onDone 处置提醒，恢复时重新打开', () => {
  const now = Date.now();
  const at = now + 60 * 60000;
  const base = {
    id: 't1', title: '写周报', status: 'open', createdAt: now, updatedAt: now, doneAt: null,
    reminder: {
      enabled: true, at: at, advance: 0, repeat: 'none', onDone: 'cancel',
      firedCount: 0, lastFiredAt: null, cancelledAt: null, cancelReason: null,
    },
  };

  const done = model.setStatus(base, 'done', now);
  assert.equal(done.status, 'done');
  assert.equal(done.reminder.enabled, false);
  assert.equal(done.reminder.cancelReason, 'done');

  const reopened = model.setStatus(done, 'open', now);
  assert.equal(reopened.reminder.enabled, true, '时间没到的自动取消会恢复');
  assert.equal(reopened.reminder.cancelReason, null);

  const keep = Object.assign({}, base, { reminder: Object.assign({}, base.reminder, { onDone: 'keep' }) });
  assert.equal(model.setStatus(keep, 'done', now).reminder.enabled, true, 'onDone=keep 时提醒继续');
});

test('sanitize：保留合法提醒，丢掉坏提醒', () => {
  const list = model.sanitize([
    { title: 'A', reminder: { at: 1700000000000, advance: 5, repeat: 'weekly' } },
    { title: 'B', reminder: { nope: true } },
    { title: 'C' },
  ]);
  assert.equal(list[0].reminder.advance, 5);
  assert.equal(list[0].reminder.repeat, 'weekly');
  assert.equal(list[1].reminder, null);
  assert.equal(list[2].reminder, null);
});

test('提醒文案：芯片按语义分（已提醒 ≠ 已过期 ≠ 已取消）', () => {
  const now = new Date(2026, 9, 8, 20, 0, 0).getTime();
  const soon = new Date(2026, 9, 8, 20, 50, 0).getTime();
  const r = { enabled: true, at: soon, advance: 5, repeat: 'daily', endType: 'count', endCount: 3 };

  assert.equal(model.reminderTiming(r, now), '今天 20:50');
  assert.equal(model.reminderChipText(r, now), '⏰ 即将 今天 20:50 ↻');
  assert.match(model.reminderSummary(r, now), /提前 5 分钟/);
  assert.equal(model.reminderRepeatText(r), '每天 · 共 3 次');
  assert.equal(model.dayLabel(new Date(2026, 9, 9, 9, 0).getTime(), now), '明天');

  const far = Object.assign({}, r, { at: new Date(2026, 9, 9, 9, 0, 0).getTime() });
  assert.equal(model.reminderChipText(far, now), '⏰ 明天 09:00 ↻');

  // 送出去过 → 已提醒；到点但从没送出 → 已过期
  const fired = { enabled: true, at: now - 60000, advance: 0, repeat: 'none',
    firedCount: 2, lastFiredAt: now - 30000 };
  assert.equal(model.reminderChipText(fired, now), '⏰ 已提醒 今天 19:59');
  assert.equal(model.reminderChipText(Object.assign({}, fired, { firedCount: 0, lastFiredAt: null }), now),
    '⏰ 已过期 今天 19:59');

  // 结束的三种：完成 / 重复走完 / 用户取消
  const base = { enabled: true, at: soon, advance: 0, repeat: 'none' };
  assert.equal(model.reminderChipText(model.cancelReminder(base, now, 'done'), now), '⏰ 已结束');
  assert.equal(model.reminderChipText(model.cancelReminder(base, now, 'series-end'), now), '⏰ 重复已结束');
  assert.equal(model.reminderChipText(model.cancelReminder(base, now, 'user'), now), '⏰ 已取消');
  assert.equal(model.reminderAdvanceText({ advance: 1440 }), '提前 1 天');
});

test('reminderStats / reminderQueue：统计与排序', () => {
  const now = Date.now();
  const items = [
    { id: 'plain' },
    { id: 'a', reminder: { enabled: true, at: now + 10 * 60000, advance: 0, repeat: 'none' } },
    { id: 'b', reminder: { enabled: true, at: now - 30 * 60000, advance: 0, repeat: 'none' } },
    { id: 'c', reminder: { enabled: false, at: now + 60000, advance: 0, repeat: 'none' } },
  ];

  const stats = model.reminderStats(items, now);
  assert.equal(stats.total, 3, '有关联提醒的三条（含已取消）');
  assert.equal(stats.active, 2);
  assert.equal(stats.soon, 1);
  assert.equal(stats.due, 1);
  assert.equal(stats.pending, 1, '一条到点但没触发过');

  const queue = model.reminderQueue(items, now);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, 'b');
  assert.equal(model.reminderQueue(items, now, { onlyDue: false }).length, 2);
});

test('通知设置：归一化 + 免打扰跨零点', () => {
  const defaults = model.sanitizeNotifications(null);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.sound, true);
  assert.equal(defaults.catchUp, true);

  const custom = model.sanitizeNotifications({
    enabled: false, sound: false, dndEnabled: true, dndFrom: '99:99', dndTo: '08:00',
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.dndFrom, '22:00', '非法时间回退到默认');
  assert.equal(custom.dndTo, '08:00');

  const night = { dndEnabled: true, dndFrom: '22:00', dndTo: '08:00' };
  assert.equal(model.inQuietHours(night, new Date(2026, 9, 8, 23, 30).getTime()), true);
  assert.equal(model.inQuietHours(night, new Date(2026, 9, 8, 7, 0).getTime()), true);
  assert.equal(model.inQuietHours(night, new Date(2026, 9, 8, 12, 0).getTime()), false);
  assert.equal(model.inQuietHours({ dndEnabled: false, dndFrom: '22:00', dndTo: '08:00' },
    new Date(2026, 9, 8, 23, 30).getTime()), false);
  assert.equal(model.quietHoursText(night), '22:00 – 08:00');
});

test('toLocalInput / fromLocalInput 往返不丢时间', () => {
  const ts = new Date(2026, 9, 8, 9, 5, 0).getTime();
  const text = model.toLocalInput(ts);
  assert.equal(text, '2026-10-08T09:05');
  assert.equal(model.fromLocalInput(text), ts);
  assert.equal(model.fromLocalInput('乱写'), null);
  assert.equal(model.fromLocalInput(''), null);
});

/* ------------------------------------------------------------------ 结果 */

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);

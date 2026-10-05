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

/* ------------------------------------------------------------------ 结果 */

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);

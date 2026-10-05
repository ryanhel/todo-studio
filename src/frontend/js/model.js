/* =============================================================================
 * 待办中心 · 数据模型（纯逻辑，零依赖）
 * -----------------------------------------------------------------------------
 * 只放"不依赖 DOM、不依赖 tiny.*"的纯函数：校验 / 创建 / 修改 / 状态流转 /
 * 统计 / 防御性归一化 / 时间格式化。
 *
 * 双运行环境：页面以经典脚本加载（挂 window.TodoApp.model），
 * 也可以在 Node 里 require() 做单元测试 —— 见 tools/model.test.js。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.TodoApp = root.TodoApp || {}).model = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ 枚举 */

  const STATUSES = ['open', 'done'];
  const STATUS_LABEL = { open: '未完成', done: '已完成' };

  const PRIORITIES = ['low', 'normal', 'high'];
  const PRIORITY_LABEL = { low: '低', normal: '中', high: '高' };
  /** 优先级排序权重（高优先级靠前） */
  const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

  /** 字段长度上限：校验与归一化共用，避免两处漂移 */
  const LIMIT = { title: 120, note: 500 };

  /* ------------------------------------------------------------------ 分类 */

  /**
   * 分类颜色用"槽位"而不是色值：真实颜色由主题层（CSS 变量 --cat-1..--cat-8）
   * 决定，浅色/深色主题各有一套经过对比度检查的色板，换主题时分类色自动跟随。
   */
  const CATEGORY_COLORS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
  /** 槽位的人类可读名字（只用于 title / 提示文案） */
  const CATEGORY_COLOR_NAME = {
    c1: '科技蓝', c2: '紫', c3: '绿', c4: '琥珀', c5: '粉', c6: '青', c7: '橙', c8: '灰',
  };
  const CATEGORY_LIMIT = { name: 16 };

  /** 循环到下一个颜色槽位（点色点换色用） */
  function nextCategoryColor(color) {
    const index = CATEGORY_COLORS.indexOf(color);
    return CATEGORY_COLORS[(index + 1) % CATEGORY_COLORS.length];
  }

  /** 兜底分类：不可删除；删除其他分类时，其条目会转移到这里 */
  const DEFAULT_CATEGORY_ID = 'cat-default';

  /** 首次运行的种子分类（默认放最后，作为"兜底桶"） */
  function defaultCategories(now) {
    const at = typeof now === 'number' ? now : 0;
    return [
      { id: 'cat-work', name: '工作', color: 'c2', builtin: false, createdAt: at },
      { id: 'cat-life', name: '生活', color: 'c3', builtin: false, createdAt: at + 1 },
      { id: 'cat-weekend', name: '周末', color: 'c4', builtin: false, createdAt: at + 2 },
      { id: DEFAULT_CATEGORY_ID, name: '默认', color: 'c1', builtin: true, createdAt: at + 3 },
    ];
  }

  function makeCategory(name, color, now) {
    const at = typeof now === 'number' ? now : Date.now();
    return {
      id: 'cat' + at.toString(36) + Math.random().toString(36).slice(2, 6),
      name: toText(name, CATEGORY_LIMIT.name),
      color: CATEGORY_COLORS.indexOf(color) >= 0 ? color : 'c5',
      builtin: false,
      createdAt: at,
    };
  }

  /** 分类名校验：非空、不超长、不重名（重命名时用 selfId 排除自己） */
  function validateCategoryName(name, categories, selfId) {
    const value = toText(name);
    const errors = {};
    if (!value) errors.name = '分类名不能为空';
    else if (value.length > CATEGORY_LIMIT.name) {
      errors.name = '分类名最多 ' + CATEGORY_LIMIT.name + ' 字';
    }
    const clash = (categories || []).some(function (category) {
      return category.id !== selfId && category.name.toLowerCase() === value.toLowerCase();
    });
    if (!errors.name && clash) errors.name = '已有同名分类「' + value + '」';
    return { ok: !errors.name, errors: errors, value: value };
  }

  /** 归一化分类列表：名字非空、id 唯一、颜色合法，且保证默认分类存在 */
  function sanitizeCategories(raw) {
    const out = [];
    const seen = Object.create(null);
    (Array.isArray(raw) ? raw : []).forEach(function (item, index) {
      if (!item || typeof item !== 'object') return;
      const name = toText(item.name, CATEGORY_LIMIT.name);
      if (!name) return;

      const builtin = item.id === DEFAULT_CATEGORY_ID;
      let id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || seen[id]) {
        id = builtin ? DEFAULT_CATEGORY_ID : 'cat' + index + Math.random().toString(36).slice(2, 6);
      }
      if (seen[id]) return;
      seen[id] = true;

      out.push({
        id: id,
        name: name,
        color: CATEGORY_COLORS.indexOf(item.color) >= 0 ? item.color : 'c5',
        builtin: builtin,
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
      });
    });

    if (!seen[DEFAULT_CATEGORY_ID]) {
      out.push({ id: DEFAULT_CATEGORY_ID, name: '默认', color: 'c1', builtin: true, createdAt: 0 });
    }
    return out;
  }

  function categoryById(categories, id) {
    const list = categories || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /** 把分类 id 归一化到"确实存在的分类"；缺失或非法时落到默认分类 */
  function resolveCategoryId(id, categories) {
    return categoryById(categories, id) ? id : DEFAULT_CATEGORY_ID;
  }

  /** 条目上失效的分类统一改写到默认分类（删除分类后调用） */
  function assignCategories(todos, categories) {
    return (todos || []).map(function (todo) {
      const id = resolveCategoryId(todo.categoryId, categories);
      return id === todo.categoryId ? todo : Object.assign({}, todo, { categoryId: id });
    });
  }

  /** 按分类分组：输出顺序 = 分类顺序；空分类也保留（便于将来拖拽归类） */
  function groupByCategory(todos, categories) {
    const buckets = (categories || []).map(function (category) {
      return { category: category, items: [] };
    });
    const index = Object.create(null);
    buckets.forEach(function (bucket) { index[bucket.category.id] = bucket; });
    (todos || []).forEach(function (todo) {
      const bucket = index[todo.categoryId] || index[DEFAULT_CATEGORY_ID];
      if (bucket) bucket.items.push(todo);
    });
    return buckets;
  }

  function countBy(items) {
    let done = 0;
    (items || []).forEach(function (item) { if (item.status === 'done') done++; });
    const total = (items || []).length;
    return { total: total, done: done, open: total - done };
  }

  /* ------------------------------------------------------------------ 工具 */

  let seq = 0;

  /** 生成可读且足够唯一的 id：t + 36进制时间 + 序号 + 随机后缀 */
  function makeId(now) {
    seq = (seq + 1) % 1296;
    return 't' + now.toString(36) + seq.toString(36).padStart(2, '0') +
      Math.random().toString(36).slice(2, 6);
  }

  function toText(value, max) {
    const text = String(value == null ? '' : value).trim();
    return max ? text.slice(0, max) : text;
  }

  function isPriority(value) { return PRIORITIES.indexOf(value) !== -1; }
  function isStatus(value) { return STATUSES.indexOf(value) !== -1; }

  /* ------------------------------------------------------------------ 校验 */

  /**
   * 校验表单输入（新增与编辑共用）。
   * @param {{title?:string, note?:string, priority?:string, categoryId?:string}} input
   * @param {Array} [categories] 传了分类表就顺带校验分类是否存在
   * @returns {{ok:boolean, errors:Object<string,string>, value:Object}}
   */
  function validate(input, categories) {
    const source = input || {};
    const title = toText(source.title);
    const note = toText(source.note);
    const errors = {};

    if (!title) errors.title = '标题不能为空（不能只输入空格）';
    else if (title.length > LIMIT.title) {
      errors.title = '标题最多 ' + LIMIT.title + ' 字，当前 ' + title.length + ' 字';
    }
    if (note.length > LIMIT.note) {
      errors.note = '备注最多 ' + LIMIT.note + ' 字，当前 ' + note.length + ' 字';
    }

    // 分类：必须选中且确实存在（表单默认预选，这里是兜底与"分类被删掉"的防护）
    let categoryId = toText(source.categoryId);
    if (Array.isArray(categories) && categories.length) {
      if (!categoryId) errors.categoryId = '请选择分类';
      else if (!categoryById(categories, categoryId)) {
        errors.categoryId = '所选分类已不存在，请重新选择';
      }
    }

    return {
      ok: Object.keys(errors).length === 0,
      errors: errors,
      value: {
        title: title.slice(0, LIMIT.title),
        note: note.slice(0, LIMIT.note),
        priority: isPriority(source.priority) ? source.priority : 'normal',
        categoryId: categoryId || DEFAULT_CATEGORY_ID,
      },
    };
  }

  /* -------------------------------------------------------------- 增 / 改 */

  /** 由表单输入创建一条待办；校验失败时返回 {ok:false, errors} */
  function create(input, now, categories) {
    const at = typeof now === 'number' ? now : Date.now();
    const checked = validate(input, categories);
    if (!checked.ok) return { ok: false, errors: checked.errors };
    return {
      ok: true,
      todo: {
        id: makeId(at),
        title: checked.value.title,
        note: checked.value.note,
        priority: checked.value.priority,
        categoryId: checked.value.categoryId,
        status: 'open',
        createdAt: at,
        updatedAt: at,
        doneAt: null,
      },
    };
  }

  /** 用表单输入覆盖已有待办的文本字段与分类（不改状态） */
  function patch(todo, input, now, categories) {
    const at = typeof now === 'number' ? now : Date.now();
    const checked = validate(input, categories);
    if (!checked.ok) return { ok: false, errors: checked.errors };
    return {
      ok: true,
      todo: Object.assign({}, todo, {
        title: checked.value.title,
        note: checked.value.note,
        priority: checked.value.priority,
        categoryId: checked.value.categoryId,
        updatedAt: at,
      }),
    };
  }

  /** 状态流转：完成/恢复正常，doneAt 与 updatedAt 同步维护 */
  function setStatus(todo, status, now) {
    const at = typeof now === 'number' ? now : Date.now();
    if (!isStatus(status) || todo.status === status) return todo;
    return Object.assign({}, todo, {
      status: status,
      doneAt: status === 'done' ? at : null,
      updatedAt: at,
    });
  }
  /* -------------------------------------------------------------- 列表操作 */

  /** 新条目置顶插入 */
  function add(list, todo) {
    return [todo].concat(list);
  }

  function remove(list, id) {
    return list.filter(function (item) { return item.id !== id; });
  }

  function replace(list, todo) {
    return list.map(function (item) { return item.id === todo.id ? todo : item; });
  }

  function byId(list, id) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /** 默认排序：未完成在前 → 优先级高的在前 → 最近更新在前 */
  function sort(list) {
    return list.slice().sort(function (a, b) {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (byPriority !== 0) return byPriority;
      return b.updatedAt - a.updatedAt;
    });
  }

  /** 按状态分组（未完成 / 已完成），组内沿用 sort 的顺序 */
  function group(list) {
    const sorted = sort(list);
    return {
      open: sorted.filter(function (item) { return item.status === 'open'; }),
      done: sorted.filter(function (item) { return item.status === 'done'; }),
    };
  }

  /** 筛选：'all' | 'open' | 'done'（未知值按 all 处理） */
  function filter(list, mode) {
    if (mode !== 'open' && mode !== 'done') return list.slice();
    return list.filter(function (item) { return item.status === mode; });
  }

  /** 头部统计：总数 / 未完成 / 已完成 / 完成率 */
  function stats(list) {
    let done = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].status === 'done') done++;
    }
    const total = list.length;
    return { total: total, done: done, open: total - done, ratio: total ? done / total : 0 };
  }

  /** 单行摘要：压缩空白并截断，用于列表里的"必要摘要信息" */
  function excerpt(text, max) {
    const limit = max || 60;
    const flat = toText(text).replace(/\s+/g, ' ');
    if (!flat) return '';
    return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat;
  }

  /* ---------------------------------------------------------- 防御性归一化 */

  /**
   * 把磁盘上读到的任意数据归一化成合法列表：丢弃非法项、补齐缺失字段、
   * 去重 id、丢弃超长文本。数据可能被外部编辑或来自旧版本，
   * 这一步保证 UI 永远拿到干净、可信的数据。
   */
  function sanitize(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = Object.create(null);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (!item || typeof item !== 'object') continue;

      const title = toText(item.title).slice(0, LIMIT.title);
      if (!title) continue;

      let id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || seen[id]) id = makeId(Date.now() + i);
      if (seen[id]) continue;
      seen[id] = true;

      const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : Date.now();
      const status = isStatus(item.status) ? item.status : 'open';
      const updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : createdAt;

      out.push({
        id: id,
        title: title,
        note: toText(item.note).slice(0, LIMIT.note),
        priority: isPriority(item.priority) ? item.priority : 'normal',
        // 分类在这里只做"取字符串"；是否落到默认分类由 assignCategories 决定
        categoryId: typeof item.categoryId === 'string' ? item.categoryId.trim() : '',
        status: status,
        createdAt: createdAt,
        updatedAt: updatedAt,
        doneAt: Number.isFinite(item.doneAt) ? item.doneAt : (status === 'done' ? updatedAt : null),
      });
    }
    return out;
  }

  /* -------------------------------------------------------------- 时间显示 */

  /** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期 */
  function relativeTime(ts, now) {
    const at = typeof now === 'number' ? now : Date.now();
    if (!Number.isFinite(ts)) return '—';
    const diff = at - ts;
    if (diff < 45 * 1000) return '刚刚';
    const minutes = Math.round(diff / 60000);
    if (minutes < 60) return minutes + ' 分钟前';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + ' 小时前';
    const days = Math.round(hours / 24);
    if (days < 30) return days + ' 天前';
    return absoluteTime(ts);
  }

  /** 绝对时间：2026-10-05 22:30（页面侧有 Intl，后端没有，故手写补零） */
  function absoluteTime(ts) {
    if (!Number.isFinite(ts)) return '—';
    const d = new Date(ts);
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  return {
    STATUSES: STATUSES, STATUS_LABEL: STATUS_LABEL,
    PRIORITIES: PRIORITIES, PRIORITY_LABEL: PRIORITY_LABEL, PRIORITY_RANK: PRIORITY_RANK,
    LIMIT: LIMIT,
    CATEGORY_COLORS: CATEGORY_COLORS, CATEGORY_COLOR_NAME: CATEGORY_COLOR_NAME,
    CATEGORY_LIMIT: CATEGORY_LIMIT, DEFAULT_CATEGORY_ID: DEFAULT_CATEGORY_ID,
    nextCategoryColor: nextCategoryColor,
    validate: validate, create: create, patch: patch, setStatus: setStatus,
    add: add, remove: remove, replace: replace, byId: byId,
    sort: sort, group: group, filter: filter, stats: stats, excerpt: excerpt,
    sanitize: sanitize, relativeTime: relativeTime, absoluteTime: absoluteTime,
    makeId: makeId, toText: toText,
    // 分类
    defaultCategories: defaultCategories, makeCategory: makeCategory,
    validateCategoryName: validateCategoryName, sanitizeCategories: sanitizeCategories,
    categoryById: categoryById, resolveCategoryId: resolveCategoryId,
    assignCategories: assignCategories, groupByCategory: groupByCategory, countBy: countBy,
  };
});


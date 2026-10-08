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

  /* ------------------------------------------------------------------ 提醒 */

  /** 提前量选项（分钟）：0 = 准时提醒 —— 触发时刻 = 提醒时间 − 提前量 */
  const REMINDER_ADVANCES = [0, 5, 15, 30, 60, 120, 1440, 2880];
  const REMINDER_ADVANCE_LABEL = {
    0: '准时', 5: '提前 5 分钟', 15: '提前 15 分钟', 30: '提前 30 分钟',
    60: '提前 1 小时', 120: '提前 2 小时', 1440: '提前 1 天', 2880: '提前 2 天',
  };

  /** 重复规则：只留三种最常见的，避免表单变成日历应用 */
  const REMINDER_REPEATS = ['none', 'daily', 'weekly', 'weekdays'];
  const REMINDER_REPEAT_LABEL = {
    none: '不重复', daily: '每天', weekly: '每周', weekdays: '工作日',
  };

  /** 重复的结束条件 */
  const REMINDER_ENDS = ['never', 'count', 'date'];
  const REMINDER_END_LABEL = { never: '不限', count: '按次数', date: '按日期' };

  /** 待办完成后如何处置提醒 */
  const REMINDER_ON_DONE = ['cancel', 'keep'];
  const REMINDER_ON_DONE_LABEL = { cancel: '自动取消', keep: '保留（重复继续）' };

  /**
   * 提醒状态（列表芯片 / 详情面板共用）——按"提醒到底发生了什么"分，而不是按开关状态分：
   *   scheduled 已设置    · soon 即将到期（触发前 1 小时内）
   *   fired     已提醒    · 到点且真的送出去过（一次性提醒触发后停在这里等处理）
   *   missed    已过期    · 到点但从没送出去过（补发被关掉 / 通知不可用等，这才是"错过"）
   *   done      已结束    · 待办完成时按规则结束（不是用户取消）
   *   ended     重复已结束 · 重复次数 / 截止日期用尽
   *   off       已取消    · 用户手动取消
   */
  const REMINDER_STATES = ['none', 'scheduled', 'soon', 'fired', 'missed', 'done', 'ended', 'off'];
  const REMINDER_STATE_LABEL = {
    none: '未设置', scheduled: '已设置', soon: '即将到期',
    fired: '已提醒', missed: '已过期', done: '已结束', ended: '重复已结束', off: '已取消',
  };
  /** 提醒"为什么结束"的说明（详情面板与提示语共用） */
  const REMINDER_END_DETAIL = {
    user: '手动取消，设置保留', done: '已完成，提醒随之结束', 'series-end': '重复次数或截止日期已到',
  };
  const REMINDER_END_REASONS = ['user', 'done', 'series-end'];

  /** 提前多久算"即将到期"（列表 / 详情的高亮阈值） */
  const REMINDER_SOON_MS = 60 * 60 * 1000;
  const REMINDER_LIMIT = { count: 99 };
  const DAY_MS = 24 * 60 * 60 * 1000;

  function isRepeat(value) { return REMINDER_REPEATS.indexOf(value) !== -1; }
  function isEnd(value) { return REMINDER_ENDS.indexOf(value) !== -1; }
  function isOnDone(value) { return REMINDER_ON_DONE.indexOf(value) !== -1; }
  function isAdvance(value) { return REMINDER_ADVANCES.indexOf(value) !== -1; }

  /** 触发时刻 = 提醒时间 − 提前量；提前量非法时按"准时"处理 */
  function reminderDueAt(reminder) {
    if (!reminder || !Number.isFinite(reminder.at)) return null;
    const advance = isAdvance(reminder.advance) ? reminder.advance : 0;
    return reminder.at - advance * 60000;
  }

  /** 提醒是否是"活的"（还会触发） */
  function reminderActive(reminder) {
    return !!reminder && reminder.enabled === true && Number.isFinite(reminder.at);
  }

  /**
   * 把磁盘上读到的任意 reminder 归一化：结构合法才保留，否则返回 null（视为未设置）。
   * 与 sanitize() 一样是防御层：外部编辑过的 JSON 不能把 UI 弄崩。
   */
  function sanitizeReminder(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!Number.isFinite(raw.at)) return null;

    const repeat = isRepeat(raw.repeat) ? raw.repeat : 'none';
    let endType = isEnd(raw.endType) ? raw.endType : 'never';
    let endCount = Number.isFinite(raw.endCount)
      ? Math.min(Math.max(Math.floor(raw.endCount), 1), REMINDER_LIMIT.count) : null;
    let endDate = Number.isFinite(raw.endDate) ? raw.endDate : null;

    if (repeat === 'none') { endType = 'never'; endCount = null; endDate = null; }
    if (endType === 'count' && endCount == null) endCount = 5;
    if (endType === 'date' && endDate == null) { endType = 'count'; endCount = endCount || 5; }

    return {
      enabled: raw.enabled !== false,
      at: raw.at,
      advance: isAdvance(raw.advance) ? raw.advance : 0,
      repeat: repeat,
      endType: endType,
      endCount: endCount,
      endDate: endDate,
      onDone: isOnDone(raw.onDone) ? raw.onDone : 'cancel',
      firedCount: Number.isFinite(raw.firedCount) && raw.firedCount > 0 ? Math.floor(raw.firedCount) : 0,
      lastFiredAt: Number.isFinite(raw.lastFiredAt) ? raw.lastFiredAt : null,
      cancelledAt: Number.isFinite(raw.cancelledAt) ? raw.cancelledAt : null,
      cancelReason: typeof raw.cancelReason === 'string' ? raw.cancelReason : null,
    };
  }

  /** 取消提醒（用户取消 / 完成时自动取消 / 重复结束），保留历史以便详情里解释原因 */
  function cancelReminder(reminder, now, reason) {
    if (!reminder) return null;
    const at = typeof now === 'number' ? now : Date.now();
    return Object.assign({}, reminder, {
      enabled: false,
      cancelledAt: at,
      cancelReason: reason || 'user',
    });
  }

  /**
   * 同一个本地时刻的"下一个周期"：用 Date 构造器做加法，跨月、跨年、
   * 夏令时（那天只有 23 小时）都交给平台日历处理，不用固定毫秒数硬加。
   */
  function stepOccurrence(ts, repeat) {
    const d = new Date(ts);
    const h = d.getHours();
    const m = d.getMinutes();
    if (repeat === 'weekly') {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7, h, m, 0, 0).getTime();
    }
    if (repeat === 'weekdays') {
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m, 0, 0);
      while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
      return next.getTime();
    }
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m, 0, 0).getTime();
  }

  /** 严格晚于 after 的下一个周期时刻；不重复 / 步进失控时返回 null */
  function nextOccurrence(from, repeat, after) {
    if (!isRepeat(repeat) || repeat === 'none' || !Number.isFinite(from)) return null;
    const base = typeof after === 'number' ? after : Date.now();
    let next = from;
    for (let guard = 0; guard < 400; guard++) {
      next = stepOccurrence(next, repeat);
      if (next > base) return next;
    }
    return null;
  }

  /**
   * 触发之后的推进：一次性提醒停在原地（UI 显示"已过期"，等用户处理），
   * 重复提醒推进到下一个未过期的周期；次数 / 日期条件达成时结束整条提醒。
   * @returns {Object|null} 新的 reminder（null 表示原本就没有提醒）
   */
  function advanceReminder(reminder, now) {
    if (!reminder) return null;
    const at = typeof now === 'number' ? now : Date.now();
    const fired = Object.assign({}, reminder, {
      lastFiredAt: at,
      firedCount: (reminder.firedCount || 0) + 1,
    });
    if (reminder.repeat === 'none') return fired;

    if (reminder.endType === 'count' && fired.firedCount >= (reminder.endCount || 0)) {
      return cancelReminder(fired, at, 'series-end');
    }
    const next = nextOccurrence(reminder.at, reminder.repeat, at);
    if (next == null) return cancelReminder(fired, at, 'series-end');
    if (reminder.endType === 'date' && Number.isFinite(reminder.endDate) && next > reminder.endDate) {
      return cancelReminder(fired, at, 'series-end');
    }
    return Object.assign(fired, { at: next });
  }

  /**
   * 状态推导：列表芯片、详情面板、顶部横幅共用。
   * 关键区分：**"已提醒"（送出去过） ≠ "已过期"（到点但没送出去） ≠ "已取消"（用户主动关掉）**，
   * 完成待办而结束的叫"已结束"，重复走完的叫"重复已结束" —— 都不算"用户取消"。
   * @returns {{key:string,label:string,dueAt:number|null,reason?:string,detail?:string}}
   */
  function reminderState(reminder, now) {
    const at = typeof now === 'number' ? now : Date.now();
    if (!reminder || !Number.isFinite(reminder.at)) {
      return { key: 'none', label: REMINDER_STATE_LABEL.none, dueAt: null };
    }
    const due = reminderDueAt(reminder);

    if (reminder.enabled !== true) {
      const reason = REMINDER_END_REASONS.indexOf(reminder.cancelReason) >= 0 ? reminder.cancelReason : 'user';
      const key = reason === 'done' ? 'done' : (reason === 'series-end' ? 'ended' : 'off');
      return {
        key: key, label: REMINDER_STATE_LABEL[key], reason: reason,
        detail: REMINDER_END_DETAIL[reason], dueAt: due,
      };
    }
    if (due == null) return { key: 'none', label: REMINDER_STATE_LABEL.none, dueAt: null };

    if (at >= due) {
      // 到点之后再看"到底提醒过没有"：触发过 → 已提醒；从没送出去 → 已过期（真的错过了）
      const fired = Number.isFinite(reminder.lastFiredAt) || reminder.firedCount > 0;
      return {
        key: fired ? 'fired' : 'missed',
        label: REMINDER_STATE_LABEL[fired ? 'fired' : 'missed'],
        dueAt: due,
      };
    }
    if (due - at <= REMINDER_SOON_MS) return { key: 'soon', label: REMINDER_STATE_LABEL.soon, dueAt: due };
    return { key: 'scheduled', label: REMINDER_STATE_LABEL.scheduled, dueAt: due };
  }

  /** 提醒是否"该触发但还没触发"（重开后的补发判断 / 页面侧兜底检查） */
  function reminderPending(reminder, now) {
    if (!reminderActive(reminder)) return false;
    const due = reminderDueAt(reminder);
    const at = typeof now === 'number' ? now : Date.now();
    if (due == null || at < due) return false;
    return !(Number.isFinite(reminder.lastFiredAt) && reminder.lastFiredAt >= due);
  }

  /* -------------------------------------------------------- 提醒：输入与文案 */

  function pad2(n) { return String(n).padStart(2, '0'); }

  /** 时间戳 → <input type="datetime-local"> 的本地时间串（YYYY-MM-DDTHH:mm） */
  function toLocalInput(ts) {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 本地时间串 → 时间戳；解析不出来返回 null（不猜、不兜底成"现在"） */
  function fromLocalInput(text) {
    const value = toText(text);
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value);
    if (!m) return null;
    const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  /** 日期部分的相对说法：今天 / 明天 / 昨天 / MM-DD / YYYY-MM-DD */
  function dayLabel(ts, now) {
    const at = typeof now === 'number' ? now : Date.now();
    const a = new Date(at);
    const b = new Date(ts);
    const dayA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
    const dayB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
    const diff = Math.round((dayB - dayA) / DAY_MS);
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === -1) return '昨天';
    const sameYear = a.getFullYear() === b.getFullYear();
    return (sameYear ? '' : b.getFullYear() + '-') + pad2(b.getMonth() + 1) + '-' + pad2(b.getDate());
  }

  /** 提醒时间的口语化写法：今天 09:00 / 明天 08:30 / 10-12 14:00 */
  function reminderTiming(reminder, now) {
    if (!reminder || !Number.isFinite(reminder.at)) return '—';
    const d = new Date(reminder.at);
    return dayLabel(reminder.at, now) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 提前量文案 */
  function reminderAdvanceText(reminder) {
    const advance = reminder && isAdvance(reminder.advance) ? reminder.advance : 0;
    return REMINDER_ADVANCE_LABEL[advance] || '准时';
  }

  /** 重复规则 + 结束条件：每天 / 每周 · 共 5 次 / 工作日 · 至 10-31 */
  function reminderRepeatText(reminder) {
    if (!reminder || reminder.repeat === 'none') return '不重复';
    let text = REMINDER_REPEAT_LABEL[reminder.repeat] || '不重复';
    if (reminder.endType === 'count' && reminder.endCount) {
      text += ' · 共 ' + reminder.endCount + ' 次';
    } else if (reminder.endType === 'date' && Number.isFinite(reminder.endDate)) {
      text += ' · 至 ' + dayLabel(reminder.endDate, reminder.at);
    }
    return text;
  }

  /** 详情 / tooltip 用的一行摘要：今天 09:00 · 提前 5 分钟 · 每天 */
  function reminderSummary(reminder, now) {
    if (!reminder || !Number.isFinite(reminder.at)) return '未设置提醒';
    const state = reminderState(reminder, now);
    const parts = [reminderTiming(reminder, now)];
    if (reminder.advance) parts.push(reminderAdvanceText(reminder));
    if (reminder.repeat !== 'none') parts.push(reminderRepeatText(reminder));
    if (state.key === 'fired') {
      parts.push('已提醒' + (reminder.firedCount > 1 ? ' ' + reminder.firedCount + ' 次' : ''));
    } else if (state.key === 'done' || state.key === 'ended' || state.key === 'off') {
      parts.push(state.label);
    }
    return parts.join(' · ');
  }

  /**
   * 列表芯片文本：`⏰ <时间>` 为基础，前缀按语义区分 ——
   *   即将到期 / 已提醒（送出去过）/ 已过期（到点但没送出去）/ 已结束 / 重复已结束 / 已取消
   */
  function reminderChipText(reminder, now) {
    if (!reminder || !Number.isFinite(reminder.at)) return '';
    const state = reminderState(reminder, now);
    const timing = reminderTiming(reminder, now);
    let text = '⏰ ' + timing;
    if (state.key === 'soon') text = '⏰ 即将 ' + timing;
    else if (state.key === 'fired') text = '⏰ 已提醒 ' + timing;
    else if (state.key === 'missed') text = '⏰ 已过期 ' + timing;
    else if (state.key === 'done') text = '⏰ 已结束';
    else if (state.key === 'ended') text = '⏰ 重复已结束';
    else if (state.key === 'off') text = '⏰ 已取消';

    const repeating = reminder.repeat !== 'none';
    const live = state.key === 'scheduled' || state.key === 'soon' ||
      state.key === 'fired' || state.key === 'missed';
    if (repeating && live) text += ' ↻';
    return text;
  }

  /** 归一化表单里的提醒输入（控制器负责把 DOM 值翻译成这个对象） */
  function normalizeReminderInput(input, now) {
    const at = typeof now === 'number' ? now : Date.now();
    const src = input || {};
    if (!src.enabled) return { ok: true, errors: {}, value: null };

    const errors = {};
    const time = Number.isFinite(src.at) ? src.at : fromLocalInput(src.atText);
    // keepAt：编辑一条"提醒已到点 / 已提醒过"的待办时，原时间允许保留（改时间才要求未来）
    const kept = Number.isFinite(src.keepAt) && src.keepAt === time;
    if (time == null) errors.reminderAt = '请选择提醒时间';
    else if (time <= at && !kept) errors.reminderAt = '提醒时间已经过去，请选择将来的时间';

    const repeat = isRepeat(src.repeat) ? src.repeat : 'none';
    const endType = repeat === 'none' ? 'never' : (isEnd(src.endType) ? src.endType : 'never');
    let endCount = null;
    let endDate = null;

    if (endType === 'count') {
      const count = Number.isFinite(src.endCount) ? Math.floor(src.endCount) : NaN;
      if (!(count >= 1 && count <= REMINDER_LIMIT.count)) {
        errors.reminderEnd = '重复次数请填 1 – ' + REMINDER_LIMIT.count + ' 之间的整数';
      } else endCount = count;
    } else if (endType === 'date') {
      const date = Number.isFinite(src.endDate) ? src.endDate
        : fromLocalInput(String(src.endDateText || '') + 'T23:59');
      if (date == null) errors.reminderEnd = '请选择截止日期';
      else if (time != null && date < time) errors.reminderEnd = '截止日期早于提醒时间';
      else endDate = date;
    }

    return {
      ok: Object.keys(errors).length === 0,
      errors: errors,
      value: {
        enabled: true,
        at: time,
        advance: isAdvance(src.advance) ? src.advance : 0,
        repeat: repeat,
        endType: endType,
        endCount: endCount,
        endDate: endDate,
        onDone: isOnDone(src.onDone) ? src.onDone : 'cancel',
        // 台账字段：保存时按旧值保留（见 create / patch）
        firedCount: 0,
        lastFiredAt: null,
        cancelledAt: null,
        cancelReason: null,
      },
    };
  }

  /** 表单编辑用的"输入态"：把 reminder 摊平成控件需要的值 */
  function reminderForm(raw) {
    const reminder = sanitizeReminder(raw);
    const now = Date.now();
    return {
      enabled: !!reminder && reminder.enabled !== false,
      at: reminder ? reminder.at : null,
      atText: reminder ? toLocalInput(reminder.at) : '',
      advance: reminder ? reminder.advance : 0,
      repeat: reminder ? reminder.repeat : 'none',
      endType: reminder ? reminder.endType : 'never',
      endCount: reminder && reminder.endCount != null ? reminder.endCount : 5,
      endDate: reminder ? reminder.endDate : null,
      endDateText: reminder && Number.isFinite(reminder.endDate)
        ? toLocalInput(reminder.endDate).slice(0, 10) : '',
      onDone: reminder ? reminder.onDone : 'cancel',
      lastFiredAt: reminder ? reminder.lastFiredAt : null,
      firedCount: reminder ? reminder.firedCount : 0,
      state: reminderState(reminder, now),
      defaultAtText: toLocalInput(now + 60 * 60 * 1000),   // 默认值：一小时后
    };
  }

  /** 提醒总览：设置条数 / 活跃 / 到点 / 即将到期 / 待补发 —— 横幅与设置页共用 */
  function reminderStats(items, now) {
    const at = typeof now === 'number' ? now : Date.now();
    let total = 0;
    let active = 0;
    let due = 0;
    let soon = 0;
    let pending = 0;
    (items || []).forEach(function (todo) {
      if (!todo.reminder) return;
      total++;
      const state = reminderState(todo.reminder, at);
      if (state.key === 'scheduled' || state.key === 'soon' ||
          state.key === 'fired' || state.key === 'missed') active++;
      if (state.key === 'soon') soon++;
      if (state.key === 'fired' || state.key === 'missed') due++;
      if (reminderPending(todo.reminder, at)) pending++;
    });
    return { total: total, active: active, due: due, soon: soon, pending: pending };
  }

  /** 到点（已提醒 / 已过期但没送出）/ 即将到期的条目，按触发时刻排序（最近的在最前） */
  function reminderQueue(items, now, options) {
    const at = typeof now === 'number' ? now : Date.now();
    const onlyDue = !(options && options.onlyDue === false);
    return (items || []).filter(function (todo) {
      if (!reminderActive(todo.reminder)) return false;
      const state = reminderState(todo.reminder, at);
      if (state.key === 'fired' || state.key === 'missed') return true;
      return !onlyDue && state.key === 'soon';
    }).sort(function (a, b) {
      return reminderDueAt(a.reminder) - reminderDueAt(b.reminder);
    });
  }

  /* ------------------------------------------------------------ 通知设置 */

  /** 通知设置默认值：系统通知总开关 / 提示音 / 免打扰 / 错过的提醒是否补发 */
  const DEFAULT_NOTIFICATIONS = {
    enabled: true,
    sound: true,
    dndEnabled: false,
    dndFrom: '22:00',
    dndTo: '08:00',
    catchUp: true,
  };

  /** 归一化通知设置：任何字段坏了都退回默认值 */
  function sanitizeNotifications(raw) {
    const out = Object.assign({}, DEFAULT_NOTIFICATIONS);
    if (!raw || typeof raw !== 'object') return out;
    if (raw.enabled === false) out.enabled = false;
    if (raw.sound === false) out.sound = false;
    if (raw.catchUp === false) out.catchUp = false;
    out.dndEnabled = raw.dndEnabled === true;
    if (isClock(raw.dndFrom)) out.dndFrom = raw.dndFrom;
    if (isClock(raw.dndTo)) out.dndTo = raw.dndTo;
    return out;
  }

  /** 是否合法的 24 小时制 'HH:MM'（00:00 – 23:59）；非法输入不能进设置 */
  function isClock(value) {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  }

  /** 'HH:MM' → 当天分钟数（解析失败返回 null） */
  function minutesOfDay(text) {
    const m = /^(\d{2}):(\d{2})$/.exec(toText(text));
    if (!m) return null;
    const minutes = (+m[1]) * 60 + (+m[2]);
    return minutes >= 0 && minutes < 1440 ? minutes : null;
  }

  /** 现在是否处于免打扰时段（支持跨零点，例如 22:00 – 08:00） */
  function inQuietHours(notifications, now) {
    const settings = notifications || DEFAULT_NOTIFICATIONS;
    if (settings.dndEnabled !== true) return false;
    const from = minutesOfDay(settings.dndFrom);
    const to = minutesOfDay(settings.dndTo);
    if (from == null || to == null || from === to) return false;
    const d = new Date(typeof now === 'number' ? now : Date.now());
    const cur = d.getHours() * 60 + d.getMinutes();
    return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to);
  }

  /** 免打扰时段文案 */
  function quietHoursText(notifications) {
    const settings = notifications || DEFAULT_NOTIFICATIONS;
    return settings.dndFrom + ' – ' + settings.dndTo;
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
   * @param {{title?:string, note?:string, priority?:string, categoryId?:string,
   *          reminder?:Object}} input  reminder 是控件的原始值（见 normalizeReminderInput）
   * @param {Array} [categories] 传了分类表就顺带校验分类是否存在
   * @param {number} [now] 判定"提醒时间是否已过去"的基准时刻（单测注入用）
   * @returns {{ok:boolean, errors:Object<string,string>, value:Object}}
   */
  function validate(input, categories, now) {
    const source = input || {};
    const at = typeof now === 'number' ? now : Date.now();
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

    // 提醒：可选；开启时把时间 / 结束条件的错误并进同一张 errors 表
    const reminder = normalizeReminderInput(source.reminder, at);
    if (!reminder.ok) Object.assign(errors, reminder.errors);

    return {
      ok: Object.keys(errors).length === 0,
      errors: errors,
      value: {
        title: title.slice(0, LIMIT.title),
        note: note.slice(0, LIMIT.note),
        priority: isPriority(source.priority) ? source.priority : 'normal',
        categoryId: categoryId || DEFAULT_CATEGORY_ID,
        reminder: reminder.value,
      },
    };
  }

  /* -------------------------------------------------------------- 增 / 改 */

  /** 由表单输入创建一条待办；校验失败时返回 {ok:false, errors} */
  function create(input, now, categories) {
    const at = typeof now === 'number' ? now : Date.now();
    const checked = validate(input, categories, at);
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
        reminder: checked.value.reminder,
      },
    };
  }

  /**
   * 保存时保留台账：日程（时间 / 提前量 / 重复）没变的，沿用已触发次数与上次触发时间，
   * 免得"改个标题"就把"已提醒过"的记录抹掉，导致重复提醒同一轮弹两次。
   */
  function mergeReminderLedger(prev, next) {
    if (!next) return null;
    if (!prev) return next;
    const same = prev.at === next.at && prev.advance === next.advance && prev.repeat === next.repeat;
    if (!same) return next;
    return Object.assign({}, next, {
      firedCount: prev.firedCount || 0,
      lastFiredAt: Number.isFinite(prev.lastFiredAt) ? prev.lastFiredAt : null,
    });
  }

  /** 用表单输入覆盖已有待办的文本字段、分类与提醒（不改状态） */
  function patch(todo, input, now, categories) {
    const at = typeof now === 'number' ? now : Date.now();
    const checked = validate(input, categories, at);
    if (!checked.ok) return { ok: false, errors: checked.errors };
    return {
      ok: true,
      todo: Object.assign({}, todo, {
        title: checked.value.title,
        note: checked.value.note,
        priority: checked.value.priority,
        categoryId: checked.value.categoryId,
        reminder: mergeReminderLedger(todo.reminder, checked.value.reminder),
        updatedAt: at,
      }),
    };
  }

  /**
   * 完成 / 恢复时按提醒自己的规则处置（reminder.onDone）：
   *   cancel（默认）→ 关闭提醒并记下原因；keep → 原样保留（重复提醒继续走）
   */
  function applyDonePolicy(todo, now) {
    const reminder = todo.reminder;
    if (!reminder || reminder.enabled !== true) return todo;
    if ((reminder.onDone || 'cancel') === 'keep') return todo;
    return Object.assign({}, todo, { reminder: cancelReminder(reminder, now, 'done') });
  }

  /** 恢复为未完成时，把"因完成而被自动取消"、且时间还没到的提醒重新打开 */
  function restoreReminder(todo, now) {
    const reminder = todo.reminder;
    const at = typeof now === 'number' ? now : Date.now();
    if (!reminder || reminder.enabled === true) return todo;
    if (reminder.cancelReason !== 'done') return todo;
    if (!Number.isFinite(reminder.at) || reminder.at <= at) return todo;
    return Object.assign({}, todo, {
      reminder: Object.assign({}, reminder, {
        enabled: true, cancelledAt: null, cancelReason: null,
      }),
    });
  }

  /** 状态流转：完成/恢复正常，doneAt 与 updatedAt 同步维护；提醒按 onDone 规则处置 */
  function setStatus(todo, status, now) {
    const at = typeof now === 'number' ? now : Date.now();
    if (!isStatus(status) || todo.status === status) return todo;
    const next = Object.assign({}, todo, {
      status: status,
      doneAt: status === 'done' ? at : null,
      updatedAt: at,
    });
    return status === 'done' ? applyDonePolicy(next, at) : restoreReminder(next, at);
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
        // 提醒：结构坏了就当作没设置（不猜测、不半还原）
        reminder: sanitizeReminder(item.reminder),
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
    // 提醒
    REMINDER_ADVANCES: REMINDER_ADVANCES, REMINDER_ADVANCE_LABEL: REMINDER_ADVANCE_LABEL,
    REMINDER_REPEATS: REMINDER_REPEATS, REMINDER_REPEAT_LABEL: REMINDER_REPEAT_LABEL,
    REMINDER_ENDS: REMINDER_ENDS, REMINDER_END_LABEL: REMINDER_END_LABEL,
    REMINDER_ON_DONE: REMINDER_ON_DONE, REMINDER_ON_DONE_LABEL: REMINDER_ON_DONE_LABEL,
    REMINDER_STATES: REMINDER_STATES, REMINDER_STATE_LABEL: REMINDER_STATE_LABEL,
    REMINDER_END_DETAIL: REMINDER_END_DETAIL, REMINDER_END_REASONS: REMINDER_END_REASONS,
    REMINDER_SOON_MS: REMINDER_SOON_MS, REMINDER_LIMIT: REMINDER_LIMIT, DAY_MS: DAY_MS,
    sanitizeReminder: sanitizeReminder, reminderDueAt: reminderDueAt,
    reminderActive: reminderActive, reminderState: reminderState, reminderPending: reminderPending,
    cancelReminder: cancelReminder, advanceReminder: advanceReminder,
    nextOccurrence: nextOccurrence, stepOccurrence: stepOccurrence,
    normalizeReminderInput: normalizeReminderInput, reminderForm: reminderForm,
    reminderStats: reminderStats, reminderQueue: reminderQueue,
    reminderTiming: reminderTiming, reminderAdvanceText: reminderAdvanceText,
    reminderRepeatText: reminderRepeatText, reminderSummary: reminderSummary,
    reminderChipText: reminderChipText,
    toLocalInput: toLocalInput, fromLocalInput: fromLocalInput, dayLabel: dayLabel,
    // 通知设置
    DEFAULT_NOTIFICATIONS: DEFAULT_NOTIFICATIONS, sanitizeNotifications: sanitizeNotifications,
    inQuietHours: inQuietHours, quietHoursText: quietHoursText, minutesOfDay: minutesOfDay,
  };
});


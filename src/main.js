/* =============================================================================
 * 待办中心 · 后端（txiki.js）
 * -----------------------------------------------------------------------------
 * 只做页面做不到的三件事，业务数据一律走页面的 tiny.store（per-app 数据目录）：
 *   1) info()          读运行时 / 主机信息，供底部状态栏显示；
 *   2) exportBackup()  把页面导出的 JSON 写进应用数据目录（真实文件系统访问）；
 *   3) 提醒调度        持有定时器与送达台账：
 *        - 页面把"哪些提醒该在什么时候弹"同步过来（syncReminders）；
 *        - 到点由这里发出系统通知（app.notify），并 app.push('reminder-due')
 *          通知页面更新状态；
 *        - 台账落盘（reminders.json），所以页面刷新、窗口关闭、应用重启后
 *          都能接着走：错过的会补发一条，重复提醒会推进到下一个周期。
 *
 * 边界（重要）：后端进程只在应用运行期间存在。应用完全退出后没有人能弹通知，
 * 因此"退出期间到点的提醒"在下次启动时以"补发"形式出现；要做到完全后台，
 * 需要用户开启登录时自动启动（见 README「提醒与通知」）。
 * ========================================================================== */

const encoder = new TextEncoder();

/** 台账文件名（写在 app.paths.data 里，与 todo.store 的数据文件同目录） */
const REMINDER_FILE = 'reminders.json';
/** 检查周期：15 秒一次。睡眠唤醒 / 时钟跳变后由"到点就补"的逻辑兜底 */
const REMINDER_TICK_MS = 15000;
/** 超过这个延迟才算"错过的提醒"（正常唤醒 / 忙时排队不算） */
const REMINDER_LATE_MS = 90 * 1000;
/** 忘记打开应用时，重复提醒可能积压很多轮；只补发最新一轮并说明"错过 N 次" */
const REMINDER_MAX_LOOP = 400;

/** 后端进程内的调度状态（与 reminders.json 一一对应） */
const runtime = {
  app: null,
  file: '',
  options: {
    enabled: true, sound: true, catchUp: true,
    dndEnabled: false, dndFrom: '22:00', dndTo: '08:00',
  },
  entries: [],
  timer: null,
};

/** 时间戳里不能出现的字符换成 '-'，得到一个可排序的文件名后缀 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 后端没有 Intl，时间自己补零：10-09 09:00 */
function clockText(ts) {
  const d = new Date(ts);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* ------------------------------------------------------- 重复规则（模型层镜像） */

/**
 * 与 src/frontend/js/model.js 的 stepOccurrence / nextOccurrence 同一套规则。
 * 后端不能 import 前端文件（打包后 / dev 下路径不同），所以这里是一份小镜像：
 * 改重复规则时两边都要改，tools/model.test.js 覆盖的是前端那份。
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

function nextOccurrence(from, repeat, after) {
  if (repeat !== 'daily' && repeat !== 'weekly' && repeat !== 'weekdays') return null;
  let next = from;
  for (let guard = 0; guard < REMINDER_MAX_LOOP; guard++) {
    next = stepOccurrence(next, repeat);
    if (next > after) return next;
  }
  return null;
}

/* ------------------------------------------------------------- 免打扰（镜像） */

/** 'HH:MM' → 当天分钟数；与 model.minutesOfDay 同一套规则 */
function minutesOfDay(text) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(text == null ? '' : text));
  if (!m) return null;
  const minutes = (+m[1]) * 60 + (+m[2]);
  return minutes >= 0 && minutes < 1440 ? minutes : null;
}

/** 免打扰时段内不弹系统横幅（应用内提示照旧），支持跨零点 */
function inQuietHours(options, now) {
  if (!options || options.dndEnabled !== true) return false;
  const from = minutesOfDay(options.dndFrom);
  const to = minutesOfDay(options.dndTo);
  if (from == null || to == null || from === to) return false;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to);
}

/* --------------------------------------------------------------- 日程与台账 */

/** 提醒时间 − 提前量 = 该弹通知的时刻 */
function dueAt(entry) {
  const advance = Number.isFinite(entry.advance) ? entry.advance : 0;
  return entry.at - advance * 60000;
}

/** 页面同步过来的条目 → 后端条目（字段白名单 + 类型兜底，脏数据不进定时器） */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (!Number.isFinite(raw.at)) return null;
  const repeat = (raw.repeat === 'daily' || raw.repeat === 'weekly' || raw.repeat === 'weekdays')
    ? raw.repeat : 'none';
  let endType = (raw.endType === 'count' || raw.endType === 'date') ? raw.endType : 'never';
  if (repeat === 'none') endType = 'never';
  return {
    id: raw.id,
    title: String(raw.title || '待办提醒'),
    category: String(raw.category || '未分类'),
    at: raw.at,
    advance: Number.isFinite(raw.advance) ? raw.advance : 0,
    repeat: repeat,
    endType: endType,
    endCount: Number.isFinite(raw.endCount) ? raw.endCount : null,
    endDate: Number.isFinite(raw.endDate) ? raw.endDate : null,
    onDone: raw.onDone === 'keep' ? 'keep' : 'cancel',
    enabled: raw.enabled !== false,
    firedCount: Number.isFinite(raw.firedCount) && raw.firedCount > 0 ? Math.floor(raw.firedCount) : 0,
    lastFiredAt: Number.isFinite(raw.lastFiredAt) ? raw.lastFiredAt : null,
    // 台账：哪一轮（at）已经送过。重复提醒滚动后 at 会变，所以必须记轮次而不是只看时间
    firedAt: Number.isFinite(raw.firedAt) ? raw.firedAt : null,
    cancelledAt: Number.isFinite(raw.cancelledAt) ? raw.cancelledAt : null,
    cancelReason: typeof raw.cancelReason === 'string' ? raw.cancelReason : null,
    nextAt: null,
  };
}

/** 页面侧的 reminder 形状（回推给页面时用，字段与 model.sanitizeReminder 对齐） */
function pageReminder(entry) {
  return {
    enabled: entry.enabled === true,
    at: entry.at,
    advance: entry.advance,
    repeat: entry.repeat,
    endType: entry.endType,
    endCount: entry.endCount,
    endDate: entry.endDate,
    onDone: entry.onDone,
    firedCount: entry.firedCount,
    lastFiredAt: entry.lastFiredAt,
    cancelledAt: entry.cancelledAt,
    cancelReason: entry.cancelReason,
  };
}

/**
 * 一轮走完之后推进日程：
 *   - 一次性提醒 → 停在原地（页面显示"已过期"，等用户处理），不再定时；
 *   - 重复提醒  → 推进到下一个"还没到"的周期（关闭期间积压的轮次直接跳过，
 *     避免一次弹几十条）；次数 / 日期条件达成时整条结束。
 */
function advance(entry, now) {
  const firedCount = (Number.isFinite(entry.firedCount) ? entry.firedCount : 0) + 1;
  const fired = Object.assign({}, entry, {
    lastFiredAt: now,
    firedAt: entry.at,        // 记下"这一轮送过了"
    firedCount: firedCount,
  });
  return rollForward(fired, now, firedCount);
}

/**
 * "当前这一轮已经送过了"吗。两条依据：
 *   1) 后端台账记过这一轮（firedAt === at）—— 重复提醒滚动后 at 会变，只能按轮次比；
 *   2) 页面台账盖过了这一轮（lastFiredAt ≥ 触发时刻）—— 页面刷新 / 窗口关过时用；
 *      页面只在日程没变时才保留这个值（model.mergeReminderLedger 重置过）。
 */
function isDelivered(entry) {
  // 后端有过送达记录 → 只认轮次（重复提醒滚动 / 积压多轮时，时间先后会骗人）
  if (Number.isFinite(entry.firedAt)) return entry.firedAt === entry.at;
  // 只有页面台账（后端刚启动 / 窗口先送过一次）→ 用触发时刻比
  return Number.isFinite(entry.lastFiredAt) && entry.lastFiredAt >= dueAt(entry);
}

/**
 * 滚动到下一轮（不动台账）：一次性提醒到此为止，重复提醒按条件决定是否结束。
 * @returns {{entry:Object, nextAt:number|null}} 结束时 nextAt 为 null 且 enabled=false
 */
function rollForward(entry, now, firedCount) {
  if (entry.repeat === 'none') return { entry: entry, nextAt: null };
  if (entry.endType === 'count' && firedCount >= (entry.endCount || 0)) {
    return { entry: Object.assign({}, entry, { enabled: false, cancelReason: 'series-end' }), nextAt: null };
  }
  const next = nextOccurrence(entry.at, entry.repeat, Math.max(now, entry.at));
  if (next == null) {
    return { entry: Object.assign({}, entry, { enabled: false, cancelReason: 'series-end' }), nextAt: null };
  }
  if (entry.endType === 'date' && Number.isFinite(entry.endDate) && next > entry.endDate) {
    return { entry: Object.assign({}, entry, { enabled: false, cancelReason: 'series-end' }), nextAt: null };
  }
  const moved = Object.assign({}, entry, { at: next });
  return { entry: moved, nextAt: next - moved.advance * 60000 };
}

/** 从某一轮开始、到 now 为止过去了多少个周期（用于"错过 N 次"的说明） */
function countOccurrences(from, repeat, now) {
  if (repeat === 'none' || !Number.isFinite(from)) return 0;
  let count = 0;
  let next = from;
  for (let guard = 0; guard < REMINDER_MAX_LOOP; guard++) {
    next = stepOccurrence(next, repeat);
    if (next > now) break;
    count++;
  }
  return count;
}

/**
 * 把一条日程推到"没有到点但还没送达的轮次"为止。
 * 关闭太久时，积压的轮次只计数不逐条弹（否则一次会来几十条通知）。
 * @returns {{entry:Object, nextAt:number|null, deliveries:Array, missed:number}}
 */
function processEntry(entry, now) {
  let current = Object.assign({}, entry);
  const deliveries = [];

  /** 一次投递里报给页面的"错过了几次"（只有一条投递，取第一条即可） */
  function missedCount() {
    return deliveries.length ? (deliveries[0].missed || 0) : 0;
  }

  for (let guard = 0; guard < REMINDER_MAX_LOOP; guard++) {
    if (current.enabled !== true) {
      return { entry: current, nextAt: null, deliveries: deliveries, missed: missedCount() };
    }

    const due = dueAt(current);

    // 这一轮已经送过 → 只推进，不重复弹（重复提醒滚动后 at 会变，所以按轮次判断）
    if (isDelivered(current)) {
      const rolled = rollForward(current, now, current.firedCount);
      current = rolled.entry;
      if (rolled.nextAt == null) {
        return { entry: current, nextAt: null, deliveries: deliveries, missed: missedCount() };
      }
      continue;
    }

    // 还没到点 → 交给定时器
    if (due > now) {
      return { entry: current, nextAt: due, deliveries: deliveries, missed: missedCount() };
    }

    // 到点但没送过：补一条（积压的轮次只计数，不逐条弹），然后直接滚动到未来
    const late = (now - due) > REMINDER_LATE_MS;
    deliveries.push({
      entry: current,
      due: due,
      at: current.at,
      late: late,
      missed: late ? countOccurrences(current.at, current.repeat, now) : 0,
    });
    current = advance(current, now).entry;
    if (current.enabled !== true) {
      return { entry: current, nextAt: null, deliveries: deliveries, missed: missedCount() };
    }
  }
  return {
    entry: current,
    nextAt: isDelivered(current) ? null : dueAt(current),
    deliveries: deliveries,
    missed: missedCount(),
  };
}

/* ------------------------------------------------------------- 通知与推送 */

/**
 * 组装并发出一次系统通知。
 * @param {Object} entry 投递**之后**（已推进）的日程 —— 推给页面写回台账的就是它：
 *                       `firedCount` / `lastFiredAt` 已更新，重复提醒的 `at` 已滚到下一轮，
 *                       整条结束的话 `enabled=false`
 * @param {Object} info  `at` = 刚刚触发的那个时刻（横幅副标题用；重复提醒滚动后与 entry.at 不同）、
 *                       `due` / `firedAt` / `late` / `missed` 供补发说明
 */
async function deliver(entry, info) {
  const app = runtime.app;
  const options = runtime.options;
  const firedAt = info && Number.isFinite(info.firedAt) ? info.firedAt : Date.now();
  const deliveredAt = info && Number.isFinite(info.at) ? info.at : entry.at;
  let skipped = null;
  if (options.enabled === false) skipped = 'disabled';
  else if (inQuietHours(options, firedAt)) skipped = 'quiet-hours';

  if (!skipped && app && typeof app.notify === 'function') {
    const subtitle = entry.category + ' · ' + clockText(deliveredAt);
    const body = (info && info.late)
      ? '错过的提醒（应用未运行时到点）' + (info.missed ? ' · 期间错过 ' + info.missed + ' 次' : '')
      : (entry.advance ? '提前 ' + entry.advance + ' 分钟提醒' : '到点提醒');
    try {
      await app.notify({
        title: entry.title, body: body, subtitle: subtitle,
        id: entry.id, sound: options.sound !== false,
      });
    } catch (e) {
      console.log('reminder notify failed:', e && e.message);
    }
  }

  // 页面侧：窗口关着也推（不可达时 push 是空操作），开着就即时更新 UI
  if (app && typeof app.push === 'function') {
    try {
      app.push('reminder-due', {
        id: entry.id,
        title: entry.title,
        category: entry.category,
        at: deliveredAt,
        dueAt: info && Number.isFinite(info.due) ? info.due : dueAt(entry),
        firedAt: firedAt,
        late: !!(info && info.late),
        missed: (info && info.missed) || 0,
        silent: !!skipped,
        skipped: skipped,
        // 推进之后的完整提醒状态：页面直接写回条目，不用等下一次同步
        reminder: pageReminder(entry),
      });
    } catch (e) {
      console.log('reminder push failed:', e && e.message);
    }
  }
  return !skipped;
}

/** 检查一轮：把到点的都处理掉，写台账并重挂定时器 */
async function check(now) {
  if (!runtime.entries.length) return { fired: 0 };
  const at = Number.isFinite(now) ? now : Date.now();
  let fired = 0;
  let changed = false;

  runtime.entries = runtime.entries.map(function (entry) {
    const result = processEntry(entry, at);
    if (result.deliveries.length) {
      changed = true;
      result.deliveries.forEach(function (item) {
        fired++;
        // 用"推进之后"的日程（result.entry）推送：页面据此写回
        // firedCount / lastFiredAt / 下一轮时间 / 是否已结束
        deliver(result.entry, {
          at: item.at, due: item.due, firedAt: at, late: item.late, missed: item.missed,
        }).catch(function (e) { console.log('reminder deliver failed:', e && e.message); });
      });
    }
    if (result.entry !== entry || result.nextAt !== entry.nextAt) changed = true;
    return Object.assign(result.entry, { nextAt: result.nextAt });
  });

  if (changed) {
    armTimer();
    await saveLedger();
  }
  return { fired: fired };
}

function armTimer() {
  const hasPending = runtime.entries.some(function (entry) { return entry.nextAt != null; });
  if (!hasPending) {
    if (runtime.timer) { clearInterval(runtime.timer); runtime.timer = null; }
    return;
  }
  if (runtime.timer) return;
  runtime.timer = setInterval(function () {
    check().catch(function (e) { console.log('reminder tick failed:', e && e.message); });
  }, REMINDER_TICK_MS);
}

/* ------------------------------------------------------------------ 落盘 */

async function ledgerPath() {
  if (runtime.file) return runtime.file;
  const app = runtime.app;
  const dir = (app && app.paths && app.paths.data) || tjs.homeDir;
  await tjs.makeDir(dir, { recursive: true }).catch(function () {});
  runtime.file = dir + '/' + REMINDER_FILE;
  return runtime.file;
}

async function saveLedger() {
  try {
    const path = await ledgerPath();
    await tjs.writeFile(path, JSON.stringify({
      version: 1, savedAt: Date.now(), options: runtime.options, entries: runtime.entries,
    }, null, 2));
    return true;
  } catch (e) {
    console.log('reminder ledger write failed:', e && e.message);
    return false;
  }
}

/** 启动时先读回上次的台账：页面还没同步过来之前就知道"上次排到哪了" */
async function loadLedger() {
  try {
    const text = await tjs.readFile(await ledgerPath(), 'utf8');
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.entries)) return false;
    if (data.options && typeof data.options === 'object') {
      runtime.options = Object.assign({}, runtime.options, data.options);
    }
    runtime.entries = data.entries.map(normalizeEntry).filter(Boolean);
    return true;
  } catch (_e) {
    return false;   // 首次运行 / 文件损坏：当作没有台账，等页面同步
  }
}

export const api = {
  /** 运行时信息：状态栏尾注 + 备份目录位置 */
  async info(_params, app) {
    const cpus = tjs.system.cpus;
    return {
      runtime: 'txiki.js ' + tjs.version,
      host: tjs.hostName,
      user: tjs.system.userInfo.userName,
      cpu: cpus[0].model + ' × ' + cpus.length,
      pid: tjs.pid,
      data: (app && app.paths && app.paths.data) || '',
    };
  },

  /**
   * 导出备份：写一份带时间戳的 JSON 到应用数据目录，返回路径给页面提示 / 定位。
   * 内容由页面组装（它是数据的唯一所有者），后端只负责落盘。
   */
  async exportBackup({ data }, app) {
    if (!data || typeof data !== 'object') {
      throw new Error('exportBackup: 缺少 data');
    }
    const dir = (app && app.paths && app.paths.data) || tjs.homeDir;
    await tjs.makeDir(dir, { recursive: true }).catch(() => {});

    const path = dir + '/todo-backup-' + stamp() + '.json';
    const text = JSON.stringify(data, null, 2);
    await tjs.writeFile(path, text);

    return {
      path,
      bytes: encoder.encode(text).byteLength,
      items: Array.isArray(data.items) ? data.items.length : 0,
    };
  },

  /**
   * 同步提醒日程（页面是数据的拥有者，数据 / 设置一变就整体推一次）。
   * - 不在名单里的提醒会被撤掉（删除待办、取消提醒、完成后按规则取消）；
   * - 台账（lastFiredAt / firedCount）两边取新的，避免"页面刷新把已触发记录抹掉"；
   * - 推完立刻检查一次：关闭期间过期的提醒就在这里补发。
   */
  async syncReminders({ list, options } = {}, app) {
    if (app) runtime.app = app;
    runtime.options = mergeOptions(options);

    const previous = {};
    runtime.entries.forEach(function (entry) { previous[entry.id] = entry; });

    runtime.entries = (Array.isArray(list) ? list : []).map(normalizeEntry).filter(Boolean)
      .map(function (entry) {
        const old = previous[entry.id];
        if (!old) return entry;
        // 后端记过"正是这一轮"，说明页面这次同步带的是旧数据（刷新 / 窗口关过）→ 继承台账；
        // 日程被改过（轮次对不上）→ 送达标记清空，但次数沿用较大的一个（次数条件不能倒退）
        const sameOccurrence = Number.isFinite(old.firedAt) && old.firedAt === entry.at;
        return Object.assign(entry, {
          firedAt: sameOccurrence ? entry.at : null,
          lastFiredAt: sameOccurrence
            ? (Math.max(entry.lastFiredAt || 0, old.lastFiredAt || 0) || null)
            : entry.lastFiredAt,
          firedCount: Math.max(entry.firedCount || 0, old.firedCount || 0),
        });
      });

    const result = await check(Date.now());
    armTimer();
    await saveLedger();
    return { ok: true, now: Date.now(), fired: result.fired, entries: snapshot() };
  },

  /** 读当前日程 + 台账（页面重开后用它对齐"关闭期间发生了什么"） */
  async reminderState(_params, app) {
    if (app) runtime.app = app;
    return { ok: true, now: Date.now(), options: runtime.options, entries: snapshot() };
  },

  /** 清空日程（没有提醒时 / 重置数据时） */
  async clearReminders(_params, app) {
    if (app) runtime.app = app;
    runtime.entries = [];
    if (runtime.timer) { clearInterval(runtime.timer); runtime.timer = null; }
    await saveLedger();
    return { ok: true, entries: [] };
  },

  /** 「发送测试通知」：绕过免打扰与总开关，直接验证系统通知这条链路 */
  async testNotification({ title, body } = {}, app) {
    if (app) runtime.app = app;
    const target = app || runtime.app;
    if (!target || typeof target.notify !== 'function') return { ok: false, reason: 'unsupported' };
    try {
      await target.notify({
        title: title || '待办中心',
        body: body || '这是一条测试通知：到点时会这样提醒你。',
        subtitle: '测试通知',
        sound: runtime.options.sound !== false,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  },
};

/** 通知设置白名单：只接受认识的字段，其余保持当前值 */
function mergeOptions(raw) {
  const out = Object.assign({}, runtime.options);
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.sound === 'boolean') out.sound = raw.sound;
  if (typeof raw.catchUp === 'boolean') out.catchUp = raw.catchUp;
  if (typeof raw.dndEnabled === 'boolean') out.dndEnabled = raw.dndEnabled;
  if (/^\d{2}:\d{2}$/.test(String(raw.dndFrom || ''))) out.dndFrom = raw.dndFrom;
  if (/^\d{2}:\d{2}$/.test(String(raw.dndTo || ''))) out.dndTo = raw.dndTo;
  return out;
}

/** 给页面的日程快照：页面用它把"提醒时间 / 台账"写回条目 */
function snapshot() {
  return runtime.entries.map(function (entry) {
    return {
      id: entry.id,
      at: entry.at,
      nextAt: entry.nextAt,
      lastFiredAt: entry.lastFiredAt,
      firedCount: entry.firedCount,
      enabled: entry.enabled,
      cancelReason: entry.cancelReason,
      reminder: pageReminder(entry),
    };
  });
}

/** 启动：读回台账 → 先补一次"关闭期间到点"的提醒 → 挂定时器 */
export async function init(app) {
  runtime.app = app;
  try {
    await loadLedger();
    await check(Date.now());
    armTimer();
  } catch (e) {
    console.log('reminder init failed:', e && e.message);
  }
}

/** 点击系统通知（id 就是待办 id）→ 让页面聚焦窗口、跳到那条并高亮 */
export function onNotificationClick(id, app) {
  const target = app || runtime.app;
  if (!target || typeof target.push !== 'function') return;
  try { target.push('reminder-open', { id: id }); }
  catch (_e) { /* 没有窗口时忽略：系统点通知本身已经激活了应用 */ }
}

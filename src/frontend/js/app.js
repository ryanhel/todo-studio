/* =============================================================================
 * 待办中心 · 控制器
 * -----------------------------------------------------------------------------
 * 职责：唯一的状态真相（state）+ 唯一的数据写入口（persist*）+ 事件委托。
 * 视图层只画 DOM，不碰数据；模型层只算数据，不碰 DOM。
 *
 * 面板四种模式：view | add | edit | delete
 * 草稿策略：输入中的内容挂在 state.draft 上并标记 dirty；任何模式切换都不会
 *           清掉它，横幅与"未保存"角标负责提示，用户显式取消/放弃才丢弃。
 * ========================================================================== */
(function (root) {
  'use strict';

  const NS = (root.TodoApp = root.TodoApp || {});
  const model = NS.model;
  const ui = NS.ui;
  const bridge = NS.bridge;

  /* ------------------------------------------------------------------ 状态 */

  const UI_DEFAULTS = {
    themeMode: 'system',              // light | dark | system（跟随系统）
    listCollapsed: false,
    collapsedCategories: {},          // categoryId -> true，折叠的分类分组
    focusCategoryId: null,            // 非空 = 只看这个分类（分类维度筛选）
    expanded: {},                     // todoId -> true，展开摘要的条目
    filter: 'all',                    // all | open | done（状态维度筛选）
    selectedId: null,
    lastCategoryId: null,             // 新建表单预选"上次用过的分类"
  };

  const state = {
    ready: false,
    items: [],
    categories: [],
    ui: JSON.parse(JSON.stringify(UI_DEFAULTS)),
    mode: 'view',     // view | add | edit | delete | categories | settings
    draft: null,      // { mode:'add'|'edit', id, title, values:{title,note,priority,categoryId,reminder}, dirty }
    errors: {},
    pendingCategoryDelete: null,   // 分类删除的二次确认对象
    categoryError: '',             // 分类表单（新增 / 重命名）的错误文案
    systemDark: true,              // 系统当前是否深色；system 模式据此解析
    env: null,
    store: null,
    // 提醒与通知
    settings: { notifications: JSON.parse(JSON.stringify(model.DEFAULT_NOTIFICATIONS)) },
    permission: { state: 'unknown' },   // granted | denied | undetermined | unsupported | unknown
    loginItem: null,                    // 登录时自动启动：true / false / null（未知）
    caps: null,                         // tiny.system.capabilities()（判 notifications 支持）
    packaged: false,                    // 是否运行在打包后的 .app 里（dev 下 tinyjs 字段是 'dev'）
    highlightId: null,                  // 刚触发提醒的条目：列表里高亮几秒
    highlightTimer: null,
    dueDismissed: false,                // 到点横幅被"知道了"收起的当前会话状态
    reminderTimer: null,                // 页面侧定时刷新（状态随时间变化）
    syncTimer: null,                    // 同步防抖
    reminderFired: 0,                   // 本次会话收到过多少次到点推送
  };

  /* -------------------------------------------------------- 状态派生 / 工具 */

  /** 把磁盘上的 UI 状态归一化：任何字段坏了都退化成默认值 */
  function sanitizeUi(raw) {
    const out = JSON.parse(JSON.stringify(UI_DEFAULTS));
    if (!raw || typeof raw !== 'object') return out;

    out.themeMode = (raw.themeMode === 'light' || raw.themeMode === 'dark' || raw.themeMode === 'system')
      ? raw.themeMode : UI_DEFAULTS.themeMode;
    out.listCollapsed = !!raw.listCollapsed;
    out.filter = (raw.filter === 'open' || raw.filter === 'done' || raw.filter === 'all')
      ? raw.filter : 'all';
    out.selectedId = typeof raw.selectedId === 'string' ? raw.selectedId : null;
    out.focusCategoryId = typeof raw.focusCategoryId === 'string' ? raw.focusCategoryId : null;
    out.lastCategoryId = typeof raw.lastCategoryId === 'string' ? raw.lastCategoryId : null;

    if (raw.collapsedCategories && typeof raw.collapsedCategories === 'object') {
      Object.keys(raw.collapsedCategories).forEach(function (id) {
        if (raw.collapsedCategories[id]) out.collapsedCategories[id] = true;
      });
    }
    if (raw.expanded && typeof raw.expanded === 'object') {
      Object.keys(raw.expanded).forEach(function (id) {
        if (raw.expanded[id]) out.expanded[id] = true;
      });
    }
    return out;
  }

  /** 当前实际生效的主题：system 模式解析成 light / dark */
  function resolvedTheme() {
    if (state.ui.themeMode === 'system') return state.systemDark ? 'dark' : 'light';
    return state.ui.themeMode;
  }

  /** 交给视图层的只读视图对象（视图层不引用 state） */
  function view() {
    const countsByCategory = Object.create(null);
    state.categories.forEach(function (category) {
      countsByCategory[category.id] = model.countBy(
        state.items.filter(function (todo) { return todo.categoryId === category.id; }));
    });

    return {
      items: state.items,
      categories: state.categories,
      countsByCategory: countsByCategory,
      ui: state.ui,
      stats: model.stats(state.items),
      selected: model.byId(state.items, state.ui.selectedId),
      selectedId: state.ui.selectedId,
      expanded: state.ui.expanded,
      collapsedCategories: state.ui.collapsedCategories,
      focusCategoryId: state.ui.focusCategoryId,
      themeMode: state.ui.themeMode,
      resolvedTheme: resolvedTheme(),
      mode: state.mode,
      draft: state.draft,
      draftDirty: !!(state.draft && state.draft.dirty),
      errors: state.errors,
      pendingCategoryDelete: state.pendingCategoryDelete,
      categoryError: state.categoryError,
      // 提醒与通知（视图层只读这几个字段）
      now: Date.now(),
      highlightId: state.highlightId,
      dueDismissed: state.dueDismissed,
      reminderStats: model.reminderStats(state.items, Date.now()),
      reminderQueue: model.reminderQueue(state.items, Date.now()),
      notifications: state.settings.notifications,
      permission: state.permission,
      loginItem: state.loginItem,
    };
  }

  function render() {
    ui.render(view());
    syncWindowTitle();
  }

  /** 窗口标题带未完成计数，菜单栏 / Dock 一眼可见 */
  function syncWindowTitle() {
    const stats = model.stats(state.items);
    bridge.setTitle(NS.const.APP_NAME + ' · ' + stats.open + ' 项未完成');
  }

  /** 写盘点：列表数据（带成功 / 失败提示） */
  async function persistItems(successMessage) {
    const ok = await state.store.saveItems(state.items);
    if (!ok) {
      ui.toast('error', '保存失败：' + (state.store.lastError() || '未知错误'));
      return false;
    }
    if (successMessage) ui.toast('success', successMessage);
    return true;
  }

  /** 写盘点：界面状态（折叠 / 选中 / 筛选）。失败只在状态灯体现，不打扰用户 */
  async function persistUi() {
    const live = {};
    state.items.forEach(function (todo) {
      if (state.ui.expanded[todo.id]) live[todo.id] = true;   // 顺带清理已删除条目的残留
    });
    const collapsed = {};
    state.categories.forEach(function (category) {
      if (state.ui.collapsedCategories[category.id]) collapsed[category.id] = true;
    });
    const snapshot = Object.assign({}, state.ui, { expanded: live, collapsedCategories: collapsed });
    state.ui.expanded = live;
    state.ui.collapsedCategories = collapsed;
    await state.store.saveUi(snapshot);
  }

  function select(id) {
    state.ui.selectedId = id;
    state.mode = 'view';
    render();
    persistUi();
  }
  /* ------------------------------------------------------------ 动作：外观 */

  /** 把解析后的主题写到 <html data-theme>，并同步原生菜单的勾选 */
  function applyTheme() {
    const resolved = resolvedTheme();
    doc.documentElement.setAttribute('data-theme', resolved);
    doc.documentElement.setAttribute('data-theme-mode', state.ui.themeMode);
    syncMenuChecks();
    return resolved;
  }

  /**
   * 设置外观模式：light / dark / system；选择随 todo.ui.v1 持久化，
   * 刷新页面、重开应用都沿用（system 表示继续跟随系统）。
   * viaToggle = true 表示来自顶栏那颗单按钮，用于在提示里点明"已退出跟随系统"。
   */
  function setThemeMode(mode, viaToggle) {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return;
    const previous = state.ui.themeMode;
    const changed = previous !== mode;
    state.ui.themeMode = mode;
    const resolved = applyTheme();
    render();
    if (!changed) return;

    const label = { light: '浅色', dark: '深色', system: '跟随系统' }[mode];
    let suffix = '';
    if (mode === 'system') suffix = '（系统当前为' + (resolved === 'light' ? '浅色' : '深色') + '）';
    else if (viaToggle && previous === 'system') suffix = '（已退出跟随系统）';
    ui.toast('info', '外观已切换：' + label + suffix);
    persistUi();
  }

  /**
   * 顶栏唯一的外观按钮：切到"当前所见外观"的反面，并退出跟随系统。
   *  - 跟随系统时：先看系统解析结果，切它的反面，并把这个显式选择记下来
   *  - 显式浅色 / 深色时：在两档之间来回切换
   * 之后系统主题再变也不影响页面；想回到自动走菜单栏「外观：跟随系统」。
   */
  function toggleTheme() {
    setThemeMode(resolvedTheme() === 'dark' ? 'light' : 'dark', true);
  }

  /**
   * 订阅系统外观变化 —— 跟随系统时实时生效，无需刷新：
   *  1) tiny.theme.on 是 tinyjs launcher 主动推送的变更（首选）
   *  2) matchMedia 媒体查询兜底（浏览器预览 / 推送不可用时）
   * 只有 system 模式会改变实际外观；显式选浅色或深色时系统变化不影响页面。
   */
  function watchSystemTheme() {
    function handle(dark) {
      const next = !!dark;
      if (state.systemDark === next) return;
      state.systemDark = next;
      if (state.ui.themeMode === 'system') {
        applyTheme();
        render();
        if (state.ready) ui.toast('info', '系统外观变化：已切到' + (next ? '深色' : '浅色'));
      }
    }
    bridge.onSystemTheme(handle);
    bridge.systemDark().then(function (dark) {
      state.systemDark = !!dark;
      applyTheme();
      if (state.ready) render();
    });
  }

  /* ------------------------------------------------------------ 动作：折叠 */

  function toggleList() {
    state.ui.listCollapsed = !state.ui.listCollapsed;
    render();
    persistUi();
  }

  /** 分类分组折叠（分类维度的折叠，与整表折叠是两件事） */
  function toggleCategoryCollapse(id) {
    if (!id) return;
    if (state.ui.collapsedCategories[id]) delete state.ui.collapsedCategories[id];
    else state.ui.collapsedCategories[id] = true;
    render();
    persistUi();
  }

  /* ------------------------------------------------------------ 动作：分类 */

  async function persistCategories(message) {
    const ok = await state.store.saveCategories(state.categories);
    if (!ok) {
      ui.toast('error', '分类保存失败：' + (state.store.lastError() || '未知错误'));
      return false;
    }
    if (message) ui.toast('success', message);
    return true;
  }

  /** 新分类优先用没被占用的颜色槽位 */
  function nextUnusedColor() {
    const used = state.categories.map(function (category) { return category.color; });
    const free = model.CATEGORY_COLORS.filter(function (color) { return used.indexOf(color) < 0; });
    return free[0] || model.CATEGORY_COLORS[state.categories.length % model.CATEGORY_COLORS.length];
  }

  async function addCategory(name) {
    const checked = model.validateCategoryName(name, state.categories, null);
    if (!checked.ok) {
      state.categoryError = checked.errors.name;
      render();
      ui.shake(ui.refs['panel-content'].querySelector('#f-new-cat'));
      ui.toast('error', checked.errors.name);
      return false;
    }
    const category = model.makeCategory(checked.value, nextUnusedColor());
    state.categories = state.categories.concat([category]);
    state.categoryError = '';
    render();
    await persistCategories('已新增分类：' + category.name);
    return true;
  }

  async function renameCategory(id, name) {
    const category = model.categoryById(state.categories, id);
    if (!category) return false;

    const checked = model.validateCategoryName(name, state.categories, id);
    if (!checked.ok) {
      state.categoryError = checked.errors.name;
      render();
      ui.toast('error', checked.errors.name);
      return false;
    }
    if (checked.value === category.name) {
      state.categoryError = '';
      render();
      return true;
    }

    state.categories = state.categories.map(function (item) {
      return item.id === id ? Object.assign({}, item, { name: checked.value }) : item;
    });
    state.categoryError = '';
    render();
    await persistCategories('分类已重命名：' + checked.value);
    return true;
  }

  async function cycleCategoryColor(id) {
    const category = model.categoryById(state.categories, id);
    if (!category) return false;
    const next = model.nextCategoryColor(category.color);
    state.categories = state.categories.map(function (item) {
      return item.id === id ? Object.assign({}, item, { color: next }) : item;
    });
    render();
    const ok = await persistCategories();
    if (ok) ui.toast('info', '「' + category.name + '」改为 ' + model.CATEGORY_COLOR_NAME[next]);
    return ok;
  }

  function askDeleteCategory(id) {
    const category = model.categoryById(state.categories, id);
    if (!category) return;
    if (category.builtin) {
      ui.toast('error', '「默认」是兜底分类，不能删除');
      return;
    }
    state.pendingCategoryDelete = id;
    render();
  }

  function cancelDeleteCategory() {
    state.pendingCategoryDelete = null;
    render();
  }

  /** 删除分类：其条目先转入默认分类，再移除分类本身（两步都落盘） */
  async function confirmDeleteCategory(id) {
    const category = model.categoryById(state.categories, id || state.pendingCategoryDelete);
    if (!category || category.builtin) {
      state.pendingCategoryDelete = null;
      render();
      return false;
    }

    const moved = state.items.filter(function (todo) { return todo.categoryId === category.id; }).length;
    state.categories = state.categories.filter(function (item) { return item.id !== category.id; });
    state.items = model.assignCategories(state.items, state.categories);
    if (state.ui.focusCategoryId === category.id) state.ui.focusCategoryId = null;
    if (state.ui.lastCategoryId === category.id) state.ui.lastCategoryId = model.DEFAULT_CATEGORY_ID;
    delete state.ui.collapsedCategories[category.id];
    state.pendingCategoryDelete = null;
    state.categoryError = '';
    render();

    await persistItems();
    await persistCategories('已删除分类「' + category.name + '」' +
      (moved ? '，' + moved + ' 条转入默认' : ''));
    return true;
  }

  /** "只看某分类"：再点一次取消（分类维度的筛选） */
  function setFocusCategory(id) {
    state.ui.focusCategoryId = state.ui.focusCategoryId === id ? null : id;
    render();
    persistUi();
    const category = state.ui.focusCategoryId
      ? model.categoryById(state.categories, state.ui.focusCategoryId) : null;
    if (category) ui.toast('info', '只看「' + category.name + '」');
  }

  /** 表单里切换分类 */
  function setDraftCategory(id) {
    if (!state.draft || !model.categoryById(state.categories, id)) return;
    state.draft.values.categoryId = id;
    state.draft.dirty = true;
    render();
    const pill = ui.refs['panel-content'].querySelector('.cat-pill.is-active');
    if (pill) pill.focus();
  }

  function toggleItemExpanded(id) {
    if (!id) return;
    if (state.ui.expanded[id]) delete state.ui.expanded[id];
    else state.ui.expanded[id] = true;
    render();
    persistUi();
  }

  function setFilter(filter) {
    if (filter !== 'all' && filter !== 'open' && filter !== 'done') return;
    state.ui.filter = filter;
    render();
    persistUi();
  }

  /* ------------------------------------------------------ 动作：面板四模式 */

  function startAdd() {
    // 已有未保存的"新建"草稿时不覆盖它，直接回到那份草稿继续写
    const draft = state.draft;
    if (!(draft && draft.dirty && draft.mode === 'add')) {
      state.draft = {
        mode: 'add', id: null, title: '',
        values: {
          title: '', note: '', priority: 'normal',
          // 默认分类：优先用"上次用过的分类"，其次默认分类（表单仍可改）
          categoryId: model.resolveCategoryId(state.ui.lastCategoryId, state.categories),
          reminder: model.reminderForm(null),   // 默认关闭；打开时默认"一小时后"
        },
        dirty: false,
      };
    }
    state.mode = 'add';
    state.errors = {};
    render();
    ui.focusField('title');
  }

  function startEdit(id) {
    const todo = model.byId(state.items, id || state.ui.selectedId);
    if (!todo) { ui.toast('error', '请先选择一条待办'); return; }

    const draft = state.draft;
    const keep = !!(draft && draft.dirty && draft.mode === 'edit' && draft.id === todo.id);
    if (!keep) {
      state.draft = {
        mode: 'edit', id: todo.id, title: todo.title,
        values: {
          title: todo.title, note: todo.note, priority: todo.priority,
          categoryId: model.resolveCategoryId(todo.categoryId, state.categories),
          reminder: model.reminderForm(todo.reminder),   // 已设置的提醒回填到表单
        },
        dirty: false,
      };
    }
    state.ui.selectedId = todo.id;
    state.mode = 'edit';
    state.errors = {};
    render();
    ui.focusField('title');
  }

  function askDelete(id) {
    const todo = model.byId(state.items, id || state.ui.selectedId);
    if (!todo) { ui.toast('error', '请先选择一条待办'); return; }
    state.ui.selectedId = todo.id;
    state.mode = 'delete';
    state.errors = {};
    render();
  }

  function resumeDraft() {
    const draft = state.draft;
    if (!draft) return;
    if (draft.mode === 'add') {
      state.mode = 'add';
    } else {
      state.ui.selectedId = draft.id;
      state.mode = 'edit';
    }
    render();
    ui.focusField('title');
  }

  function discardDraft(silent) {
    const had = !!(state.draft && state.draft.dirty);
    state.draft = null;
    state.errors = {};
    if (state.mode === 'add' || state.mode === 'edit') state.mode = 'view';
    render();
    if (had && !silent) ui.toast('info', '已放弃未保存的草稿');
  }
  /* ---------------------------------------------------------- 动作：写数据 */

  /**
   * 表单里的提醒输入（DOM 是"正在输入"的真相来源，草稿是兜底）：
   * 摊平成 model.normalizeReminderInput 认识的形状；keepAt 让"已到点的原时间"能原样保存。
   */
  function reminderInputFromForm() {
    const content = ui.refs['panel-content'];
    const draft = state.draft;
    const base = (draft && draft.values.reminder) ? draft.values.reminder : model.reminderForm(null);
    const stored = draft && draft.id ? model.byId(state.items, draft.id) : null;
    const storedReminder = stored ? stored.reminder : null;

    function node(field) { return content.querySelector('[data-field="' + field + '"]'); }
    const on = node('reminderEnabled');
    const at = node('reminderAt');
    const advance = node('reminderAdvance');
    const repeat = node('reminderRepeat');
    const endType = node('reminderEndType');
    const endCount = node('reminderEndCount');
    const endDate = node('reminderEndDate');
    const onDone = node('reminderOnDone');

    return {
      enabled: on ? !!on.checked : !!base.enabled,
      atText: at ? at.value : base.atText,
      advance: advance ? Number(advance.value) : base.advance,
      repeat: repeat ? repeat.value : base.repeat,
      endType: endType ? endType.value : base.endType,
      endCount: endCount ? Number(endCount.value) : base.endCount,
      endDateText: endDate ? endDate.value : base.endDateText,
      onDone: onDone ? onDone.value : base.onDone,
      keepAt: storedReminder ? storedReminder.at : null,
    };
  }

  /** 表单值是"正在输入"的真相来源：优先读 DOM，其次读草稿 */
  function readFormValues() {
    const content = ui.refs['panel-content'];
    const titleNode = content.querySelector('[data-field="title"]');
    const noteNode = content.querySelector('[data-field="note"]');
    const fallback = state.draft
      ? state.draft.values
      : { title: '', note: '', priority: 'normal', categoryId: '' };
    return {
      title: titleNode ? titleNode.value : fallback.title,
      note: noteNode ? noteNode.value : fallback.note,
      priority: state.draft ? state.draft.values.priority : 'normal',
      categoryId: state.draft ? state.draft.values.categoryId : '',
      reminder: reminderInputFromForm(),
    };
  }

  async function saveForm() {
    const values = readFormValues();
    // 空值 / 超长 / 非法优先级 / 分类是否选中，全在模型层判定
    const checked = model.validate(values, state.categories);

    if (!checked.ok) {
      state.errors = checked.errors;
      render();
      const firstKey = Object.keys(checked.errors)[0];
      ui.shake(ui.refs['panel-content'].querySelector('[data-field="' + firstKey + '"]'));
      ui.toast('error', checked.errors[firstKey]);
      ui.focusField(firstKey);
      return false;
    }

    state.errors = {};

    /** 保存成功后统一收尾：记住这次用的分类（供下次新建预选） */
    function remember(result) {
      state.ui.lastCategoryId = result.categoryId;
      persistUi();
      scheduleReminderSync();          // 表单里可能开了 / 改了 / 关掉了提醒
      const category = model.categoryById(state.categories, result.categoryId);
      return category ? '（' + category.name + '）' : '';
    }

    /** 保存提示里顺带说明提醒状态：设上了 / 已提醒过 / 已结束 / 什么时间弹 */
    function reminderSuffix(todo) {
      if (!todo.reminder) return '';
      const state = model.reminderState(todo.reminder, Date.now());
      if (state.key === 'done' || state.key === 'ended' || state.key === 'off') {
        return ' · 提醒' + state.label + (state.detail ? '（' + state.detail + '）' : '');
      }
      return ' · 提醒 ' + model.reminderTiming(todo.reminder, Date.now()) +
        (todo.reminder.repeat !== 'none' ? '（' + model.reminderRepeatText(todo.reminder) + '）'
          : (todo.reminder.advance ? '（' + model.reminderAdvanceText(todo.reminder) + '）' : ''));
    }

    if (state.mode === 'edit' && state.draft && state.draft.id) {
      const target = model.byId(state.items, state.draft.id);
      if (!target) {
        ui.toast('error', '这条待办已不存在，草稿已放弃');
        discardDraft(true);
        return false;
      }
      const result = model.patch(target, checked.value, Date.now(), state.categories);
      if (!result.ok) { state.errors = result.errors; render(); return false; }
      state.items = model.replace(state.items, result.todo);
      state.ui.selectedId = result.todo.id;
      const suffix = remember(result.todo);
      state.draft = null;
      state.mode = 'view';
      render();
      await persistItems('已保存修改：' + result.todo.title + suffix + reminderSuffix(result.todo));
      ensureNotifyPermission(result.todo);
      return true;
    }

    const created = model.create(checked.value, Date.now(), state.categories);
    if (!created.ok) { state.errors = created.errors; render(); return false; }
    state.items = model.add(state.items, created.todo);
    state.ui.selectedId = created.todo.id;
    const suffix = remember(created.todo);
    state.draft = null;
    state.mode = 'view';
    render();
    await persistItems('已创建：' + created.todo.title + suffix + reminderSuffix(created.todo));
    ensureNotifyPermission(created.todo);
    return true;
  }
  async function confirmDelete(id) {
    const todo = model.byId(state.items, id || state.ui.selectedId);
    if (!todo) {
      ui.toast('error', '这条待办已不存在');
      state.mode = 'view';
      render();
      return false;
    }
    state.items = model.remove(state.items, todo.id);
    if (state.ui.selectedId === todo.id) state.ui.selectedId = null;
    if (state.draft && state.draft.id === todo.id) state.draft = null;
    delete state.ui.expanded[todo.id];
    state.mode = 'view';
    render();
    scheduleReminderSync();      // 条目没了，它的日程也要从后端撤掉
    await persistItems('已删除：' + todo.title);
    return true;
  }

  /**
   * 勾选完成 / 恢复未完成。提醒的处置在模型层按 reminder.onDone 决定：
   *   cancel（默认）→ 关闭提醒（详情里显示"已取消（完成时自动取消）"）
   *   keep          → 保留（重复提醒继续走）
   * 恢复为未完成时，把"因完成而取消、时间还没到"的提醒自动打开。
   */
  async function toggleStatus(id) {
    const todo = model.byId(state.items, id || state.ui.selectedId);
    if (!todo) return false;
    const wasActive = model.reminderActive(todo.reminder);
    const next = model.setStatus(todo, todo.status === 'done' ? 'open' : 'done');
    state.items = model.replace(state.items, next);
    render();

    let note = '';
    if (wasActive && !model.reminderActive(next.reminder) && next.reminder) {
      note = next.reminder.cancelReason === 'done' ? '（提醒已结束）' : '（提醒已结束：重复走完）';
    } else if (wasActive) {
      note = '（提醒保留：完成后仍会提醒）';
    } else if (!wasActive && model.reminderActive(next.reminder)) {
      note = '（提醒已恢复）';
    }

    scheduleReminderSync();
    const ok = await persistItems(next.status === 'done'
      ? '已完成：' + next.title + note
      : '已恢复为未完成：' + next.title + note);
    return ok;
  }

  /** 导出备份：后端写文件到应用数据目录，并在访达中定位 */
  async function exportBackup() {
    const payload = {
      app: 'todo',
      version: NS.const.VERSION,
      exportedAt: new Date().toISOString(),
      items: state.items,
      ui: state.ui,
    };
    if (!bridge.available) {
      ui.toast('info', '浏览器预览模式：未写入磁盘');
      return null;
    }
    try {
      const result = await bridge.call('exportBackup', { data: payload });
      const path = result && result.path;
      ui.toast('success', '已导出备份：' + (path || '应用数据目录'));
      if (path) bridge.reveal(path);
      return path;
    } catch (error) {
      ui.toast('error', '导出失败：' + error);
      return null;
    }
  }
  /* ------------------------------------------------------ 事件：输入与草稿 */

  const doc = root.document;

  function setCounter(fieldId, length, max) {
    const node = ui.refs['panel-content'].querySelector('[data-counter="' + fieldId + '"]');
    if (node) node.textContent = length + ' / ' + max;
  }

  /** 角标 + 横幅跟随草稿的 dirty 状态；输入过程中就地更新，不整树重绘 */
  function setDirtyIndicator() {
    const dirty = !!(state.draft && state.draft.dirty);
    const content = ui.refs['panel-content'];
    const chip = content.querySelector('.dirty-chip');

    if (dirty && !chip) {
      const host = content.querySelector('.panel-title-row');
      if (host) host.appendChild(ui.el('span', { class: 'dirty-chip', id: 'dirty-chip', text: '未保存' }));
    } else if (!dirty && chip && chip.remove) {
      chip.remove();
    }
    ui.renderBanner(view());
  }

  /**
   * 把表单里的一格提醒输入写进草稿（返回 false 表示不是提醒字段）。
   * 结构变化由调用方决定要不要重绘：输入过程中不重绘（见 onInput）。
   */
  function applyReminderField(field, value) {
    const draft = state.draft;
    if (!draft) return false;
    const current = draft.values.reminder || model.reminderForm(null);
    const next = Object.assign({}, current);

    if (field === 'reminderEnabled') {
      next.enabled = !!value;
      if (next.enabled && !next.atText) next.atText = next.defaultAtText;
    } else if (field === 'reminderAt') next.atText = String(value || '');
    else if (field === 'reminderAdvance') next.advance = Number(value);
    else if (field === 'reminderRepeat') {
      next.repeat = model.REMINDER_REPEATS.indexOf(String(value)) >= 0 ? String(value) : 'none';
      if (next.repeat === 'none') {
        next.endType = 'never'; next.endCount = null; next.endDate = null; next.endDateText = '';
      } else if (next.endType === 'count' && !next.endCount) {
        next.endCount = 5;
      }
    } else if (field === 'reminderEndType') {
      next.endType = model.REMINDER_ENDS.indexOf(String(value)) >= 0 ? String(value) : 'never';
      if (next.endType === 'count' && !next.endCount) next.endCount = 5;
      if (next.endType === 'date' && !next.endDateText) {
        const base = next.at || Date.now();
        next.endDateText = model.toLocalInput(base + 7 * model.DAY_MS).slice(0, 10);
      }
    } else if (field === 'reminderEndCount') {
      const count = Number(value);
      next.endCount = Number.isFinite(count) && count > 0
        ? Math.min(Math.floor(count), model.REMINDER_LIMIT.count) : null;
    } else if (field === 'reminderEndDate') next.endDateText = String(value || '');
    else if (field === 'reminderOnDone') next.onDone = String(value) === 'keep' ? 'keep' : 'cancel';
    else return false;

    draft.values.reminder = next;
    if (!draft.dirty) draft.dirty = true;
    return true;
  }

  /** 只刷新"到点提醒：…"那行确认文案（输入过程中不整树重绘，光标不跳） */
  function refreshReminderPreview() {
    const node = ui.refs['panel-content'].querySelector('#reminder-preview');
    if (!node || !state.draft) return;
    node.textContent = ui.reminderPreviewText(state.draft.values);
  }

  /** 输入事件：只更新草稿与计数器 —— 不重绘，中文输入法合成过程不受打扰 */
  function onInput(ev) {
    const target = ev.target;
    const field = target && target.dataset ? target.dataset.field : null;
    if (!field || !state.draft) return;

    // 提醒字段：值进草稿的 reminder（datetime / number 输入过程中不重绘）
    if (field.indexOf('reminder') === 0 && field !== 'reminderEnabled') {
      if (applyReminderField(field, target.value)) {
        refreshReminderPreview();
        setDirtyIndicator();
      }
      return;
    }

    state.draft.values[field] = target.value;
    if (!state.draft.dirty) state.draft.dirty = true;

    const isTitle = field === 'title';
    setCounter(isTitle ? 'f-title' : 'f-note', target.value.length,
      isTitle ? model.LIMIT.title : model.LIMIT.note);
    setDirtyIndicator();
  }

  /* ---------------------------------------------------- 事件：点击动作分发 */

  function setPriority(value) {
    if (!state.draft || model.PRIORITIES.indexOf(value) === -1) return;
    state.draft.values.priority = value;
    state.draft.dirty = true;
    render();
    const seg = ui.refs['panel-content'].querySelector('.seg-item.is-active');
    if (seg) seg.focus();
  }

  function setMode(mode) {
    if (mode === 'add') startAdd();
    else if (mode === 'edit') startEdit();
    else if (mode === 'delete') askDelete();
    else if (mode === 'categories') {
      state.mode = 'categories';
      state.categoryError = '';
      state.pendingCategoryDelete = null;
      render();
    } else if (mode === 'settings') {
      state.mode = 'settings';
      render();
      refreshPermission().then(render);   // 打开设置页时重新问一次系统状态
      refreshLoginItem().then(render);
    } else if (mode === 'view') {
      state.mode = 'view';
      render();
    }
  }

  /** 取消：表单 → 丢弃草稿回到查看；删除确认 → 回到查看 */
  function cancelCurrent() {
    if (state.mode === 'delete') {
      state.mode = 'view';
      render();
      return;
    }
    const wasDirty = !!(state.draft && state.draft.dirty);
    state.draft = null;
    state.errors = {};
    state.mode = 'view';
    render();
    if (wasDirty) ui.toast('info', '已放弃未保存的草稿');
  }

  const CLICK_ACTIONS = {
    'select': function (action) { select(action.id); },
    'view': function (action) { select(action.id); },
    'toggle-item': function (action) { toggleItemExpanded(action.id); },
    'toggle-status': function (action) { toggleStatus(action.id); },
    'toggle-list': function () { toggleList(); },
    'set-filter': function (action) { setFilter(action.value); },
    'set-priority': function (action) { setPriority(action.value); },
    'set-mode': function (action) { setMode(action.value); },
    'new': function () { startAdd(); },
    'edit': function (action) { startEdit(action.id); },
    'delete': function (action) { askDelete(action.id); },
    'cancel': function () { cancelCurrent(); },
    'confirm-delete': function (action) { confirmDelete(action.id); },
    'resume-draft': function () { resumeDraft(); },
    'discard-draft': function () { discardDraft(); },
    'export': function () { exportBackup(); },
    // 外观：单按钮切换（回到自动模式走菜单栏，不在这里）
    'toggle-theme': function () { toggleTheme(); },
    // 分类
    'toggle-category': function (action) { toggleCategoryCollapse(action.value); },
    'focus-category': function (action) { setFocusCategory(action.value); },
    'set-category': function (action) { setDraftCategory(action.value); },
    'cycle-color': function (action) { cycleCategoryColor(action.value); },
    'ask-delete-category': function (action) { askDeleteCategory(action.value); },
    'confirm-delete-category': function (action) { confirmDeleteCategory(action.value); },
    'cancel-delete-category': function () { cancelDeleteCategory(); },
    // 提醒与通知
    'remind-open': function (action) { openReminder(action.id); },
    'remind-cancel': function (action) { cancelReminder(action.id); },
    'remind-snooze': function (action) { snoozeReminder(action.id, 10); },
    'remind-dismiss': function () { state.dueDismissed = true; render(); },
    'request-permission': function () { requestPermission(); },
    'check-permission': function () {
      refreshPermission().then(function (status) {
        render();
        ui.toast('info', '通知权限：' + status);
      });
    },
    'open-notification-settings': function () { openNotificationSettings(); },
    'notify-test': function () { sendTestNotification(); },
    'toggle-notify': function () { toggleNotifySwitch('enabled'); },
    'toggle-sound': function () { toggleNotifySwitch('sound'); },
    'toggle-dnd': function () { toggleNotifySwitch('dndEnabled'); },
    'toggle-catchup': function () { toggleNotifySwitch('catchUp'); },
    'toggle-autostart': function () { toggleAutoStart(); },
    // 'save' 不在这里处理：交给表单的 submit 事件，避免一次点击执行两遍
  };

  /** 事件委托：最内层的 [data-act] 决定动作，列表按钮不会误触发"选中" */
  function onClick(ev) {
    const node = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!node) return;
    const handler = CLICK_ACTIONS[node.dataset.act];
    if (!handler) return;
    handler({
      act: node.dataset.act,
      id: node.dataset.id || null,
      value: node.dataset.value || null,
      node: node,
    });
  }
  /* ------------------------------------------------------------ 事件：键盘 */

  function onKeydown(ev) {
    const key = ev.key;

    // Esc：从任何临时模式退回查看（表单里等价于"取消"）
    if (key === 'Escape') {
      if (state.mode === 'add' || state.mode === 'edit' || state.mode === 'delete') {
        ev.preventDefault();
        cancelCurrent();
      }
      return;
    }

    // ⌘/Ctrl + Enter：表单里保存
    if ((ev.metaKey || ev.ctrlKey) && key === 'Enter') {
      if (state.mode === 'add' || state.mode === 'edit') {
        ev.preventDefault();
        saveForm();
      }
      return;
    }

    // 删除确认面板：回车即确认
    if (key === 'Enter' && state.mode === 'delete') {
      ev.preventDefault();
      confirmDelete();
      return;
    }

    // 列表条目获得焦点时：回车 / 空格 = 选中
    if ((key === 'Enter' || key === ' ') && ev.target && ev.target.dataset &&
        ev.target.dataset.act === 'select') {
      ev.preventDefault();
      select(ev.target.dataset.id);
      return;
    }

    // 页面内快捷键：没有原生菜单（浏览器预览）时同样可用
    if (ev.metaKey || ev.ctrlKey) {
      const shortcuts = {
        n: function () { startAdd(); },
        e: function () { startEdit(); },
        d: function () { askDelete(); },
        l: function () { toggleList(); },
        ',': function () { setMode('settings'); },   // 与菜单栏「通知设置…」一致
      };
      const action = shortcuts[String(key).toLowerCase()];
      if (!action) return;
      ev.preventDefault();
      action();
    }
  }

  /** 表单提交（点击保存按钮或输入框里按回车都会走到这里） */
  function onSubmit(ev) {
    if (state.mode === 'add' || state.mode === 'edit') {
      ev.preventDefault();
      saveForm();
      return;
    }
    if (state.mode === 'categories') {
      ev.preventDefault();
      const input = ui.refs['panel-content'].querySelector('#f-new-cat');
      addCategory(input ? input.value : '').then(function (ok) {
        if (!ok) return;
        const cleared = ui.refs['panel-content'].querySelector('#f-new-cat');
        if (cleared) { cleared.value = ''; cleared.focus(); }
      });
    }
  }

  /**
   * change 事件：分类改名（回车 / 失焦提交）、提醒字段（下拉 / 勾选 / 日期）、
   * 通知设置里的免打扰时间。提醒字段在这里才重绘 —— 结构可能变（开启开关、换重复规则）。
   */
  function onChange(ev) {
    const target = ev.target;
    const dataset = target && target.dataset ? target.dataset : null;
    if (!dataset) return;

    if (dataset.catRename) {
      renameCategory(dataset.catRename, target.value);
      return;
    }

    if (dataset.field === 'notifyDndFrom' || dataset.field === 'notifyDndTo') {
      setDndTime(dataset.field, target.value);
      return;
    }

    if (dataset.field && dataset.field.indexOf('reminder') === 0 && state.draft) {
      const value = target.type === 'checkbox' ? !!target.checked : target.value;
      if (applyReminderField(dataset.field, value)) {
        render();
        setDirtyIndicator();
      }
    }
  }

  /* ------------------------------------------------------ 提醒：数据与同步 */

  /** 给后端的通知选项（总开关 / 提示音 / 免打扰 / 补发） */
  function notifyOptions() {
    return Object.assign({}, state.settings.notifications);
  }

  /** 一条待办 → 后端日程条目（分类名在这里查，后端没有分类表） */
  function reminderEntry(todo) {
    const reminder = todo.reminder;
    if (!model.reminderActive(reminder)) return null;   // 未开启 / 已取消的不排期
    const category = model.categoryById(state.categories, todo.categoryId);
    return {
      id: todo.id,
      title: todo.title,
      category: category ? category.name : '未分类',
      at: reminder.at,
      advance: reminder.advance,
      repeat: reminder.repeat,
      endType: reminder.endType,
      endCount: reminder.endCount,
      endDate: reminder.endDate,
      onDone: reminder.onDone,
      enabled: true,
      firedCount: reminder.firedCount || 0,
      lastFiredAt: reminder.lastFiredAt || null,
    };
  }

  /** 同步防抖：连续操作（批量改数据 / 切开关）只推一次 */
  function scheduleReminderSync() {
    if (state.syncTimer) clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(function () {
      state.syncTimer = null;
      syncReminders();
    }, 120);
  }

  /** 把当前所有"活的"提醒整体推给后端，并用返回的日程回写条目 */
  async function syncReminders() {
    const list = state.items.map(reminderEntry).filter(Boolean);
    const result = await bridge.syncReminders(list, notifyOptions());
    if (result && Array.isArray(result.entries)) applySchedule(result.entries);
    return result;
  }

  /**
   * 后端是"下一轮排在哪 / 送没送过"的权威：把它推进过的提醒时间与台账写回条目。
   * 只在值真的变了时写 —— 既不和用户正在编辑的草稿打架，也不做无谓落盘。
   */
  function applySchedule(entries) {
    let changed = false;
    entries.forEach(function (entry) {
      const todo = model.byId(state.items, entry.id);
      const current = todo ? todo.reminder : null;
      const next = model.sanitizeReminder(entry.reminder);
      if (!todo || !next || !current) return;
      const same = current.at === next.at && current.lastFiredAt === next.lastFiredAt &&
        current.firedCount === next.firedCount && current.enabled === next.enabled &&
        current.cancelReason === next.cancelReason;
      if (same) return;
      state.items = model.replace(state.items, Object.assign({}, todo, { reminder: next }));
      changed = true;
    });
    if (changed) {
      render();
      persistItems();
    }
  }

  /* ------------------------------------------------------ 提醒：交互与事件 */

  /** 高亮 6 秒后自动褪去（列表里的 is-reminding / 视觉标识） */
  function highlight(id) {
    state.highlightId = id;
    if (state.highlightTimer) clearTimeout(state.highlightTimer);
    state.highlightTimer = setTimeout(function () {
      state.highlightId = null;
      state.highlightTimer = null;
      render();
    }, 6000);
  }

  /** 点系统通知 / 应用内横幅：把窗口拉到前台 → 选中 → 高亮 → 滚动到可见 */
  async function openReminder(id) {
    const todo = model.byId(state.items, id);
    if (!todo) {
      ui.toast('info', '这条待办已不存在（提醒已忽略）');
      return false;
    }
    await bridge.focusWindow();
    state.ui.selectedId = todo.id;
    state.mode = 'view';
    state.dueDismissed = true;
    highlight(todo.id);
    render();
    persistUi();
    const node = ui.refs.groups.querySelector('[data-id="' + todo.id + '"]');
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'center' });
    return true;
  }

  /** 后端推来的到点事件：写回台账 → 应用内提示 → 高亮 */
  function handleReminderDue(payload) {
    if (!payload || !payload.id) return;
    const todo = model.byId(state.items, payload.id);
    state.reminderFired++;

    if (todo && payload.reminder) {
      const next = model.sanitizeReminder(payload.reminder);
      if (next) {
        state.items = model.replace(state.items, Object.assign({}, todo, { reminder: next }));
        persistItems();
        // 后端推的是"推进之后"的日程（含重复提醒的下一轮时间）：回同步一次让两边对齐
        scheduleReminderSync();
      }
    }

    const title = todo ? todo.title : (payload.title || '待办');
    const when = payload.reminder ? model.reminderTiming(payload.reminder, Date.now()) : '';
    const late = payload.late ? '（补发：应用没运行时到点）' : '';
    ui.toast('info', '⏰ 提醒到点：' + title + (when ? ' · ' + when : '') + late, { duration: 6000 });
    if (todo) highlight(todo.id);
    state.dueDismissed = false;
    render();
  }

  /** 取消提醒：关闭但保留设置（详情里能看到"已取消（用户取消）"） */
  async function cancelReminder(id, silent) {
    const todo = model.byId(state.items, id || state.ui.selectedId);
    if (!todo || !todo.reminder) {
      if (!silent) ui.toast('info', '这条待办没有提醒可取消');
      return false;
    }
    const next = model.cancelReminder(todo.reminder, Date.now(), 'user');
    state.items = model.replace(state.items, Object.assign({}, todo, { reminder: next }));
    render();
    const ok = await persistItems();
    scheduleReminderSync();
    if (ok && !silent) ui.toast('info', '已取消「' + todo.title + '」的提醒（设置保留，编辑里可重开）');
    return ok;
  }

  /**
   * 稍后提醒：把提醒时间推到 N 分钟后（提前量归零，否则新的时间又立刻落回"该弹了"）。
   * 重复提醒沿用同一条规则：本次之后按新时间继续走。
   */
  async function snoozeReminder(id, minutes) {
    const todo = model.byId(state.items, id || state.ui.selectedId);
    if (!todo || !todo.reminder) {
      ui.toast('info', '这条待办没有提醒可推迟');
      return false;
    }
    const gap = Number.isFinite(minutes) ? minutes : 10;
    const next = Object.assign({}, todo.reminder, {
      enabled: true, at: Date.now() + gap * 60000, advance: 0, lastFiredAt: null,
      cancelledAt: null, cancelReason: null,
    });
    state.items = model.replace(state.items, Object.assign({}, todo, { reminder: next }));
    render();
    const ok = await persistItems();
    scheduleReminderSync();
    if (ok) {
      ui.toast('success', '已推迟 ' + gap + ' 分钟：' + todo.title +
        (next.repeat !== 'none' ? '（重复提醒以新时间为基准继续）' : ''));
    }
    return ok;
  }

  /* ---------------------------------------------------- 通知：权限与设置 */

  async function refreshPermission() {
    if (!bridge.available) {
      state.permission = { state: 'unsupported' };
      return state.permission.state;
    }
    const status = await bridge.notifyPermission();
    const capped = (state.caps && state.caps.notifications === false) ? 'unsupported' : status;
    state.permission = { state: capped || 'unknown' };
    return state.permission.state;
  }

  async function refreshLoginItem() {
    const status = await bridge.loginItem();
    state.loginItem = status || null;
    return status;
  }

  async function requestPermission() {
    const status = await bridge.requestNotifyPermission();
    await refreshPermission();
    render();
    if (status === 'granted') ui.toast('success', '通知已授权：到点会弹系统横幅');
    else if (status === 'denied') ui.toast('error', '通知被拒绝：可在系统设置 → 通知里重新打开');
    else ui.toast('info', '权限状态：' + status);
    return status;
  }

  async function openNotificationSettings() {
    const ok = await bridge.openNotificationSettings();
    ui.toast('info', ok
      ? '已尝试打开系统「通知」设置页：找到「' + NS.const.APP_NAME + '」并允许通知'
      : '请手动打开：系统设置 → 通知 → 「' + NS.const.APP_NAME + '」');
    return ok;
  }

  async function sendTestNotification() {
    const ok = await bridge.testNotify(NS.const.APP_NAME, '这是一条测试通知：到点时会这样提醒你。');
    ui.toast(ok ? 'success' : 'error', ok
      ? '已发送测试通知（没看到横幅就检查系统通知权限与专注模式）'
      : '测试通知发送失败：可能未授权、被免打扰挡下，或当前环境不支持');
    return ok;
  }

  /**
   * 第一次真正用上提醒（保存表单时带着"开启的提醒"）才请求通知权限：
   * 有上下文、说明用途，不是一上来就弹系统对话框。
   * 只在**打包后的 .app** 里请求 —— dev 下 macOS 没有 bundle，通知只会回落到 osascript，
   * 这时候弹授权框没有意义（设置页里会写明）。
   */
  async function ensureNotifyPermission(todo) {
    if (!todo || !todo.reminder || todo.reminder.enabled !== true) return null;
    if (!bridge.available || !state.packaged) return null;
    if (state.permission.state !== 'undetermined') return state.permission.state;
    ui.toast('info', '第一次用提醒：先向系统申请通知权限，允许后到点才会弹横幅', { duration: 4200 });
    return requestPermission();
  }

  /** 通知设置：改一项 → 归一化 → 落盘 → 同步给后端（由后端决定弹不弹） */
  async function updateNotifications(patch, message) {
    state.settings.notifications = model.sanitizeNotifications(
      Object.assign({}, state.settings.notifications, patch));
    render();
    await state.store.saveSettings(state.settings);
    scheduleReminderSync();
    if (message) ui.toast('info', message);
    return state.settings.notifications;
  }

  async function toggleNotifySwitch(key) {
    const current = state.settings.notifications;
    if (key === 'enabled') {
      return updateNotifications({ enabled: !current.enabled },
        current.enabled ? '系统通知已关闭（应用内提示照旧）' : '系统通知已开启');
    }
    if (key === 'sound') {
      return updateNotifications({ sound: !current.sound },
        current.sound ? '提示音已关闭' : '提示音已开启');
    }
    if (key === 'dndEnabled') {
      return updateNotifications({ dndEnabled: !current.dndEnabled },
        current.dndEnabled ? '免打扰已关闭' : '免打扰已开启：' + model.quietHoursText(current));
    }
    if (key === 'catchUp') {
      return updateNotifications({ catchUp: !current.catchUp },
        current.catchUp ? '错过的提醒不再补发' : '错过的提醒会在下次打开时补发');
    }
    return current;
  }

  /** 免打扰时间（两个 time 输入框，change 时落盘） */
  async function setDndTime(field, value) {
    if (!/^\d{2}:\d{2}$/.test(String(value || ''))) return false;
    const patch = {};
    patch[field === 'notifyDndTo' ? 'dndTo' : 'dndFrom'] = value;
    await updateNotifications(patch, '免打扰时段：' + model.quietHoursText(
      Object.assign({}, state.settings.notifications, patch)));
    return true;
  }

  /** 登录时自动启动：让应用常驻，"应用没打开"也能按时提醒 */
  async function toggleAutoStart() {
    const status = await bridge.setLoginItem(state.loginItem !== 'enabled');
    state.loginItem = status || null;
    render();
    if (!status || status === 'unsupported') {
      ui.toast('error', '当前环境不支持设置登录项（需要打包后的 .app）');
      return status;
    }
    if (status === 'requires-approval') {
      ui.toast('info', '已登记登录项：需要你在「系统设置 → 通用 → 登录项」里允许');
      return status;
    }
    ui.toast(status === 'enabled' ? 'success' : 'info',
      status === 'enabled' ? '已开启登录时自动启动' : '已关闭登录时自动启动');
    return status;
  }

  /* ---------------------------------------------------------- 提醒：定时 */

  /** 提醒状态随时间变化（已设置 → 即将到期 → 已过期），用轻量签名决定要不要重绘 */
  function reminderSignature() {
    const now = Date.now();
    return state.items.map(function (todo) {
      return todo.id + ':' + (todo.reminder ? model.reminderState(todo.reminder, now).key : '-');
    }).join('|');
  }

  function startReminderClock() {
    if (state.reminderTimer) clearInterval(state.reminderTimer);
    state.reminderSignature = reminderSignature();
    state.reminderTimer = setInterval(function () {
      const next = reminderSignature();
      if (next !== state.reminderSignature) {
        state.reminderSignature = next;
        render();                                  // 只有跨过阈值（16:00 → 17:00 这类）才重绘
      }
      if (!bridge.available) checkDueInPage();     // 浏览器预览：页面自己兜底
    }, 20000);
  }

  /**
   * 浏览器预览（没有后端定时器）时的兜底：页面自己发现"到点但没提示过"的提醒，
   * 走应用内提示 + 浏览器的 Notification（如果被允许过）。
   */
  async function checkDueInPage() {
    const now = Date.now();
    const due = state.items.filter(function (todo) { return model.reminderPending(todo.reminder, now); });
    if (!due.length) return 0;

    due.forEach(function (todo) {
      const advanced = model.advanceReminder(todo.reminder, now);
      state.items = model.replace(state.items, Object.assign({}, todo, { reminder: advanced }));
      ui.toast('info', '⏰ 提醒到点：' + todo.title, { duration: 6000 });
      try {
        const web = root.Notification;
        if (web && web.permission === 'granted') new web('⏰ ' + todo.title, { body: '待办中心 · 提醒' });
      } catch (_e) { /* 浏览器不支持就算了：应用内提示已经有了 */ }
    });

    render();
    await persistItems();
    return due.length;
  }

  /** 启动提醒链路：先订阅推送（后端补发可能就发生在同步那一步），再首次同步 */
  function setupReminders() {
    bridge.onReminderDue(handleReminderDue);
    bridge.onNotifyClick(function (id) { openReminder(id); });
    startReminderClock();

    refreshPermission().then(render);
    refreshLoginItem().then(render);
    bridge.appInfo().then(function (info) {
      state.packaged = !!(info && info.tinyjs && info.tinyjs !== 'dev');
    });
    bridge.capabilities().then(function (caps) {
      state.caps = caps || null;
      if (caps && caps.notifications === false) {
        state.permission = { state: 'unsupported' };
        render();
      }
    });

    scheduleReminderSync();
  }

  /* ------------------------------------------------------ 原生菜单（tinyjs） */

  const APP_MENU = [{
    title: '待办',
    items: [
      { id: 'menu-new', label: '新建待办', key: 'n' },
      { id: 'menu-edit', label: '编辑所选', key: 'e' },
      { id: 'menu-delete', label: '删除所选', key: 'd' },
      { separator: true },
      { id: 'menu-toggle-list', label: '折叠 / 展开列表', key: 'l' },
      { id: 'menu-categories', label: '分类管理…', key: 'k' },
      { id: 'menu-settings', label: '通知设置…', key: ',' },
      { separator: true },
      { id: 'menu-theme-toggle', label: '切换外观', key: 't' },
      { id: 'menu-theme-system', label: '外观：跟随系统' },
      { separator: true },
      { id: 'menu-export', label: '导出备份…', key: 'alt+e' },
    ],
  }];

  /**
   * 原生菜单里的外观项跟随当前状态（tiny.menu.update 就地更新）：
   *  - 「切换外观」标题实时显示"点下去会得到什么"（与顶栏按钮同一语义）
   *  - 「外观：跟随系统」用勾选态表示是否在自动模式（回到自动的唯一入口）
   */
  function syncMenuChecks() {
    const auto = state.ui.themeMode === 'system';
    const target = resolvedTheme() === 'dark' ? '浅色' : '深色';
    bridge.updateMenu('menu-theme-toggle', { label: '切换外观 → ' + target });
    bridge.updateMenu('menu-theme-system', { checked: auto });
  }

  function setupMenu() {
    bridge.setMenu(APP_MENU);
    bridge.onMenu(function (id) {
      if (id === 'menu-new') startAdd();
      else if (id === 'menu-edit') startEdit();
      else if (id === 'menu-delete') askDelete();
      else if (id === 'menu-toggle-list') toggleList();
      else if (id === 'menu-categories') setMode('categories');
      else if (id === 'menu-settings') setMode('settings');
      else if (id === 'menu-theme-toggle') toggleTheme();
      else if (id === 'menu-theme-system') setThemeMode('system');
      else if (id === 'menu-export') exportBackup();
    });
    syncMenuChecks();
  }

  /* ---------------------------------------------------------------- 启动 */

  function bindEvents() {
    const rootEl = ui.refs.root;
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('submit', onSubmit);
    rootEl.addEventListener('input', onInput);
    rootEl.addEventListener('change', onChange);
    rootEl.addEventListener('keydown', onKeydown);
  }

  async function boot() {
    ui.mount(doc.getElementById('app'));
    ui.renderStoreState('idle');
    ui.renderEnv({ runtime: '连接后端…' });

    // 持久化：tinyjs 环境用 tiny.store（落盘），浏览器预览用内存
    state.store = NS.persistence.autoCreate(function (status, detail) {
      ui.renderStoreState(status, detail);
    });

    // 外观：先取系统真值 → 读用户选择 → 落地 <html data-theme>（首帧由 CSS 兜底）
    state.systemDark = await bridge.systemDark();
    watchSystemTheme();

    state.items = await state.store.loadItems();
    state.categories = await state.store.loadCategories();
    state.ui = sanitizeUi(await state.store.loadUi());
    state.settings = await state.store.loadSettings();

    // 兜底：条目上缺失 / 已失效的分类统一落到默认分类
    state.items = model.assignCategories(state.items, state.categories);
    if (state.ui.selectedId && !model.byId(state.items, state.ui.selectedId)) {
      state.ui.selectedId = null;   // 上次选中的条目已被删除
    }
    if (state.ui.focusCategoryId && !model.categoryById(state.categories, state.ui.focusCategoryId)) {
      state.ui.focusCategoryId = null;
    }
    if (state.ui.lastCategoryId && !model.categoryById(state.categories, state.ui.lastCategoryId)) {
      state.ui.lastCategoryId = null;
    }

    applyTheme();
    render();
    bindEvents();
    setupMenu();
    setupReminders();          // 订阅到点推送 + 首次把提醒日程同步给后端

    state.env = await bridge.info();
    ui.renderEnv(state.env);

    state.ready = true;
    NS.ready = true;                          // 自检脚本等待的就绪标志
    doc.body.classList.add('is-ready');
    if (state.items.length === 0) {
      ui.toast('info', '欢迎使用待办中心 · 顶栏「＋ 新建待办」或 ⌘N 创建第一条', { duration: 3600 });
    }
  }

  /* ------------------------------------------------------------------ 对外 */

  /**
   * 暴露给自检脚本 / 后续扩展的入口。生产代码只依赖内部闭包，
   * 这里是为了让端到端测试能驱动与断言同一套状态机。
   */
  NS.controller = {
    state: state, view: view, render: render, sanitizeUi: sanitizeUi, boot: boot,
    select: select, onInput: onInput, onChange: onChange,
    toggleList: toggleList, toggleCategoryCollapse: toggleCategoryCollapse,
    toggleItemExpanded: toggleItemExpanded,
    setFilter: setFilter, setPriority: setPriority, setMode: setMode,
    startAdd: startAdd, startEdit: startEdit, askDelete: askDelete,
    resumeDraft: resumeDraft, discardDraft: discardDraft, cancelCurrent: cancelCurrent,
    readFormValues: readFormValues, saveForm: saveForm,
    confirmDelete: confirmDelete, toggleStatus: toggleStatus, exportBackup: exportBackup,
    // 提醒与通知（自检脚本可驱动同一套逻辑）
    reminderEntry: reminderEntry, syncReminders: syncReminders, applySchedule: applySchedule,
    handleReminderDue: handleReminderDue, openReminder: openReminder, highlight: highlight,
    cancelReminder: cancelReminder, snoozeReminder: snoozeReminder,
    updateNotifications: updateNotifications, toggleNotifySwitch: toggleNotifySwitch,
    refreshPermission: refreshPermission, requestPermission: requestPermission,
    sendTestNotification: sendTestNotification, toggleAutoStart: toggleAutoStart,
    setDndTime: setDndTime, checkDueInPage: checkDueInPage, ensureNotifyPermission: ensureNotifyPermission,
    applyReminderField: applyReminderField, reminderInputFromForm: reminderInputFromForm,
    // 外观
    setThemeMode: setThemeMode, toggleTheme: toggleTheme, applyTheme: applyTheme,
    handleSystemTheme: function (dark) { state.systemDark = !!dark; state.ui.themeMode = 'system'; applyTheme(); render(); },
    // 分类
    addCategory: addCategory, renameCategory: renameCategory, cycleCategoryColor: cycleCategoryColor,
    askDeleteCategory: askDeleteCategory, confirmDeleteCategory: confirmDeleteCategory,
    cancelDeleteCategory: cancelDeleteCategory, setFocusCategory: setFocusCategory,
    setDraftCategory: setDraftCategory, persistCategories: persistCategories,
  };

  /* ------------------------------------------------------------------ 启动 */

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);

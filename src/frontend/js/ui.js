/* =============================================================================
 * 待办中心 · 视图层（纯渲染）
 * -----------------------------------------------------------------------------
 * 职责边界：这里只负责"把状态画成 DOM"和"发轻提示"，不解释事件、不改数据。
 * 控制器（app.js）通过事件委托读取元素上的 data-act / data-id 决定做什么。
 *
 * 安全性：所有用户数据都用 textContent 写入（el() 的 text 分支），
 * 页面里唯一使用 innerHTML 的地方是内置图标（常量字符串，非用户输入）。
 * ========================================================================== */
(function (root) {
  'use strict';

  const NS = (root.TodoApp = root.TodoApp || {});
  const model = (NS.model = NS.model || {});
  const doc = root.document;

  /* ------------------------------------------------------------------ 工具 */

  /**
   * 创建元素：DOM 版"字面量"，避免散落的 createElement/appendChild 噪音。
   * 支持 class / text / dataset / 事件（onClick 等）/ 原生属性。
   */
  function el(tag, props, children) {
    const node = doc.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        const value = props[key];
        if (value == null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value; // 仅内置图标
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.indexOf('on') === 0 && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value === true ? '' : String(value));
      });
    }
    (children || []).forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function chev() {
    return el('span', { class: 'chev', 'aria-hidden': 'true' });
  }

  /* -------------------------------------------------------------- 骨架挂载 */

  const refs = {};

  function mount(rootEl) {
    const shell = el('div', { class: 'shell' }, [
      /* 顶栏：品牌 + 统计 + 外观切换 + 唯一的全局操作
         ——「新建待办」只此一处（右栏表单、空态里都不再重复放按钮，
            空态改为文案指引，避免同一动作出现两个并列入口）。
         ——「折叠列表」只留在左栏头部（紧贴它控制的内容），顶栏不再放第二颗按钮；
            ⌘L 与菜单项是它的非视觉入口。
         ——「外观」也收敛成一颗按钮：不做三档并列；图标与文案都表示"点击后得到的模式"，
            是否在跟随系统只由按钮上的「自动」小牌表示，回到自动走菜单栏（见 app.js）。 */
      el('header', { class: 'topbar' }, [
        el('div', { class: 'brand' }, [
          el('span', { class: 'logo', text: '✓', 'aria-hidden': 'true' }),
          el('div', { class: 'brand-text' }, [
            el('h1', { text: NS.const.APP_NAME }),
            el('span', { class: 'brand-sub', text: NS.const.APP_NAME_EN + ' · txiki.js + WebKit' }),
          ]),
        ]),
        el('div', { class: 'stats', id: 'stats', 'aria-live': 'polite' }),
        el('div', { class: 'theme-slot', id: 'theme-switch' }),
        el('div', { class: 'top-actions' }, [
          el('button', {
            class: 'btn primary', id: 'btn-new', dataset: { act: 'new' },
            title: '新建待办（⌘N）—— 全局唯一入口',
          }, [el('span', { class: 'plus', text: '＋' }), '新建待办']),
        ]),
      ]),
      /* 主区：左右分栏 */
      el('div', { class: 'split' }, [
        /* 左栏：待办列表 */
        el('section', { class: 'pane list-pane', id: 'pane-list', 'aria-label': '待办列表' }, [
          el('div', { class: 'pane-head' }, [
            el('button', {
              class: 'collapse-toggle', id: 'list-toggle', dataset: { act: 'toggle-list' },
              'aria-expanded': 'true',
            }, [chev(), el('span', { class: 'ct-label', text: '待办列表' }),
                el('span', { class: 'count', id: 'list-count', text: '0' })]),
            el('div', { class: 'filters', id: 'filters', role: 'tablist' }),
            el('div', { class: 'focus-chip', id: 'focus-chip', hidden: true }),
          ]),
          el('div', { class: 'pane-body', id: 'list-body' }, [
            el('div', { class: 'collapsed-note', id: 'list-collapsed-note', hidden: true }),
            el('div', { class: 'groups', id: 'groups' }),
            el('div', { class: 'empty', id: 'empty', hidden: true }),
          ]),
          el('footer', { class: 'pane-foot', id: 'list-foot' }),
        ]),
        /* 右栏：操作面板 */
        el('section', { class: 'pane panel-pane', id: 'pane-panel', 'aria-label': '操作面板' }, [
          el('div', { class: 'pane-head' }, [
            el('div', { class: 'mode-tabs', id: 'mode-tabs', role: 'tablist' }),
            el('span', { class: 'draft-badge', id: 'draft-badge', hidden: true, text: '草稿未保存' }),
          ]),
          el('div', { class: 'pane-body', id: 'panel-body' }, [
            el('div', { class: 'banner', id: 'draft-banner', hidden: true }),
            el('div', { class: 'panel-content', id: 'panel-content' }),
          ]),
          el('footer', { class: 'pane-foot status-bar', id: 'panel-foot' }, [
            el('span', { class: 'store-state', id: 'store-state' }),
            el('span', { class: 'env-info', id: 'env-info' }),
            el('button', { class: 'btn ghost sm', id: 'btn-export', dataset: { act: 'export' }, text: '导出备份' }),
          ]),
        ]),
      ]),
      /* 轻提示容器 */
      el('div', { class: 'toasts', id: 'toasts', 'aria-live': 'polite', 'aria-atomic': 'false' }),
    ]);

    clear(rootEl);
    rootEl.appendChild(shell);

    ['stats', 'btn-new', 'theme-switch', 'pane-list', 'list-toggle', 'list-count', 'filters',
     'focus-chip', 'list-body', 'list-collapsed-note', 'groups', 'empty', 'list-foot', 'pane-panel',
     'mode-tabs', 'draft-badge', 'panel-body', 'draft-banner', 'panel-content', 'store-state',
     'env-info', 'btn-export', 'toasts'].forEach(function (id) {
      refs[id] = shell.querySelector('#' + id);
    });
    refs.root = shell;

    return refs;
  }
  /* ---------------------------------------------------------- 渲染：顶部统计 */

  function renderStats(stats) {
    const box = refs.stats;
    clear(box);

    function chip(label, value, kind) {
      return el('span', { class: 'stat ' + kind }, [
        el('span', { class: 'stat-value', text: String(value) }),
        el('span', { class: 'stat-label', text: label }),
      ]);
    }
    box.appendChild(chip('全部', stats.total, 'all'));
    box.appendChild(chip('未完成', stats.open, 'open'));
    box.appendChild(chip('已完成', stats.done, 'done'));

    const percent = Math.round(stats.ratio * 100);
    box.appendChild(el('span', { class: 'progress', title: '完成率 ' + percent + '%' }, [
      el('span', { class: 'progress-fill', style: 'width:' + percent + '%' }),
    ]));
  }

  /* ------------------------------------------------------------ 渲染：筛选器 */

  const FILTER_LABEL = { all: '全部', open: '未完成', done: '已完成' };

  function renderFilters(active, counts) {
    const box = refs.filters;
    clear(box);
    ['all', 'open', 'done'].forEach(function (key) {
      box.appendChild(el('button', {
        class: 'filter' + (active === key ? ' is-active' : ''),
        dataset: { act: 'set-filter', value: key },
        role: 'tab',
        'aria-selected': active === key ? 'true' : 'false',
        text: FILTER_LABEL[key] + (counts ? ' ' + (counts[key] || 0) : ''),
      }));
    });
  }

  /* ------------------------------------------------------------ 渲染：外观 */

  /**
   * 顶栏只有一颗外观按钮，图标与文案都表示"点击后切到的那个模式"：
   *   当前深色 → 显示浅色图标 ☀（点一下得到浅色）
   *   当前浅色 → 显示深色图标 ☾（点一下得到深色）
   * 跟随系统时实际外观由系统决定，按钮显示系统解析结果的"反面"，
   * 并挂一枚「自动」状态牌 —— 它是状态提示，不是第二个入口。
   */
  const THEME_LOOK = {
    light: { icon: '☀', label: '浅色' },
    dark: { icon: '☾', label: '深色' },
  };

  function renderTheme(view) {
    const box = refs['theme-switch'];
    clear(box);

    const now = view.resolvedTheme;                      // 当前实际外观
    const target = now === 'dark' ? 'light' : 'dark';    // 点击后得到的外观
    const info = THEME_LOOK[target];
    const nowLabel = THEME_LOOK[now].label;
    const auto = view.themeMode === 'system';            // 是否在跟随系统

    box.appendChild(el('button', {
      class: 'theme-toggle' + (auto ? ' is-auto' : ''),
      id: 'theme-toggle',
      dataset: { act: 'toggle-theme' },
      title: (auto ? '当前跟随系统（' + nowLabel + '）' : '当前' + nowLabel) +
        ' · 点击切换到' + info.label,
      'aria-label': '外观模式：' + (auto ? '跟随系统，当前' + nowLabel : nowLabel) +
        '，点击切换到' + info.label,
    }, [
      el('span', { class: 'theme-icon', text: info.icon, 'aria-hidden': 'true' }),
      el('span', { class: 'theme-label', text: info.label }),
      auto ? el('span', { class: 'theme-auto', text: '自动', 'aria-hidden': 'true' }) : null,
    ]));
  }

  /* -------------------------------------------------------- 渲染：单条待办 */

  function renderItem(todo, view) {
    const selected = view.selectedId === todo.id;
    const expanded = !!view.expanded[todo.id];
    const isDone = todo.status === 'done';
    const excerpt = model.excerpt(todo.note, 64);

    const line1 = el('div', { class: 'item-line1' }, [
      el('span', { class: 'dot ' + todo.status, 'aria-hidden': 'true' }),
      el('span', { class: 'item-title', text: todo.title }),
      el('span', { class: 'prio prio-' + todo.priority, text: model.PRIORITY_LABEL[todo.priority] }),
    ]);

    const meta = el('div', { class: 'item-meta' }, [
      el('span', { class: 'time', text: model.relativeTime(todo.updatedAt) }),
      excerpt ? el('span', { class: 'sep', text: '·' }) : null,
      excerpt ? el('span', { class: 'excerpt', text: excerpt }) : null,
    ]);

    const detail = el('div', { class: 'item-detail', hidden: !expanded }, [
      el('dl', { class: 'kv' }, [
        el('dt', { text: '创建' }), el('dd', { text: model.absoluteTime(todo.createdAt) }),
        el('dt', { text: '更新' }), el('dd', { text: model.absoluteTime(todo.updatedAt) }),
        el('dt', { text: '完成' }), el('dd', { text: todo.doneAt ? model.absoluteTime(todo.doneAt) : '—' }),
        el('dt', { text: 'ID' }), el('dd', { class: 'mono', text: todo.id }),
      ]),
      el('div', { class: 'item-note', text: todo.note || '（无备注）' }),
      el('div', { class: 'item-actions' }, [
        el('button', { class: 'btn ghost sm', dataset: { act: 'view', id: todo.id }, text: '查看' }),
        el('button', { class: 'btn ghost sm', dataset: { act: 'edit', id: todo.id }, text: '编辑' }),
        el('button', { class: 'btn danger-ghost sm', dataset: { act: 'delete', id: todo.id }, text: '删除' }),
      ]),
    ]);

    return el('article', {
      class: 'item' + (selected ? ' is-selected' : '') +
        (isDone ? ' is-done' : '') + (expanded ? ' is-expanded' : ''),
      dataset: { id: todo.id, act: 'select' },
      tabindex: '0',
      'aria-current': selected ? 'true' : 'false',
    }, [
      el('button', {
        class: 'item-chev', dataset: { act: 'toggle-item', id: todo.id },
        'aria-expanded': expanded ? 'true' : 'false',
        title: expanded ? '收起摘要详情' : '展开摘要详情',
      }, [chev()]),
      el('div', { class: 'item-main' }, [line1, meta, detail]),
      el('button', {
        class: 'item-check', dataset: { act: 'toggle-status', id: todo.id },
        title: isDone ? '标记为未完成' : '标记为已完成',
        'aria-pressed': isDone ? 'true' : 'false',
      }, [el('span', { class: 'check-mark', text: '✓' })]),
    ]);
  }
  /* -------------------------------------------------------- 渲染：分类分组 */

  /** 分类色点：色值来自主题变量，所以两种外观下都自带对比度 */
  function catDot(extraClass) {
    return el('span', { class: 'cat-dot' + (extraClass ? ' ' + extraClass : ''), 'aria-hidden': 'true' });
  }

  function catVars(color) {
    return '--cat: var(--' + (model.CATEGORY_COLORS.indexOf(color) >= 0 ? color : 'c1') + ')';
  }

  function renderCategoryGroup(bucket, view) {
    const category = bucket.category;
    const items = bucket.items;
    const collapsed = !!view.collapsedCategories[category.id];
    const counts = model.countBy(items);
    const focused = view.focusCategoryId === category.id;

    const toggle = el('button', {
      class: 'group-toggle', dataset: { act: 'toggle-category', value: category.id },
      'aria-expanded': collapsed ? 'false' : 'true',
      title: (collapsed ? '展开' : '折叠') + '「' + category.name + '」',
    }, [
      chev(),
      catDot(),
      el('span', { class: 'group-title', text: category.name }),
      el('span', {
        class: 'group-count',
        text: counts.total ? counts.open + ' / ' + counts.total : '0',
        title: '未完成 / 总数',
      }),
      collapsed ? el('span', { class: 'group-hint', text: '已折叠 · 点击展开' }) : null,
    ]);

    const focusBtn = el('button', {
      class: 'group-focus', dataset: { act: 'focus-category', value: category.id },
      'aria-pressed': focused ? 'true' : 'false',
      title: focused ? '取消只看该分类' : '只看「' + category.name + '」',
      text: focused ? '✕' : '◎',
    });

    return el('section', {
      class: 'group' + (collapsed ? ' is-collapsed' : '') + (focused ? ' is-focused' : ''),
      dataset: { group: category.id, color: category.color },
      style: catVars(category.color),
    }, [
      el('div', { class: 'group-head' }, [toggle, focusBtn]),
      el('div', { class: 'group-body', hidden: collapsed },
        items.length
          ? items.map(function (todo) { return renderItem(todo, view); })
          : [el('div', { class: 'group-empty', text: '这个分类还没有待办' })]),
    ]);
  }

  /** 顶部"只看某分类"提示条：给分类筛选一个可见、可取消的状态 */
  function renderFocusChip(view) {
    const box = refs['focus-chip'];
    const category = view.focusCategoryId
      ? model.categoryById(view.categories, view.focusCategoryId)
      : null;

    box.hidden = !category;
    if (!category) return;

    clear(box);
    box.setAttribute('style', catVars(category.color));
    box.appendChild(catDot());
    box.appendChild(el('span', { class: 'chip-text', text: '只看：' + category.name }));
    box.appendChild(el('button', {
      class: 'chip-close', dataset: { act: 'focus-category', value: category.id },
      title: '取消只看该分类', 'aria-label': '取消只看该分类', text: '✕',
    }));
  }

  /* -------------------------------------------------------------- 渲染：列表 */

  function renderList(view) {
    const items = view.items;
    const counts = { all: items.length, open: 0, done: 0 };
    items.forEach(function (todo) {
      counts[todo.status === 'done' ? 'done' : 'open']++;
    });

    renderFilters(view.ui.filter, counts);

    renderFilters(view.ui.filter, counts);
    renderFocusChip(view);

    // 整表折叠：这里只剩一个视觉控件（左栏头部），⌘L / 菜单项是它的非视觉入口
    refs['list-toggle'].classList.toggle('is-collapsed', view.ui.listCollapsed);
    refs['list-toggle'].setAttribute('aria-expanded', view.ui.listCollapsed ? 'false' : 'true');
    refs['pane-list'].classList.toggle('is-collapsed', view.ui.listCollapsed);
    refs['list-count'].textContent = String(items.length);

    // 两个维度各管一段：分组 = 分类，筛选 = 状态；"只看某分类"是分类维度的聚焦
    const visible = model.filter(items, view.ui.filter);
    const scoped = view.focusCategoryId
      ? visible.filter(function (todo) { return todo.categoryId === view.focusCategoryId; })
      : visible;
    const buckets = model.groupByCategory(scoped, view.categories).filter(function (bucket) {
      // 聚焦时只留目标分类；平时空分类也保留（它本身就是"分类"这个结构的一部分）
      return !view.focusCategoryId || bucket.category.id === view.focusCategoryId;
    });

    clear(refs.groups);
    const showGroups = scoped.length > 0;
    refs.groups.hidden = !showGroups;
    if (showGroups) {
      buckets.forEach(function (bucket) {
        refs.groups.appendChild(renderCategoryGroup(bucket, view));
      });
    }

    const note = refs['list-collapsed-note'];
    note.hidden = !view.ui.listCollapsed;
    if (view.ui.listCollapsed) {
      note.textContent = '列表已折叠 · 共 ' + items.length + ' 项（' +
        counts.open + ' 未完成 / ' + counts.done + ' 已完成）· ' +
        view.categories.length + ' 个分类';
    }

    // 空态只做"指路"，不再放按钮：新建入口唯一在顶栏，避免同一动作两个并列按钮
    const showEmpty = scoped.length === 0;
    refs.empty.hidden = !showEmpty;
    if (showEmpty) {
      const noData = items.length === 0;
      clear(refs.empty);
      refs.empty.appendChild(el('div', { class: 'empty-inner' }, [
        el('span', { class: 'empty-icon', text: noData ? '✓' : '⌕' }),
        el('h3', { text: noData ? '还没有待办事项' : '当前条件下没有条目' }),
        el('p', { text: noData
          ? '创建入口只有一处：顶栏的「＋ 新建待办」（快捷键 ⌘N），创建时会让你选择分类。'
          : '换个筛选条件，或用顶栏「＋ 新建待办」加一条。' }),
        el('p', {
          class: 'empty-hint',
          text: '分类可以新增 / 重命名 / 换色 / 删除，入口在右侧面板的「分类」标签；删除分类时它的条目会自动转入「默认」。',
        }),
      ]));
    }

    clear(refs['list-foot']);
    refs['list-foot'].appendChild(el('span', {
      class: 'foot-note',
      text: '显示 ' + scoped.length + ' / ' + items.length + ' 项 · ' + FILTER_LABEL[view.ui.filter] +
        (view.focusCategoryId ? ' · 已聚焦分类' : ''),
    }));
    refs['list-foot'].appendChild(el('span', { class: 'foot-note dim', text: '⌘L 折叠列表' }));
  }
  /* ------------------------------------------------------------ 渲染：模式页签 */

  const MODE_LABEL = { view: '查看', add: '新建', edit: '编辑', delete: '删除', categories: '分类' };
  const MODE_HINT = {
    view: '查看所选待办的详情',
    add: '新建表单 · 入口：顶栏「＋ 新建待办」或 ⌘N',
    edit: '编辑所选待办（保存后生效）',
    delete: '删除所选待办（需二次确认）',
    categories: '管理分类：新增 / 重命名 / 换色 / 删除',
  };

  /**
   * 面板模式条。
   * 语义划分：「新建」是全局动作，入口唯一（顶栏按钮 / ⌘N / 菜单），
   * 进入后这里只显示一个不可点击的状态牌作为位置反馈；
   * 其余四项才是"面板页签"，可用鼠标切换。
   */
  function renderTabs(view) {
    const box = refs['mode-tabs'];
    clear(box);

    if (view.mode === 'add') {
      box.appendChild(el('span', {
        class: 'tab is-active is-indicator', id: 'tab-add-indicator', role: 'status',
        title: MODE_HINT.add, text: MODE_LABEL.add,
      }));
    }

    ['view', 'edit', 'delete', 'categories'].forEach(function (mode) {
      const needsSelection = mode === 'edit' || mode === 'delete';
      const disabled = needsSelection && !view.selected;
      box.appendChild(el('button', {
        class: 'tab' + (view.mode === mode ? ' is-active' : ''),
        dataset: disabled ? { mode: mode } : { act: 'set-mode', value: mode },
        role: 'tab',
        'aria-selected': view.mode === mode ? 'true' : 'false',
        disabled: disabled,
        title: disabled ? MODE_HINT[mode] + '（先在左侧选中一条）' : MODE_HINT[mode],
        text: MODE_LABEL[mode],
      }));
    });
  }

  /* ---------------------------------------------------------- 渲染：查看面板 */

  function kv(label, value, mono) {
    return [
      el('dt', { text: label }),
      el('dd', { class: mono ? 'mono' : null, text: value }),
    ];
  }

  function renderViewPanel(view) {
    const todo = view.selected;

    // 占位态只给指路文案：不提供第二个"新建"按钮（入口唯一在顶栏）
    if (!todo) {
      return el('div', { class: 'panel-placeholder', id: 'panel-placeholder' }, [
        el('span', { class: 'ph-icon', text: '⌘', 'aria-hidden': 'true' }),
        el('h3', { text: '选择一条待办开始' }),
        el('p', { text: '点击左侧任意条目查看详情。新建请用顶栏「＋ 新建待办」或按 ⌘N —— 全局只有这一个创建控件。' }),
        el('p', { class: 'ph-hint', text: '分类管理在「分类」标签里；折叠状态、筛选与草稿都会被记住。' }),
      ]);
    }

    const done = todo.status === 'done';
    const category = model.categoryById(view.categories, todo.categoryId);
    const categoryChip = el('span', {
      class: 'cat-chip', style: catVars(category ? category.color : 'c1'),
      title: category ? '所属分类：' + category.name : '未分类（已归入默认）',
    }, [catDot(), el('span', { text: category ? category.name : '未分类' })]);

    return el('div', { class: 'panel-card', id: 'panel-view' }, [
      el('div', { class: 'panel-title-row' }, [
        el('span', { class: 'status-pill ' + todo.status, text: model.STATUS_LABEL[todo.status] }),
        categoryChip,
        el('h2', { class: 'panel-title', id: 'view-title', text: todo.title }),
        el('span', { class: 'prio prio-' + todo.priority, text: '优先级 ' + model.PRIORITY_LABEL[todo.priority] }),
      ]),
      el('dl', { class: 'kv wide' }, [].concat(
        kv('分类', category ? category.name : '未分类'),
        kv('创建时间', model.absoluteTime(todo.createdAt)),
        kv('最近更新', model.absoluteTime(todo.updatedAt)),
        kv('完成时间', todo.doneAt ? model.absoluteTime(todo.doneAt) : '—'),
        kv('状态', model.STATUS_LABEL[todo.status] + '（' + todo.status + '）'),
        kv('优先级', model.PRIORITY_LABEL[todo.priority] + '（' + todo.priority + '）'),
        kv('标识', todo.id, true))),
      el('div', { class: 'note-block' }, [
        el('h4', { text: '备注' }),
        el('p', { class: 'note-text', id: 'view-note', text: todo.note || '（无备注）' }),
      ]),
      el('div', { class: 'panel-actions' }, [
        el('button', { class: 'btn primary', dataset: { act: 'edit', id: todo.id }, text: '编辑' }),
        el('button', {
          class: 'btn', dataset: { act: 'toggle-status', id: todo.id },
          text: done ? '恢复为未完成' : '标记完成',
        }),
        el('button', { class: 'btn danger-ghost', dataset: { act: 'delete', id: todo.id }, text: '删除…' }),
      ]),
    ]);
  }
  /* ---------------------------------------------------------- 渲染：表单面板 */

  function field(id, label, control, error, counterText) {
    return el('div', { class: 'field' + (error ? ' has-error' : '') }, [
      el('label', { class: 'field-label', for: id }, [
        el('span', { text: label }),
        counterText ? el('span', { class: 'counter', dataset: { counter: id }, text: counterText }) : null,
      ]),
      control,
      error ? el('span', { class: 'field-error', text: error }) : null,
    ]);
  }

  /** 新增 / 编辑共用一个表单：字段、校验提示、动作按钮完全一致 */
  function renderFormPanel(view) {
    const isEdit = view.mode === 'edit';
    const draft = view.draft || { values: { title: '', note: '', priority: 'normal' } };
    const values = draft.values;
    const errors = view.errors || {};

    const form = el('form', {
      class: 'panel-card form-card',
      id: isEdit ? 'panel-edit' : 'panel-add',
      novalidate: true,
    }, [
      el('div', { class: 'panel-title-row' }, [
        el('h2', { class: 'panel-title', text: isEdit ? '编辑待办' : '新建待办' }),
        view.draftDirty ? el('span', { class: 'dirty-chip', id: 'dirty-chip', text: '未保存' }) : null,
        el('span', { class: 'muted-note', text: isEdit ? '修改后点击保存生效' : '标题为必填项' }),
      ]),

      field('f-title', '标题', el('input', {
        id: 'f-title', class: 'input', type: 'text', spellcheck: 'false', autocomplete: 'off',
        maxlength: String(model.LIMIT.title), placeholder: '例如：整理本周周报',
        value: values.title, dataset: { field: 'title' },
      }), errors.title, String(values.title.length) + ' / ' + model.LIMIT.title),

      /* 分类：默认预选（新建时预选上次用过的分类），校验失败时给出文字提示 */
      el('div', { class: 'field' + (errors.categoryId ? ' has-error' : '') }, [
        el('label', { class: 'field-label' }, [
          el('span', { text: '分类' }),
          el('span', { class: 'counter', text: '必须选择 · 记住上次选择' }),
        ]),
        el('div', {
          class: 'cat-picker', id: 'f-category', role: 'radiogroup', 'aria-label': '分类',
        }, view.categories.map(function (category) {
          const active = values.categoryId === category.id;
          return el('button', {
            type: 'button',
            class: 'cat-pill' + (active ? ' is-active' : ''),
            dataset: { act: 'set-category', value: category.id },
            role: 'radio',
            'aria-checked': active ? 'true' : 'false',
            style: catVars(category.color),
          }, [catDot(), el('span', { text: category.name })]);
        })),
        errors.categoryId ? el('span', { class: 'field-error', text: errors.categoryId }) : null,
      ]),

      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', for: 'f-priority' }, [el('span', { text: '优先级' })]),
        el('div', { class: 'seg', id: 'f-priority' }, model.PRIORITIES.map(function (key) {
          return el('button', {
            type: 'button',
            class: 'seg-item prio-' + key + (values.priority === key ? ' is-active' : ''),
            dataset: { act: 'set-priority', value: key },
            'aria-pressed': values.priority === key ? 'true' : 'false',
            text: model.PRIORITY_LABEL[key],
          });
        })),
      ]),

      field('f-note', '备注（可选）', el('textarea', {
        id: 'f-note', class: 'input textarea', rows: '5', spellcheck: 'false',
        maxlength: String(model.LIMIT.note), placeholder: '补充上下文、链接、验收标准…',
        dataset: { field: 'note' },
      }, [values.note]), errors.note, String(values.note.length) + ' / ' + model.LIMIT.note),

      el('div', { class: 'form-actions' }, [
        el('button', {
          type: 'submit', class: 'btn primary', id: 'btn-save', dataset: { act: 'save' },
          text: isEdit ? '保存修改' : '创建待办',
        }),
        el('button', { type: 'button', class: 'btn ghost', id: 'btn-cancel', dataset: { act: 'cancel' }, text: '取消' }),
        el('span', { class: 'hint', text: 'Enter 保存 · Esc 取消' }),
      ]),
    ]);

    return form;
  }

  /* ---------------------------------------------------------- 渲染：删除面板 */

  function renderDeletePanel(view) {
    const todo = view.selected;
    if (!todo) return renderViewPanel(view);

    return el('div', { class: 'panel-card danger-card', id: 'panel-delete' }, [
      el('div', { class: 'panel-title-row' }, [
        el('span', { class: 'status-pill danger', text: '危险操作' }),
        el('h2', { class: 'panel-title', text: '确认删除这条待办？' }),
      ]),
      el('div', { class: 'target-preview' }, [
        el('span', { class: 'dot ' + todo.status, 'aria-hidden': 'true' }),
        el('span', { class: 'target-title', id: 'delete-title', text: todo.title }),
        el('span', { class: 'prio prio-' + todo.priority, text: model.PRIORITY_LABEL[todo.priority] }),
      ]),
      el('ul', { class: 'danger-hints' }, [
        el('li', { text: '删除后无法撤销（可以先用「导出备份」留一份 JSON）。' }),
        el('li', { text: '该条目的备注与时间记录会一并移除。' }),
        el('li', { text: '其他待办不受影响，列表会立即刷新。' }),
      ]),
      el('div', { class: 'form-actions' }, [
        el('button', {
          class: 'btn danger', id: 'btn-confirm-delete',
          dataset: { act: 'confirm-delete', id: todo.id }, text: '确认删除',
        }),
        el('button', { class: 'btn ghost', id: 'btn-cancel-delete', dataset: { act: 'cancel' }, text: '取消' }),
        el('span', { class: 'hint', text: 'Esc 取消' }),
      ]),
    ]);
  }
  /* -------------------------------------------------------- 渲染：分类管理 */

  function renderCategoriesPanel(view) {
    const rows = view.categories.map(function (category) {
      const count = (view.countsByCategory[category.id] || { total: 0 }).total;
      const pending = view.pendingCategoryDelete === category.id;

      const actions = pending
        ? [
            el('button', {
              class: 'btn danger sm', id: 'btn-confirm-cat-delete',
              dataset: { act: 'confirm-delete-category', value: category.id },
              text: count ? '确认删除（' + count + ' 条转默认）' : '确认删除',
            }),
            el('button', {
              class: 'btn ghost sm', dataset: { act: 'cancel-delete-category' }, text: '取消',
            }),
          ]
        : [
            el('button', {
              class: 'btn danger-ghost sm', id: 'btn-del-cat-' + category.id,
              dataset: { act: 'ask-delete-category', value: category.id },
              disabled: category.builtin,
              title: category.builtin ? '默认分类是兜底分类，不能删除' : '删除「' + category.name + '」',
              text: '删除',
            }),
          ];

      return el('div', {
        class: 'cat-row' + (pending ? ' is-confirming' : '') + (category.builtin ? ' is-builtin' : ''),
        dataset: { cat: category.id },
      }, [
        el('button', {
          class: 'cat-swatch', dataset: { act: 'cycle-color', value: category.id },
          title: '换色：当前 ' + model.CATEGORY_COLOR_NAME[category.color] + '，点击切换到下一个',
          style: catVars(category.color),
        }, [catDot('big')]),
        el('input', {
          class: 'cat-name-input', value: category.name, spellcheck: 'false',
          maxlength: String(model.CATEGORY_LIMIT.name), 'data-cat-rename': category.id,
          'aria-label': '分类名', title: '改名后回车或点别处生效',
        }),
        el('span', { class: 'cat-count', text: count + ' 条' }),
      ].concat(actions));
    });

    return el('div', { class: 'panel-card cat-panel', id: 'panel-categories' }, [
      el('div', { class: 'panel-title-row' }, [
        el('h2', { class: 'panel-title', text: '管理分类' }),
        el('span', { class: 'muted-note', text: '点色块换色 · 改名后回车生效 · 删除分类时条目转入「默认」' }),
      ]),
      el('div', { class: 'cat-rows', id: 'cat-rows' }, rows),
      el('form', { class: 'cat-add', id: 'cat-add-form' }, [
        el('input', {
          id: 'f-new-cat', class: 'input', type: 'text', spellcheck: 'false', autocomplete: 'off',
          maxlength: String(model.CATEGORY_LIMIT.name),
          placeholder: '新分类名称，例如「学习」', 'data-cat-new': 'true',
        }),
        el('button', { type: 'submit', class: 'btn primary', id: 'btn-add-cat', text: '添加分类' }),
      ]),
      view.categoryError
        ? el('span', { class: 'field-error', id: 'cat-form-error', text: view.categoryError })
        : null,
      el('p', {
        class: 'cat-hint',
        text: '分类就是左侧列表的分组；每条待办必须属于一个分类，颜色改动会同时反映在列表、表单与详情里。',
      }),
    ]);
  }

  /* ---------------------------------------------------------- 渲染：草稿提示 */

  function renderBanner(view) {
    const banner = refs['draft-banner'];
    const badge = refs['draft-badge'];
    const draft = view.draft;
    const show = !!draft && view.draftDirty;

    badge.hidden = !show;
    banner.hidden = !show;
    if (!show) return;

    const where = draft.mode === 'edit' ? '「' + (draft.title || '未命名') + '」的编辑' : '新建待办';
    const amount = draft.values.title.trim().length;

    clear(banner);
    banner.appendChild(el('span', { class: 'banner-icon', text: '✎', 'aria-hidden': 'true' }));
    banner.appendChild(el('span', {
      class: 'banner-text', id: 'draft-text',
      text: '已保留' + where + '草稿（标题 ' + amount + ' 字，尚未保存）。',
    }));
    banner.appendChild(el('button', { class: 'btn ghost sm', dataset: { act: 'resume-draft' }, text: '继续编辑' }));
    banner.appendChild(el('button', { class: 'btn danger-ghost sm', dataset: { act: 'discard-draft' }, text: '放弃草稿' }));
  }

  /* ------------------------------------------------------ 渲染：状态栏 / 提示 */

  function renderStoreState(state, detail) {
    const labels = { saving: '保存中…', saved: '已保存', error: '保存失败' };
    const box = refs['store-state'];
    box.className = 'store-state ' + (state || 'idle');
    clear(box);
    box.appendChild(el('span', { class: 'sdot', 'aria-hidden': 'true' }));
    box.appendChild(el('span', { text: labels[state] || '就绪' }));
    if (detail) box.title = detail;
  }

  function renderEnv(info) {
    refs['env-info'].textContent = [(info && info.runtime) || '', (info && info.host) || '']
      .filter(Boolean).join(' · ');
  }

  /** 轻提示：成功 / 失败 / 信息，自动消退，点击可立即关闭 */
  function toast(kind, text, opts) {
    const options = opts || {};
    const node = el('div', { class: 'toast toast-' + kind, role: 'status' }, [
      el('span', {
        class: 'toast-icon', 'aria-hidden': 'true',
        text: kind === 'success' ? '✓' : (kind === 'error' ? '!' : 'i'),
      }),
      el('span', { class: 'toast-text', text: text }),
    ]);
    refs.toasts.appendChild(node);
    requestAnimationFrame(function () { node.classList.add('is-in'); });

    let done = false;
    function dismiss() {
      if (done) return;
      done = true;
      node.classList.remove('is-in');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    }
    node.addEventListener('click', dismiss);
    setTimeout(dismiss, options.duration || 2600);
    return node;
  }

  /* ------------------------------------------------------------ 渲染：总入口 */

  /** 按 view 全量重绘；重建前记住焦点字段，重建后恢复（不打断输入） */
  function render(view) {
    renderStats(view.stats);
    renderTheme(view);
    renderList(view);
    renderTabs(view);
    renderBanner(view);

    const body = refs['panel-content'];
    const active = doc.activeElement;
    const fieldName = active && active.dataset ? active.dataset.field : null;
    const caret = fieldName && typeof active.selectionStart === 'number' ? active.selectionStart : null;

    clear(body);
    if (view.mode === 'add' || view.mode === 'edit') body.appendChild(renderFormPanel(view));
    else if (view.mode === 'delete') body.appendChild(renderDeletePanel(view));
    else if (view.mode === 'categories') body.appendChild(renderCategoriesPanel(view));
    else body.appendChild(renderViewPanel(view));

    if (fieldName) {
      const next = body.querySelector('[data-field="' + fieldName + '"]');
      if (next) {
        next.focus();
        if (caret != null && typeof next.setSelectionRange === 'function') {
          try { next.setSelectionRange(caret, caret); } catch (_e) { /* 忽略 */ }
        }
      }
    }
  }

  /** 把焦点放到某个表单字段（进入表单模式时用） */
  function focusField(name) {
    const node = refs['panel-content'].querySelector('[data-field="' + name + '"]');
    if (node) {
      node.focus();
      if (typeof node.select === 'function') node.select();
    }
  }

  /** 校验失败时的抖动反馈 */
  function shake(node) {
    if (!node) return;
    node.classList.remove('is-shake');
    void node.offsetWidth; // 强制重排，让动画能连续触发
    node.classList.add('is-shake');
  }

  NS.ui = {
    el: el, clear: clear, mount: mount, refs: refs, MODE_LABEL: MODE_LABEL,
    renderStats: renderStats, renderTheme: renderTheme, renderList: renderList, renderTabs: renderTabs,
    renderViewPanel: renderViewPanel, renderFormPanel: renderFormPanel, renderDeletePanel: renderDeletePanel,
    renderCategoryGroup: renderCategoryGroup, renderFocusChip: renderFocusChip,
    renderCategoriesPanel: renderCategoriesPanel,
    renderBanner: renderBanner, renderStoreState: renderStoreState, renderEnv: renderEnv,
    toast: toast, render: render, focusField: focusField, shake: shake,
  };
})(typeof window !== 'undefined' ? window : globalThis);

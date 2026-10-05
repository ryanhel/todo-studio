/* =============================================================================
 * 端到端自检（真实 WebKit + 真实 tiny.store，驱动真实 UI）
 * -----------------------------------------------------------------------------
 *   node tools/build-selftest.js
 *   TINYJS_HTML="$(pwd)/tools/build/selftest.html" tinyjs dev
 *
 * 覆盖：唯一入口约束 / 空态引导 / 新建（含分类选择）/ 校验拦截 / 草稿保留 /
 *       分类管理（新增·改名·换色·删除转移）/ 分类分组折叠 / 只看某分类 /
 *       整表与条目折叠 / 编辑 / 删除二次确认 / Esc / 外观单按钮切换 + 跟随系统实时响应 /
 *       跨页面重载的持久化 / 深浅两套 UI 快照
 *
 * 分两阶段跑（用 tiny.store 标记跨页面重载接力）：
 *   phase0 → 清空存储，重载
 *   phase1 → 交互与断言，存期望快照，重载
 *   phase2 → 校验重载后数据仍在，导出快照，打印结果并退出
 * ========================================================================== */
(function (root) {
  'use strict';

  const NS = root.TodoApp;
  const model = NS.model;
  const ctl = NS.controller;
  const doc = root.document;

  const PHASE_KEY = 'selftest.phase';
  const EXPECT_KEY = 'selftest.expect';
  const ITEMS_KEY = 'todo.items.v1';
  const CATS_KEY = 'todo.categories.v1';
  const UI_KEY = 'todo.ui.v1';

  const results = [];
  const pageErrors = [];
  let failed = 0;

  root.addEventListener('error', (e) => pageErrors.push('error: ' + (e.message || e.type)));
  root.addEventListener('unhandledrejection', (e) => pageErrors.push('rejection: ' + e.reason));

  function say(message) {
    try { return root.__invoke(JSON.stringify({ method: 'log', params: { msg: message } })); }
    catch (_e) { return Promise.resolve(); }
  }

  function check(name, ok, detail) {
    results.push({ name: name, ok: !!ok, detail: detail || '' });
    if (!ok) {
      failed++;
      say('SELFTEST FAIL · ' + name + (detail ? ' :: ' + detail : ''));
    }
    return !!ok;
  }

  function equal(name, actual, expected) {
    return check(name, actual === expected,
      'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
  }

  /* --------------------------------------------------------------- 小工具 */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (sel) => doc.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(doc.querySelectorAll(sel));
  const text = (sel) => { const node = $(sel); return node ? node.textContent.trim() : ''; };
  const shown = (sel) => { const node = $(sel); return !!node && !node.hasAttribute('hidden'); };
  const themeAttr = () => doc.documentElement.getAttribute('data-theme');
  const titles = () => ctl.state.items.map((t) => t.title).sort();
  const byTitle = (title) => ctl.state.items.filter((t) => t.title === title)[0];
  const catByName = (name) => ctl.state.categories.filter((c) => c.name === name)[0];
  const catName = (id) => { const c = model.categoryById(ctl.state.categories, id); return c ? c.name : null; };

  function toastInfo() {
    const nodes = $$('.toast');
    return 'toast数=' + nodes.length +
      (nodes.length ? ' 末个=' + JSON.stringify(nodes[nodes.length - 1].textContent.trim()) : '');
  }

  function hasToast(kind, contains) {
    return $$('.toast-' + kind).some((n) => n.textContent.indexOf(contains) >= 0);
  }

  function click(target) {
    const node = typeof target === 'string' ? $(target) : target;
    if (!node) throw new Error('click: 未找到 ' + target);
    node.dispatchEvent(new root.MouseEvent('click', { bubbles: true, cancelable: true }));
    return node;
  }

  function type(sel, value) {
    const node = typeof sel === 'string' ? $(sel) : sel;
    if (!node) throw new Error('type: 未找到 ' + sel);
    node.value = value;
    node.dispatchEvent(new root.Event('input', { bubbles: true }));
    return node;
  }

  /** 表单提交（等价于点保存按钮：同一个 submit 事件） */
  function submit(formSel) {
    const form = $(formSel);
    if (!form) throw new Error('submit: 未找到 ' + formSel);
    form.dispatchEvent(new root.Event('submit', { bubbles: true, cancelable: true }));
  }

  /** 改名走 change（回车 / 失焦）路径 */
  function rename(catId, name) {
    const input = $('[data-cat-rename="' + catId + '"]');
    if (!input) throw new Error('rename: 未找到分类输入框 ' + catId);
    input.value = name;
    input.dispatchEvent(new root.Event('change', { bubbles: true }));
  }

  function press(key) {
    const target = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : doc;
    target.dispatchEvent(new root.KeyboardEvent('keydown', {
      key: key, bubbles: true, cancelable: true,
    }));
  }

  /** 取一条待办的分类归属（按标题） */
  function catOf(title) {
    const todo = byTitle(title);
    return todo ? catName(todo.categoryId) : null;
  }

  async function waitReady() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (NS.ready === true) return true;
      await sleep(25);
    }
    return false;
  }
  /* ------------------------------------- phase1（上）：入口约束 / 新建 / 校验 */

  async function phaseOne() {
    // 上一次运行可能中断在半途（比如断言抛错）：phase1 自己保证从干净状态开跑，
    // 否则残留数据会让后面所有计数断言集体漂移。清场最多重试两次，
    // 之后直接报错终止 —— 宁可红灯，也不要无限重载把进程拖死。
    if (ctl.state.items.length > 0) {
      const attempts = (await root.tiny.store.get('selftest.resetAttempts')) || 0;
      if (attempts >= 2) {
        await root.tiny.store.delete('selftest.resetAttempts');
        say('SELFTEST 无法清空残留数据（items=' + ctl.state.items.length + '），已终止以免无限重载');
        return;
      }
      await root.tiny.store.set('selftest.resetAttempts', attempts + 1);
      await root.tiny.store.delete(ITEMS_KEY);
      await root.tiny.store.delete(CATS_KEY);
      await root.tiny.store.delete(UI_KEY);
      say('SELFTEST 检测到残留数据，清空后重跑 phase1（第 ' + (attempts + 1) + ' 次）');
      await sleep(220);
      root.location.reload();
      return;
    }
    await root.tiny.store.delete('selftest.resetAttempts');

    say('SELFTEST phase1：入口约束 / 新建 / 校验 / 分类 / 折叠 / 编辑 / 删除 / 外观');

    /* 1) 入口约束：新建唯一、折叠唯一 */
    check('全页只有一个「新建」控件', $$('[data-act="new"]').length === 1,
      'data-act=new 数量=' + $$('[data-act="new"]').length);
    check('列表折叠只有一处视觉控件', $$('[data-act="toggle-list"]').length === 1,
      '数量=' + $$('[data-act="toggle-list"]').length);
    check('顶栏不再有第二个折叠按钮', !$('#btn-toggle-list'));

    /* 2) 空态：只给引导，不放并列按钮 */
    check('空列表展示引导占位', shown('#empty') && text('#empty').indexOf('还没有待办事项') >= 0);
    check('空态里没有并排的新建按钮', !$('#empty .btn'));
    check('空态文案指向唯一入口', text('#empty').indexOf('＋ 新建待办') >= 0);
    check('面板占位态也没有并列按钮',
      !!$('#panel-placeholder') && !$('#panel-placeholder .btn'));

    /* 3) 种子分类 */
    equal('首次运行有四类（工作 / 生活 / 周末 / 默认）', ctl.state.categories.length, 4);
    check('包含工作分类', !!catByName('工作'));
    check('默认分类被标记为内置（不可删）', !!(model.categoryById(ctl.state.categories, model.DEFAULT_CATEGORY_ID) || {}).builtin);
    check('空列表时不渲染空分组，只给引导卡', $$('.group').length === 0 && shown('#empty'));

    /* 4) 新建：真实点击 → 输入 → 选分类 → 提交 */
    click('#btn-new');
    equal('进入新建模式', ctl.state.mode, 'add');
    check('标题输入框自动聚焦', doc.activeElement === $('#f-title'));
    check('模式条显示不可点击的"新建"状态牌', !!$('#tab-add-indicator') && $('#tab-add-indicator').tagName === 'SPAN');
    check('状态牌不是控件（无 data-act）', !$('#tab-add-indicator').dataset.act);
    check('分类选择器已渲染', $$('#f-category .cat-pill').length === 4);
    check('分类默认已预选（无需用户先选）', !!$('#f-category .cat-pill.is-active'));

    type('#f-title', '  写一份周报  ');
    type('#f-note', '包含本周进展与下周计划，周五下班前发出');
    click('.seg-item.prio-high');
    click('[data-act="set-category"][data-value="cat-work"]');
    equal('草稿分类已切到工作', ctl.state.draft.values.categoryId, 'cat-work');
    check('草稿标记为未保存', ctl.state.draft.dirty === true);

    submit('#panel-add');
    await sleep(150);
    equal('列表新增 1 条', ctl.state.items.length, 1);
    equal('标题首尾空格被裁掉', ctl.state.items[0].title, '写一份周报');
    equal('优先级已保存', ctl.state.items[0].priority, 'high');
    equal('分类已保存到条目', ctl.state.items[0].categoryId, 'cat-work');
    equal('保存后回到查看模式', ctl.state.mode, 'view');
    check('新条目被选中高亮', !!$('.item.is-selected'));
    equal('面板显示该条详情', text('#view-title'), '写一份周报');
    check('详情里显示分类胶囊', (text('.cat-chip') || '').indexOf('工作') >= 0);
    check('创建提示里带出分类名', hasToast('success', '已创建：写一份周报（工作）'), toastInfo());
    equal('草稿已清空', ctl.state.draft, null);

    /* 5) 校验：空标题 */
    click('#btn-new');
    equal('新建预选了上次用过的分类', ctl.state.draft.values.categoryId, 'cat-work');
    type('#f-title', '    ');
    submit('#panel-add');
    await sleep(90);
    check('空标题被拦截并显示字段错误',
      !!$('.field.has-error') && text('.field-error').indexOf('不能为空') >= 0);
    equal('仍停留在新建模式', ctl.state.mode, 'add');
    equal('数据未被写入', ctl.state.items.length, 1);
    check('校验失败有错误提示', hasToast('error', '标题不能为空'), toastInfo());

    /* 6) 校验：分类被清空（模拟分类失效 / 未选） */
    type('#f-title', '这条分类是空的');
    ctl.state.draft.values.categoryId = '';
    submit('#panel-add');
    await sleep(90);
    check('未选分类被拦截（校验提示）',
      text('#panel-content').indexOf('请选择分类') >= 0 || hasToast('error', '请选择分类'),
      'panel=' + JSON.stringify(text('#panel-content').slice(0, 60)));
    equal('仍未写入数据', ctl.state.items.length, 1);
    click('#btn-cancel');
    await sleep(80);
    equal('取消后回到查看', ctl.state.mode, 'view');
  }
  /* ------------------------- phase1（中）：分类管理 / 分组折叠 / 只看分类 */

  async function phaseOneDeep() {
    /* 7) 再添两条（其中一条完成），检查分类与状态两个维度联动 */
    ctl.startAdd();
    type('#f-title', '整理需求文档');
    type('#f-note', '把上周的会议结论落到文档里');
    click('[data-act="set-category"][data-value="cat-life"]');
    await ctl.saveForm();

    ctl.startAdd();
    type('#f-title', '代码评审');
    click('[data-act="set-category"][data-value="cat-weekend"]');
    click('.seg-item.prio-low');
    await ctl.saveForm();
    await sleep(100);
    equal('共 3 条待办', ctl.state.items.length, 3);
    equal('三条落在三个不同分类', new Set(ctl.state.items.map((t) => t.categoryId)).size, 3);
    check('有内容后按分类分组渲染', $$('.group').length >= 3, '分组数=' + $$('.group').length);
    check('分组标题就是分类名', (text('.group .group-title') || '') !== '');
    check('分组色点带上分类色槽', !!$('.group[data-color] .cat-dot'));

    const middle = $$('.item-check')[1];
    const middleId = middle.closest('.item').dataset.id;
    click(middle);
    await sleep(150);
    equal('状态已切到已完成', model.byId(ctl.state.items, middleId).status, 'done');
    check('已完成条目有删除线样式类', !!$('.item.is-done'));
    equal('统计里已完成数为 1', model.stats(ctl.state.items).done, 1);

    /* 8) 分类管理：新增 / 重名拦截 / 改名 / 换色 / 删除转移 */
    ctl.setMode('categories');
    equal('进入分类模式', ctl.state.mode, 'categories');
    equal('分类面板列出全部分类', $$('.cat-row').length, ctl.state.categories.length);
    check('默认分类的删除按钮被禁用',
      $('#btn-del-cat-cat-default') && $('#btn-del-cat-cat-default').disabled === true);
    check('分类行显示条目数', /\d+ 条/.test(text('.cat-count')));

    type('#f-new-cat', '学习');
    submit('#cat-add-form');
    await sleep(160);
    check('新增分类成功', !!catByName('学习'));
    equal('分类数 +1', ctl.state.categories.length, 5);
    check('新增有成功提示', hasToast('success', '已新增分类：学习'), toastInfo());

    type('#f-new-cat', '学习');
    submit('#cat-add-form');
    await sleep(140);
    check('重名被拦下并提示同名', /同名/.test(text('#cat-form-error')), 'error=' + text('#cat-form-error'));
    equal('重名未写入', ctl.state.categories.length, 5);

    const study = catByName('学习');
    rename(study.id, '学习计划');
    await sleep(160);
    equal('改名生效', (model.categoryById(ctl.state.categories, study.id) || {}).name, '学习计划');

    const colorBefore = (model.categoryById(ctl.state.categories, study.id) || {}).color;
    click('[data-act="cycle-color"][data-value="' + study.id + '"]');
    await sleep(160);
    check('换色生效',
      (model.categoryById(ctl.state.categories, study.id) || {}).color !== colorBefore,
      'before=' + colorBefore + ' after=' + (model.categoryById(ctl.state.categories, study.id) || {}).color);

    /* 给这个分类放一条待办，再删除分类，验证条目转入默认 */
    ctl.startAdd();
    type('#f-title', '复习算法');
    click('[data-act="set-category"][data-value="' + study.id + '"]');
    await ctl.saveForm();
    await sleep(120);
    equal('新条目落在指定分类', (byTitle('复习算法') || {}).categoryId, study.id);

    ctl.setMode('categories');
    click('[data-act="ask-delete-category"][data-value="' + study.id + '"]');
    await sleep(90);
    check('删除分类先进入二次确认', !!$('#btn-confirm-cat-delete'));
    check('确认按钮写明条目去向', text('#btn-confirm-cat-delete').indexOf('转默认') >= 0);
    click('#btn-confirm-cat-delete');
    await sleep(220);
    equal('分类已删除', model.categoryById(ctl.state.categories, study.id), null);
    equal('分类里的条目转入默认分类', (byTitle('复习算法') || {}).categoryId, model.DEFAULT_CATEGORY_ID);
    check('删除提示说明了转入条数', hasToast('success', '转入默认'), toastInfo());

    /* 9) 分类分组折叠 + 只看某分类 */
    const groupWithItems = $$('.group').filter((g) => g.querySelector('.item'))[0];
    const gid = groupWithItems.dataset.group;
    click(groupWithItems.querySelector('.group-toggle'));
    await sleep(100);
    check('分类分组可折叠', !!$('.group.is-collapsed[data-group="' + gid + '"]'));
    check('折叠的分组有文字反馈',
      (text('.group.is-collapsed .group-hint') || '').indexOf('已折叠') >= 0);

    const focusGroup = $$('.group').filter((g) => g.querySelector('.item'))[0];
    const focusId = focusGroup.dataset.group;
    click(focusGroup.querySelector('.group-focus'));
    await sleep(120);
    equal('只看分类已生效', ctl.state.ui.focusCategoryId, focusId);
    equal('列表只剩该分类分组', $$('.group').length, 1, 'gid=' + focusId);
    check('顶栏出现"只看"胶囊', shown('#focus-chip'));
    check('胶囊里写着分类名', text('#focus-chip').indexOf(catName(focusId)) >= 0);
    click('#focus-chip .chip-close');
    await sleep(120);
    equal('取消只看', ctl.state.ui.focusCategoryId, null);
    check('胶囊已消失', !shown('#focus-chip'));

    /* 10) 整表折叠（唯一控件）与 ⌘L 快捷键 */
    click('#list-toggle');
    await sleep(90);
    check('整表折叠提示条出现', shown('#list-collapsed-note'));
    check('整表折叠有状态类名', $('#pane-list').classList.contains('is-collapsed'));
    equal('折叠后分组不可见', root.getComputedStyle($('.groups')).display, 'none');
    press('l');   // 无修饰键不该触发
    await sleep(60);
    check('单按 L 不触发快捷键', shown('#list-collapsed-note'));
    // 快捷键监听挂在面板根节点上，所以事件要从它内部派发（真实键盘就是如此）
    NS.ui.refs.root.dispatchEvent(new root.KeyboardEvent('keydown', {
      key: 'l', metaKey: true, bubbles: true, cancelable: true,
    }));
    await sleep(90);
    check('⌘L 也能折叠 / 展开（非视觉入口）', !shown('#list-collapsed-note'));

    click('.item-chev');
    await sleep(90);
    equal('条目摘要可展开', $('.item-detail').hasAttribute('hidden'), false);
  }
  /* ------------------- phase1（下）：编辑 / 删除 / 外观 / 交接给重载验证 */

  async function phaseOneTail() {
    /* 11) 编辑：改标题 + 改分类 */
    const target = byTitle('写一份周报');
    ctl.startEdit(target.id);
    equal('进入编辑模式', ctl.state.mode, 'edit');
    equal('表单预填原值', $('#f-title').value, '写一份周报');
    check('编辑表单预选了条目所属分类',
      ($('#f-category .cat-pill.is-active') || {}).dataset && $('#f-category .cat-pill.is-active').dataset.value === target.categoryId);
    type('#f-title', '写一份周报（已修订）');
    click('[data-act="set-category"][data-value="cat-life"]');
    await ctl.saveForm();
    await sleep(150);
    check('列表反映新标题', titles().indexOf('写一份周报（已修订）') >= 0);
    equal('编辑时改分类已生效', (byTitle('写一份周报（已修订）') || {}).categoryId, 'cat-life');
    equal('编辑后回到查看模式', ctl.state.mode, 'view');

    /* 12) 删除：二次确认后才生效 */
    const victim = byTitle('复习算法');
    ctl.askDelete(victim.id);
    await sleep(90);
    equal('进入删除确认模式', ctl.state.mode, 'delete');
    equal('删除面板显示目标标题', text('#delete-title'), victim.title);
    const beforeCount = ctl.state.items.length;
    click('#btn-confirm-delete');
    await sleep(200);
    equal('确认后条数减一', ctl.state.items.length, beforeCount - 1);
    equal('被删条目已消失', titles().indexOf(victim.title), -1);
    check('删除有成功提示', hasToast('success', '已删除：'), toastInfo());

    /* 13) Esc 取消编辑：不落库 */
    const firstItem = ctl.state.items[0];
    ctl.startEdit(firstItem.id);
    type('#f-title', '这段不该被保存');
    press('Escape');
    await sleep(90);
    equal('Esc 退回查看模式', ctl.state.mode, 'view');
    equal('Esc 后数据未被改动', titles().indexOf('这段不该被保存'), -1);

    /* 14) 外观：顶栏单按钮切换 + 跟随系统的实时响应 */
    equal('默认是跟随系统', ctl.state.ui.themeMode, 'system');
    equal('顶栏只有一个外观按钮', $$('[data-act="toggle-theme"]').length, 1);
    check('并列的三档选项已移除', $$('[data-act="set-theme"]').length === 0);
    check('外观不再是并列选择组', !$('#theme-switch [role="radio"]'));

    // 跟随系统：按钮显示"当前系统外观的反面"，并挂「自动」状态牌
    const sysDark = themeAttr() === 'dark';
    equal('跟随系统时按系统设置解析外观', themeAttr(), ctl.state.systemDark ? 'dark' : 'light');
    equal('图标 = 点击后得到的模式（深色时显示浅色图标）',
      text('#theme-toggle .theme-icon'), sysDark ? '☀' : '☾');
    equal('文案与图标同一语义', text('#theme-toggle .theme-label'), sysDark ? '浅色' : '深色');
    check('跟随系统时挂着「自动」状态牌', !!$('#theme-toggle .theme-auto'));
    check('按钮提示写明当前是系统解析结果',
      ($('#theme-toggle').getAttribute('title') || '').indexOf('跟随系统') >= 0,
      $('#theme-toggle').getAttribute('title'));

    // 点一下：切到"当前所见"的反面，并退出跟随系统
    click('[data-act="toggle-theme"]');
    await sleep(140);
    check('点击后退出跟随系统', ctl.state.ui.themeMode !== 'system', ctl.state.ui.themeMode);
    equal('系统是深色就切到浅色（反之同理）', themeAttr(), sysDark ? 'light' : 'dark');
    equal('切换后按钮指向相反的一档', text('#theme-toggle .theme-icon'), sysDark ? '☾' : '☀');
    check('不再显示「自动」状态牌', !$('#theme-toggle .theme-auto'));
    check('切换外观有提示', hasToast('info', '外观已切换'), toastInfo());
    const lightColor = root.getComputedStyle($('.brand-text h1')).color;

    // 再点一次：两档之间来回切换，图标随点击立即翻转
    click('[data-act="toggle-theme"]');
    await sleep(130);
    equal('再点一次回到另一档', themeAttr(), sysDark ? 'dark' : 'light');
    const darkColor = root.getComputedStyle($('.brand-text h1')).color;
    check('两套外观的文本颜色确实不同', lightColor !== darkColor, lightColor + ' vs ' + darkColor);
    equal('主题选择已落盘', (await root.tiny.store.get(UI_KEY)).themeMode, themeAttr());

    // 显式模式的图标映射（菜单栏「切换外观」走的是同一个 setThemeMode）
    ctl.setThemeMode('dark');
    await sleep(120);
    equal('显式深色 → 显示浅色图标', text('#theme-toggle .theme-icon'), '☀');
    ctl.setThemeMode('light');
    await sleep(120);
    equal('显式浅色 → 显示深色图标', text('#theme-toggle .theme-icon'), '☾');

    // 回到自动模式：菜单栏「外观：跟随系统」是唯一入口，这里直接调它的落地函数
    ctl.setThemeMode('system');
    await sleep(110);
    equal('可以回到跟随系统', ctl.state.ui.themeMode, 'system');
    check('回到自动后重新显示「自动」状态牌', !!$('#theme-toggle .theme-auto'));

    // launcher 推送系统外观变化用的就是 window.__emit 这条通道
    const beforeEmit = themeAttr();
    root.__emit({ event: 'theme', data: { dark: beforeEmit !== 'dark' } });
    await sleep(180);
    check('系统外观变化被实时响应（无需刷新）', themeAttr() !== beforeEmit,
      'before=' + beforeEmit + ' after=' + themeAttr());
    check('跟随系统时提示了变化', hasToast('info', '系统外观变化'), toastInfo());
    equal('跟随系统时按钮图标随系统翻转',
      text('#theme-toggle .theme-icon'), themeAttr() === 'dark' ? '☀' : '☾');

    // 手动切换后：系统再变也不该影响页面（已退出跟随）
    click('[data-act="toggle-theme"]');
    await sleep(130);
    const pinned = themeAttr();
    root.__emit({ event: 'theme', data: { dark: pinned !== 'dark' } });
    await sleep(150);
    equal('手动选择后忽略系统变化', themeAttr(), pinned);
    check('手动选择后模式不再是 system', ctl.state.ui.themeMode !== 'system', ctl.state.ui.themeMode);

    ctl.setThemeMode('system');   // 收尾回到跟随系统，供重载阶段比对
    await sleep(90);

    /* 15) 存储层证据 + 交棒给重载 */
    const diskItems = await root.tiny.store.get(ITEMS_KEY);
    const diskCats = await root.tiny.store.get(CATS_KEY);
    check('条目已落盘', Array.isArray(diskItems) && diskItems.length === ctl.state.items.length);
    check('分类已落盘', Array.isArray(diskCats) && diskCats.length === ctl.state.categories.length);
    check('每条待办都挂在存在的分类上',
      ctl.state.items.every((t) => !!model.categoryById(ctl.state.categories, t.categoryId)));

    await root.tiny.store.set(EXPECT_KEY, {
      titles: titles(),
      total: ctl.state.items.length,
      done: model.stats(ctl.state.items).done,
      listCollapsed: ctl.state.ui.listCollapsed,
      filter: ctl.state.ui.filter,
      themeMode: ctl.state.ui.themeMode,
      categoryNames: ctl.state.categories.map((c) => c.name).sort(),
      categoryIds: ctl.state.items.map((t) => t.categoryId).sort(),
      phase1: { total: results.length, failed: failed, ok: results.filter((r) => r.ok).length },
    });
    say('SELFTEST phase1 完成：' + results.filter((r) => r.ok).length + '/' + results.length +
      ' 通过；重载页面验证持久化');
    await root.tiny.store.set(PHASE_KEY, 'phase2');
    await sleep(250);
    root.location.reload();
  }
  /* ------------------------------------- phase2：重载后校验 + 两套 UI 快照 */

  async function phaseTwo() {
    say('SELFTEST phase2：页面重载后校验持久化');

    const expect = await root.tiny.store.get(EXPECT_KEY);
    check('磁盘上存在期望快照', !!expect);

    equal('重载后条数一致', ctl.state.items.length, expect.total);
    check('重载后标题集合一致',
      JSON.stringify(titles()) === JSON.stringify(expect.titles),
      JSON.stringify(titles()) + ' vs ' + JSON.stringify(expect.titles));
    equal('重载后完成数一致', model.stats(ctl.state.items).done, expect.done);
    equal('重载后折叠状态一致', ctl.state.ui.listCollapsed, expect.listCollapsed);
    equal('重载后主题选择一致', ctl.state.ui.themeMode, expect.themeMode);
    check('重载后分类集合一致',
      JSON.stringify(ctl.state.categories.map((c) => c.name).sort()) === JSON.stringify(expect.categoryNames),
      JSON.stringify(ctl.state.categories.map((c) => c.name).sort()) + ' vs ' + JSON.stringify(expect.categoryNames));
    check('重载后条目分类归属一致',
      JSON.stringify(ctl.state.items.map((t) => t.categoryId).sort()) === JSON.stringify(expect.categoryIds));
    check('重载后仍按分类分组渲染',
      $$('.group').length >= 1 && $$('.group .group-title').length >= 1);
    check('重载后每条都挂在存在的分类上',
      ctl.state.items.every((t) => !!model.categoryById(ctl.state.categories, t.categoryId)));

    /* 造一份适合人工审阅的状态，导出深浅两套 UI 快照 */
    const cats = ctl.state.categories;
    const seed = [
      { title: '给新版本写发布说明', note: '列出本次改动、升级注意事项与已知问题；发到内网公告板。', priority: 'high' },
      { title: '整理本周会议纪要', note: '把决策项与待办分派写进共享文档，抄送相关同学。', priority: 'normal' },
      { title: '预订周末的网球场地', note: '周六下午三点，两个场地，叫上老王。', priority: 'low' },
    ];
    for (let i = 0; i < seed.length; i++) {
      ctl.startAdd();
      type('#f-title', seed[i].title);
      type('#f-note', seed[i].note);
      click('[data-act="set-category"][data-value="' + cats[i % cats.length].id + '"]');
      await ctl.saveForm();
    }
    const third = $$('.item-check')[2];
    if (third) { click(third); await sleep(150); }
    ctl.select(ctl.state.items[0].id);
    await sleep(110);
    const chev = $('.item .item-chev');
    if (chev) { click(chev); await sleep(130); }

    async function shot(path) {
      try { return await root.tiny.win.printToPDF(path); } catch (error) { return { error: String(error) }; }
    }

    // 单按钮切换：最多点两次对齐到深色（不用管当前在哪一档）
    for (let i = 0; i < 2 && themeAttr() !== 'dark'; i += 1) {
      click('[data-act="toggle-theme"]');
      await sleep(180);
    }
    equal('深色快照前已切到深色', themeAttr(), 'dark');
    const dark = await shot('/tmp/todo-ui-dark.pdf');
    check('深色 UI 快照已导出', !!(dark && dark.path), JSON.stringify(dark));

    click('[data-act="toggle-theme"]');
    await sleep(240);
    equal('浅色快照前已切到浅色', themeAttr(), 'light');
    const light = await shot('/tmp/todo-ui-light.pdf');
    check('浅色 UI 快照已导出', !!(light && light.path), JSON.stringify(light));

    ctl.setThemeMode('system');    // 复位成跟随系统
    await sleep(120);

    /* 复位阶段标记，方便反复运行 */
    await root.tiny.store.delete(PHASE_KEY);
    await root.tiny.store.delete(EXPECT_KEY);

    /* ------------------------------------------------------------- 汇总 */
    const phase1 = (expect && expect.phase1) || { total: 0, ok: 0, failed: 0 };
    const okCount = results.filter((r) => r.ok).length;
    const failedAll = phase1.failed + failed;
    const totalAll = phase1.total + results.length;

    results.filter((r) => !r.ok).forEach((r) => say('SELFTEST FAIL · ' + r.name + ' :: ' + r.detail));
    pageErrors.forEach((e) => say('SELFTEST 页面异常 · ' + e));
    say('SELFTEST 汇总：' + (totalAll - failedAll) + '/' + totalAll + ' 通过' +
      '（phase1 ' + phase1.ok + '/' + phase1.total + '，phase2 ' + okCount + '/' + results.length + '）' +
      '，失败 ' + failedAll + '，页面异常 ' + pageErrors.length);
    say(failedAll === 0 && pageErrors.length === 0 ? 'SELFTEST ALL PASS' : 'SELFTEST HAS FAILURES');

    await sleep(300);
    await root.__invoke(JSON.stringify({ method: 'quit', params: {} }));
  }

  (async () => {
    try {
      if (!(await waitReady())) {
        say('SELFTEST 失败：应用未在 8s 内就绪');
        pageErrors.forEach((e) => say('SELFTEST 现场 · 页面异常 ' + e));
        (root.__BOOT_LOG || []).forEach((line) => say('SELFTEST 现场 · 启动日志 ' + line));
        return;
      }

      const phase = await root.tiny.store.get(PHASE_KEY);
      if (!phase) {
        await root.tiny.store.delete(ITEMS_KEY);
        await root.tiny.store.delete(CATS_KEY);
        await root.tiny.store.delete(UI_KEY);
        await root.tiny.store.set(PHASE_KEY, 'phase1');
        say('SELFTEST 已清空存储，重载页面（phase1 开始）');
        await sleep(250);
        root.location.reload();
        return;
      }
      if (phase === 'phase1') {
        await phaseOne();
        await phaseOneDeep();
        await phaseOneTail();
        return;
      }
      if (phase === 'phase2') { await phaseTwo(); return; }
      say('SELFTEST 未知阶段：' + phase);
    } catch (error) {
      say('SELFTEST 异常终止：' + (error && error.stack ? error.stack : error));
    }
  })();
})(typeof window !== 'undefined' ? window : globalThis);

/* =============================================================================
 * 待办中心 · 命名空间与运行时桥接
 * -----------------------------------------------------------------------------
 * 1) 建立全局命名空间 window.TodoApp，各模块挂载其上（经典脚本模式）。
 * 2) 统一封装对 tinyjs 页面 API 的访问：tiny 缺失时优雅降级，
 *    这样同一个前端也能在普通浏览器里打开做样式调试。
 * ========================================================================== */
(function (root) {
  'use strict';

  const NS = (root.TodoApp = root.TodoApp || {});
  const hasTiny = typeof root.tiny === 'object' && root.tiny !== null;

  /** 系统是否偏好深色（纯媒体查询版本，主题降级链的最后一环） */
  function matchMediaDark() {
    try {
      const mq = root.matchMedia('(prefers-color-scheme: dark)');
      return !!(mq && mq.matches);
    } catch (_e) {
      return true; // 查询不到就按深色（本应用的默认外观）
    }
  }

  NS.const = {
    APP_NAME: '待办中心',
    APP_NAME_EN: 'TODO Studio',
    VERSION: '0.3.0',
  };

  /**
   * tinyjs 桥接层：页面侧所有 tiny.* 调用都从这里走。
   * 每个方法在 tiny 不可用时都不会抛错，只返回安全默认值。
   */
  NS.bridge = {
    available: hasTiny,

    /** 调用后端 api.<method> */
    async call(method, params) {
      if (!hasTiny) return null;
      return root.tiny.api.call(method, params);
    },

    /** 原生确认框（删除二次确认的兜底）；不可用时返回 null 由调用方决定 */
    async confirm(title, opts) {
      if (!hasTiny) return null;
      return root.tiny.dialog.confirm(title, opts);
    },

    /**
     * 系统通知。页面 API 是顶层的 tiny.notify(title, body, opts)：
     *   - 打包后的 .app 里由 bundle 内的 launcher 出"通知中心"横幅（带应用图标、
     *     首次弹权限请求，点击回流到 notification-click）
     *   - `tinyjs dev`（没有 bundle）在 macOS 上回落成 osascript，横幅来源显示为"脚本编辑器"
     * 永不抛错：失败只返回 false，所以可以即发即忘。
     */
    async notify(title, body, opts) {
      if (!hasTiny || typeof root.tiny.notify !== 'function') return false;
      try { return await root.tiny.notify(title, body, opts || {}); }
      catch (_e) { return false; }
    },

    /** 通知权限：'granted' | 'denied' | 'undetermined' | 'unsupported' */
    async notifyPermission() {
      if (!hasTiny || !root.tiny.app || !root.tiny.app.permissions) return 'unsupported';
      try { return await root.tiny.app.permissions.check('notifications'); }
      catch (_e) { return 'unsupported'; }
    },

    /** 主动请求通知权限（会弹系统对话框）；返回请求后的状态 */
    async requestNotifyPermission() {
      if (!hasTiny || !root.tiny.app || !root.tiny.app.permissions) return 'unsupported';
      try { return await root.tiny.app.permissions.request('notifications'); }
      catch (_e) { return 'unsupported'; }
    },

    /** 点击系统通知 → 回到对应待办（id 就是我们塞进通知里的待办 id） */
    onNotifyClick(fn) {
      if (!hasTiny || !root.tiny.app || !root.tiny.app.onNotificationClick) return function () {};
      try { return root.tiny.app.onNotificationClick(fn) || function () {}; }
      catch (_e) { return function () {}; }
    },

    /** 后端定时器触发提醒时推过来的事件（页面开着就能即时更新 UI） */
    onReminderDue(fn) {
      if (!hasTiny || !root.tiny.api) return function () {};
      try { return root.tiny.api.on('reminder-due', fn) || function () {}; }
      catch (_e) { return function () {}; }
    },

    /**
     * 把"哪些提醒该在什么时候弹"整体同步给后端：后端持有定时器与送达台账，
     * 因此窗口关掉、页面被节流时提醒照样到点。返回后端对齐后的日程（含台账）。
     */
    async syncReminders(list, options) {
      if (!hasTiny) return null;
      try { return await root.tiny.api.call('syncReminders', { list: list, options: options }); }
      catch (_e) { return null; }
    },

    /** 读后端当前的日程 + 台账（重开页面后用它对齐"关闭期间发生了什么"） */
    async reminderState() {
      if (!hasTiny) return null;
      try { return await root.tiny.api.call('reminderState'); }
      catch (_e) { return null; }
    },

    /** 清空后端日程（退出前 / 无提醒时收尾） */
    async clearReminders() {
      if (!hasTiny) return false;
      try { return await root.tiny.api.call('clearReminders'); }
      catch (_e) { return false; }
    },

    /** 「发送测试通知」按钮用：立即来一条系统通知 */
    async testNotify(title, body) {
      if (!hasTiny) return false;
      try { return await root.tiny.api.call('testNotification', { title: title, body: body }); }
      catch (_e) { return false; }
    },

    /** 应用信息：`tinyjs` 字段在 checkout 里跑时是 'dev'，打包后是版本号 */
    async appInfo() {
      if (!hasTiny || !root.tiny.app || !root.tiny.app.info) return null;
      try { return await root.tiny.app.info(); }
      catch (_e) { return null; }
    },

    /** 应用能力表（判系统通知是否可用：caps.notifications !== false） */
    async capabilities() {
      if (!hasTiny || !root.tiny.system || !root.tiny.system.capabilities) return null;
      try { return await root.tiny.system.capabilities(); }
      catch (_e) { return null; }
    },

    /** 把窗口调到前台（点通知后"聚焦"那一步；浏览器预览下是空操作） */
    async focusWindow() {
      if (!hasTiny || !root.tiny.win || !root.tiny.win.show) return false;
      try { await root.tiny.win.show(); return true; }
      catch (_e) { return false; }
    },

    /** 当前窗口是否在前台（决定"要不要再补一条应用内提示"） */
    async windowFocused() {
      if (!hasTiny || !root.tiny.win || !root.tiny.win.getState) return null;
      try {
        const state = await root.tiny.win.getState();
        return !!(state && state.focused);
      } catch (_e) { return null; }
    },

    /**
     * 登录时自动启动状态（"应用没打开也能提醒"要靠它常驻）：
     * 'enabled' | 'disabled' | 'requires-approval' | 'unsupported' | null（读不到）
     */
    async loginItem() {
      if (!hasTiny || !root.tiny.app || !root.tiny.app.launchAtLogin) return null;
      try { return await root.tiny.app.launchAtLogin.get(); }
      catch (_e) { return null; }
    },

    /** 开关登录项；返回新的状态字符串（同上） */
    async setLoginItem(enabled) {
      if (!hasTiny || !root.tiny.app || !root.tiny.app.launchAtLogin) return null;
      try { return await root.tiny.app.launchAtLogin.set(!!enabled); }
      catch (_e) { return null; }
    },

    /**
     * 把系统的"通知"设置页调到前台（被拒绝后的引导）。
     * 只有 macOS 认这个私有 URL；其他平台返回 false，由调用方给文字指引。
     */
    async openNotificationSettings() {
      if (!hasTiny || !root.tiny.app || !root.tiny.app.shell) return false;
      const urls = [
        'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
        'x-apple.systempreferences:com.apple.preference.notifications',
      ];
      for (let i = 0; i < urls.length; i++) {
        try { await root.tiny.app.shell.open(urls[i]); return true; }
        catch (_e) { /* 换下一个写法 */ }
      }
      return false;
    },

    /** 把标题同步到窗口标题栏（保留应用名后缀） */
    setTitle(text) {
      if (!hasTiny) { root.document.title = text; return; }
      try { root.tiny.win.setTitle(text); } catch (_e) { /* 忽略 */ }
    },

    /** 原生菜单：设置失败不影响页面内快捷键 */
    async setMenu(menus) {
      if (!hasTiny) return false;
      try { await root.tiny.menu.set(menus); return true; }
      catch (_e) { return false; }
    },

    onMenu(fn) {
      if (!hasTiny) return;
      try { root.tiny.menu.on(fn); } catch (_e) { /* 忽略 */ }
    },

    /** 在访达 / 资源管理器中定位文件（导出备份后用） */
    reveal(path) {
      if (!hasTiny || !path) return;
      try { root.tiny.app.shell.reveal(path); } catch (_e) { /* 忽略 */ }
    },

    /**
     * 系统外观：
     *  - tiny.theme.get() 读当前系统是否深色（拿不到返回 null）
     *  - tiny.theme.on(fn) 是 launcher 主动推送的实时变更（换系统主题立刻到）
     *  - 两者都不可用时退回 matchMedia，保证浏览器预览也能跟系统走
     */
    async systemDark() {
      if (hasTiny && root.tiny.theme && root.tiny.theme.get) {
        try {
          const info = await root.tiny.theme.get();
          if (info && typeof info.dark === 'boolean') return info.dark;
        } catch (_e) { /* 落到 matchMedia */ }
      }
      return matchMediaDark();
    },

    /** 订阅系统外观变化；返回退订函数（永远可用，不会抛错） */
    onSystemTheme(fn) {
      const unsubs = [];
      if (hasTiny && root.tiny.theme && root.tiny.theme.on) {
        try {
          const off = root.tiny.theme.on(function (value) {
            fn(typeof value === 'object' && value !== null ? !!value.dark : !!value);
          });
          if (typeof off === 'function') unsubs.push(off);
        } catch (_e) { /* 忽略 */ }
      }
      // 双保险：WebKit 的媒体查询在任何环境都可用
      try {
        const mq = root.matchMedia('(prefers-color-scheme: dark)');
        const handler = (ev) => fn(!!ev.matches);
        if (mq.addEventListener) { mq.addEventListener('change', handler); unsubs.push(() => mq.removeEventListener('change', handler)); }
        else if (mq.addListener) { mq.addListener(handler); unsubs.push(() => mq.removeListener(handler)); }
      } catch (_e) { /* 忽略 */ }
      return function () { unsubs.forEach((off) => { try { off(); } catch (_e) {} }); };
    },

    /** 勾选/禁用原生菜单项（外观三项用它显示当前选择） */
    async updateMenu(id, patch) {
      if (!hasTiny) return false;
      try { await root.tiny.menu.update(id, patch); return true; }
      catch (_e) { return false; }
    },

    /** 只读的环境信息（用于底部状态栏的"科技感"尾注） */
    async info() {
      if (!hasTiny) return { runtime: '浏览器预览', host: root.location.host || 'local' };
      try { return await root.tiny.api.call('info'); }
      catch (_e) { return { runtime: 'unknown', host: 'unknown' }; }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);

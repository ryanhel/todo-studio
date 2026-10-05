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
    VERSION: '0.1.0',
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

    /** 轻提示：优先系统通知，失败则忽略（页面内另有 toast） */
    async notify(title, body) {
      if (!hasTiny) return false;
      try { return await root.tiny.app.notify({ title: title, body: body }); }
      catch (_e) { return false; }
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

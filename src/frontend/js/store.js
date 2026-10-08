/* =============================================================================
 * 待办中心 · 持久化层
 * -----------------------------------------------------------------------------
 * 页面不直接接触 tiny.store：这里把它包成"驱动器"抽象 + 状态回调，于是
 *   1) 前端只有这一处写入口；
 *   2) 自检脚本 / 浏览器预览可以注入内存驱动器；
 *   3) 每次读写的成功失败都能被底部"保存状态"指示器呈现。
 *
 * 真实数据落在 tinyjs 的 per-app 数据目录（tiny.app.paths().data），
 * 关闭应用、刷新页面都不会丢。
 * ========================================================================== */
(function (root) {
  'use strict';

  const NS = (root.TodoApp = root.TodoApp || {});

  /** 存储键：带版本后缀，将来结构升级可并存 / 迁移 */
  const KEYS = {
    items: 'todo.items.v1',        // Todo[]（每条带 categoryId 与可选的 reminder）
    categories: 'todo.categories.v1', // Category[]：{ id, name, color, builtin, createdAt }
    ui: 'todo.ui.v1',              // { themeMode, listCollapsed, collapsedCategories,
                                   //   focusCategoryId, expanded, filter, selectedId, lastCategoryId }
    settings: 'todo.settings.v1',  // { notifications: { enabled, sound, dndEnabled, dndFrom, dndTo, catchUp } }
  };

  /** 内存驱动器：浏览器预览 / 单测 / tiny 不可用时使用 */
  function memoryDriver() {
    const map = new Map();
    return {
      name: 'memory',
      async get(key) {
        return map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null;
      },
      async set(key, value) {
        map.set(key, JSON.parse(JSON.stringify(value)));
      },
      async remove(key) {
        map.delete(key);
      },
    };
  }

  /** tinyjs 驱动器：落盘存储（JSON，写进 per-app 数据目录） */
  function tinyDriver(tiny) {
    return {
      name: 'tiny.store',
      async get(key) { return tiny.store.get(key); },
      async set(key, value) { return tiny.store.set(key, value); },
      async remove(key) { return tiny.store.delete(key); },
    };
  }

  /**
   * 构造存储实例。
   * @param {{name:string,get:Function,set:Function,remove:Function}} driver
   * @param {(state:'saving'|'saved'|'error', detail?:string)=>void} [onStatus]
   */
  function create(driver, onStatus) {
    let lastError = null;

    function report(state, detail) {
      try { if (onStatus) onStatus(state, detail); } catch (_e) { /* 状态回调不参与业务 */ }
    }

    async function read(key, fallback) {
      try {
        const value = await driver.get(key);
        return value == null ? fallback : value;
      } catch (e) {
        lastError = String(e);
        report('error', lastError);
        return fallback;
      }
    }

    async function write(key, value) {
      report('saving');
      try {
        await driver.set(key, value);
        lastError = null;
        report('saved');
        return true;
      } catch (e) {
        lastError = String(e);
        report('error', lastError);
        return false;
      }
    }

    return {
      driverName: driver.name,

      async loadItems() {
        return NS.model.sanitize(await read(KEYS.items, []));
      },
      async saveItems(items) {
        return write(KEYS.items, items);
      },
      /** 从没存过分类 → 种子分类；存过 → 归一化（保证默认分类一定存在） */
      async loadCategories() {
        const raw = await read(KEYS.categories, null);
        return raw == null ? NS.model.defaultCategories() : NS.model.sanitizeCategories(raw);
      },
      async saveCategories(categories) {
        return write(KEYS.categories, categories);
      },
      async loadUi() {
        const raw = await read(KEYS.ui, null);
        return raw && typeof raw === 'object' ? raw : null;
      },
      async saveUi(ui) {
        return write(KEYS.ui, ui);
      },
      /** 通知设置：读不到就返回默认值（model.DEFAULT_NOTIFICATIONS） */
      async loadSettings() {
        const raw = await read(KEYS.settings, null);
        const source = raw && typeof raw === 'object' ? raw : {};
        return { notifications: NS.model.sanitizeNotifications(source.notifications) };
      },
      async saveSettings(settings) {
        return write(KEYS.settings, settings);
      },
      async clearAll() {
        try {
          await driver.remove(KEYS.items);
          await driver.remove(KEYS.categories);
          await driver.remove(KEYS.ui);
          await driver.remove(KEYS.settings);
          lastError = null;
          report('saved');
          return true;
        } catch (e) {
          lastError = String(e);
          report('error', lastError);
          return false;
        }
      },
      lastError() { return lastError; },
    };
  }

  NS.persistence = {
    KEYS: KEYS,
    memoryDriver: memoryDriver,
    tinyDriver: tinyDriver,
    create: create,
    /** 按当前环境自动选择驱动器 */
    autoCreate(onStatus) {
      const tiny = root.tiny;
      if (tiny && tiny.store) return create(tinyDriver(tiny), onStatus);
      return create(memoryDriver(), onStatus);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);

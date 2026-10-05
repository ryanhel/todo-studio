/* =============================================================================
 * 待办中心 · 后端（txiki.js）
 * -----------------------------------------------------------------------------
 * 只做页面做不到的两件事，业务数据一律走页面的 tiny.store（per-app 数据目录）：
 *   1) info()         读运行时 / 主机信息，供底部状态栏显示；
 *   2) exportBackup() 把页面导出的 JSON 写进应用数据目录（真实文件系统访问）。
 *
 * api 方法签名：(params, app, meta) —— app.paths 是后端侧的对象（不是 Promise）。
 * ========================================================================== */

const encoder = new TextEncoder();

/** 时间戳里不能出现的字符换成 '-'，得到一个可排序的文件名后缀 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
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
};

/** 窗口起来后不做后台任务；保留 init 以便后续扩展（如定时备份）。 */
export function init(_app) {}

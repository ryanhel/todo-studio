/* =============================================================================
 * 生成自包含的端到端自检页
 *   node tools/build-selftest.js      →  tools/build/selftest.html
 *
 * 为什么需要它：TINYJS_HTML 指定的页面会被 tinyjs 的 bridge 物化到私有临时
 * 目录（runtime/bridge.js: "TINYJS_HTML env override (self-contained test
 * pages): materialized"），相对路径的 js/、css 因此都取不到 —— 所以自检页
 * 必须把样式与脚本全部内联成单个文件。
 *
 * 内联的正是 index.html 加载的同一批源码，顺序也一致；只有加载方式不同。
 *
 * 产物刻意放在 tools/build/ 而不是 src/frontend/：tinyjs 的构建会把
 * src/frontend 整个复制进 dist，测试页面与驱动不该混进发布包。
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..', 'src', 'frontend');
const OUT_DIR = path.join(__dirname, 'build');
const OUT = path.join(OUT_DIR, 'selftest.html');

/* 与 index.html 完全相同的加载顺序；驱动脚本来自 tools/（不进发布包） */
const SCRIPTS = [
  'js/app-ns.js',
  'js/model.js',
  'js/store.js',
  'js/ui.js',
  'js/app.js',
];
const DRIVER = path.join(__dirname, 'selftest.js');

function read(relative) {
  return fs.readFileSync(path.join(FRONTEND, relative), 'utf8');
}

function readDriver() {
  return fs.readFileSync(DRIVER, 'utf8');
}

/** 内联到 <script> 里的代码不能出现字面量 </script> */
function guard(code) {
  return code.replace(/<\/script>/gi, '<\\/script>');
}

/**
 * 每个脚本块外面包一层 try/catch，并把结果记到 window.__BOOT_LOG。
 * 这样"某个文件加载期抛错"不会再静默：后续脚本照常执行，自检脚本能报到具体文件。
 */
function wrap(file, code) {
  return '<script>\ntry {\n' + code + '\n} catch (error) {\n' +
    '  (window.__BOOT_LOG = window.__BOOT_LOG || []).push(' +
    JSON.stringify(file) + ' + " 加载失败: " + error + " | " + (error && error.stack));\n' +
    '}\n</script>';
}

/** 采集更早阶段的解析错误（try/catch 抓不到语法错误） */
const PRELUDE = '<script>\n' +
  'window.__BOOT_LOG = window.__BOOT_LOG || [];\n' +
  'window.addEventListener("error", function (e) {\n' +
  '  window.__BOOT_LOG.push("error@load: " + (e.message || e.type) +\n' +
  '    (e.filename ? " @ " + e.filename : ""));\n' +
  '});\n' +
  'window.addEventListener("unhandledrejection", function (e) {\n' +
  '  window.__BOOT_LOG.push("rejection@load: " + e.reason);\n' +
  '});\n' +
  '</script>';

const styles = read('style.css');
const scripts = SCRIPTS.map((file) => ({
  file,
  code: guard(read(file)),
}));
// 最后接自检驱动（tools/selftest.js），它内部会等 NS.ready 再开跑
scripts.push({ file: 'tools/selftest.js', code: guard(readDriver()) });

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>待办中心 · 自检</title>
<!--
  本文件由 tools/build-selftest.js 生成，请勿手工编辑。
  运行（在应用目录下）：
    node tools/build-selftest.js
    TINYJS_HTML="$(pwd)/tools/build/selftest.html" tinyjs dev
  结果打印在 dev 控制台，并导出 /tmp/todo-ui-dark.pdf 与 /tmp/todo-ui-light.pdf 供人工检查界面。
-->
<style>
${styles}
</style>
</head>
<body>
<main id="app" class="app-root"></main>
${PRELUDE}
${scripts.map((s) => wrap(s.file, s.code)).join('\n')}
</body>
</html>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html);
const size = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log('已生成 ' + path.relative(process.cwd(), OUT) + '（' + size + ' KB，内联 ' +
  scripts.length + ' 个脚本 + 1 份样式）');

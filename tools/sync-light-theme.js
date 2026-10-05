/* =============================================================================
 * 浅色令牌同步（Node，零依赖）
 *   node tools/sync-light-theme.js
 *
 * style.css 里浅色令牌有两份，作用不同但内容必须逐字一致：
 *   1) :root[data-theme="light"]                    —— 用户显式选「浅色」时生效
 *   2) @media (prefers-color-scheme: light) { :root:not([data-theme]) {...} }
 *      —— JS 还没跑（或跟随系统且系统是浅色）时的首帧兜底，避免深色闪一下
 * 手写两份迟早会漂移，所以第 2 份由这个脚本从第 1 份复制而来。
 * 改浅色配色只需改第 1 份，然后跑一次本脚本。
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'src', 'frontend', 'style.css');
const ATTR_HEAD = ':root[data-theme="light"] {';
const MEDIA_HEAD = '@media (prefers-color-scheme: light) {';

const css = fs.readFileSync(FILE, 'utf8');

/** 从一个块的开头（'{' 所在行首）找到配对的花括号结尾，返回 [start, end] */
function blockBounds(source, head) {
  const start = source.indexOf(head);
  if (start < 0) throw new Error('未找到区块：' + head);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return [start, i + 1];
    }
  }
  throw new Error('花括号不配对：' + head);
}

const [attrStart, attrEnd] = blockBounds(css, ATTR_HEAD);
const attrBlock = css.slice(attrStart, attrEnd);
const inner = attrBlock.slice(attrBlock.indexOf('{') + 1, attrBlock.lastIndexOf('}'));

const [mediaStart, mediaEnd] = blockBounds(css, MEDIA_HEAD);
const mediaBlock = MEDIA_HEAD + '\n' +
  '  /* 与上一段完全相同的浅色令牌 —— 由 tools/sync-light-theme.js 生成，勿手改这一份 */\n' +
  '  :root:not([data-theme]) {' + inner + '  }\n' +
  '}';

const next = css.slice(0, mediaStart) + mediaBlock + css.slice(mediaEnd);

if (next === css) {
  console.log('浅色令牌两份已一致，无需改动');
} else {
  fs.writeFileSync(FILE, next);
  const tokens = (inner.match(/^\s*--[\w-]+:/gm) || []).length;
  console.log('已用显式浅色块刷新"跟随系统"兜底块（复制 ' + tokens + ' 个令牌）');
}

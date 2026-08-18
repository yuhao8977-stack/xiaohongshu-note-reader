'use strict';
/**
 * utils.js — 通用工具：日志、数字解析、话题/@提取、URL 解析
 * 注意：本文件绝不写入 Cookie / Token / 密码等敏感信息。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'logs', 'reader.log');

/** 确保目录存在 */
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 追加一行日志（时间/级别/内容），同时输出到控制台 */
function log(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] [${level}] ${msg}`;
  try {
    ensureDir(path.dirname(LOG_FILE));
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) { /* 日志失败不影响主流程 */ }
  console.log(line);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 解析小红书的互动数字显示，如：
 *   "123" -> {display:"123", normalized:123}
 *   "1.2万" -> {display:"1.2万", normalized:12000}
 *   "10万+" -> {display:"10万+", normalized:100000}
 *   "1千" -> {display:"1千", normalized:1000}
 *   "暂无"/"0" -> 原样返回
 * 无法确定时 normalized 为 null，绝不猜。
 */
function parseDisplayCount(input) {
  if (input === null || input === undefined) return { display: '', normalized: null };
  const t = String(input).trim();
  if (t === '') return { display: '', normalized: null };
  const pure = t.replace(/[+＋]/g, '');
  const num = parseFloat(pure.replace(/[^\d.]/g, ''));
  if (Number.isNaN(num)) return { display: t, normalized: null };
  let unit = 1;
  if (pure.includes('亿')) unit = 100000000;
  else if (pure.includes('万')) unit = 10000;
  else if (pure.includes('千')) unit = 1000;
  const normalized = Math.round(num * unit);
  return { display: t, normalized };
}

/** 从正文提取话题标签 #xxx */
function extractHashtags(text) {
  if (!text) return [];
  const re = /#([^#\s，。！？!?、；;：:"'“”‘’（）()【】\[\]{}\n]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** 从正文提取 @账号 */
function extractMentions(text) {
  if (!text) return [];
  const re = /@([^\s@，。！？!?、；;：:"'“”‘’（）()【】\[\]{}\n]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 从任意小红书链接解析 note_id（24 位十六进制） */
function parseNoteId(url) {
  if (!url) return null;
  const m = url.match(/\/item\/([0-9a-fA-F]{24})/) || url.match(/discovery\/item\/([0-9a-fA-F]{24})/);
  return m ? m[1].toLowerCase() : null;
}

/** 标准化链接：只保留 item/<note_id> */
function normalizeUrl(url) {
  const id = parseNoteId(url);
  if (!id) return url;
  return `https://www.xiaohongshu.com/discovery/item/${id}`;
}

/** 是否为分享短链（需要让浏览器自动跳转） */
function isShortLink(url) {
  return /xhslink\.com|xiaohongshu\.com\/a\//i.test(url || '');
}

/** 时间戳（毫秒）-> "YYYY-MM-DD HH:mm:ss" 本地时间 */
function formatTime(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 当前本地时间 "YYYY-MM-DD HH:mm:ss" */
function nowStr() {
  return formatTime(Date.now());
}

/** 文件名安全化 */
function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
}

module.exports = {
  ROOT, ensureDir, log, sleep, parseDisplayCount,
  extractHashtags, extractMentions, parseNoteId, normalizeUrl,
  isShortLink, formatTime, nowStr, safeName,
};

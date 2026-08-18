'use strict';
/**
 * exporter.js — 输出层
 *  - exports/json/<note_id>.json     每条笔记一个 JSON
 *  - exports/xiaohongshu_notes.csv   追加式 CSV（UTF-8 BOM，Excel 友好）
 *  - data/cache/<note_id>.json       成功结果缓存
 *  - debug/<note_id>_error.*         失败现场（截图/HTML/错误信息，仅本机）
 *  - exports/covers/<note_id>.jpg    封面下载（尽力而为）
 */
const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir, log, nowStr } = require('./utils');

const JSON_DIR = path.join(ROOT, 'exports', 'json');
const COVER_DIR = path.join(ROOT, 'exports', 'covers');
const CSV_FILE = path.join(ROOT, 'exports', 'xiaohongshu_notes.csv');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const DEBUG_DIR = path.join(ROOT, 'debug');

const CSV_HEADERS = [
  'account_name', 'note_id', 'url', 'published_at', 'title', 'body',
  'hashtags', 'like_count', 'favorite_count', 'comment_count', 'share_count',
  'note_type', 'view_count', 'video_duration', 'collected_at',
];

function csvCell(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsvRow(note) {
  return CSV_HEADERS.map(h => {
    const v = note[h];
    if (Array.isArray(v)) return csvCell(v.join(' | '));
    return csvCell(v);
  }).join(',');
}

/** 保存单条 JSON */
function saveJson(note) {
  ensureDir(JSON_DIR);
  const file = path.join(JSON_DIR, `${note.note_id}.json`);
  fs.writeFileSync(file, JSON.stringify(note, null, 2), 'utf8');
  return file;
}

/** 追加一行到 CSV（首次创建时写 BOM + 表头） */
function appendCsv(note) {
  ensureDir(path.dirname(CSV_FILE));
  const isNew = !fs.existsSync(CSV_FILE);
  const line = toCsvRow(note) + '\n';
  fs.appendFileSync(CSV_FILE, isNew ? '\uFEFF' + CSV_HEADERS.join(',') + '\n' + line : line, 'utf8');
  return CSV_FILE;
}

/** 写缓存 */
function writeCache(note) {
  ensureDir(CACHE_DIR);
  const file = path.join(CACHE_DIR, `${note.note_id}.json`);
  fs.writeFileSync(file, JSON.stringify(note, null, 2), 'utf8');
  return file;
}

/** 读缓存（不存在返回 null） */
function readCache(noteId) {
  const file = path.join(CACHE_DIR, `${noteId}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/** 列出缓存 */
function listCache() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  return fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')).sort();
}

/**
 * 保存失败现场。
 * @param {import('playwright').Page} page 可能已关闭，可为 null
 * @param {string} noteId
 * @param {string} failType
 * @param {string} message
 * @param {string|null} html 页面 HTML 快照
 */
async function saveDebug(page, noteId, failType, message, html) {
  ensureDir(DEBUG_DIR);
  const base = path.join(DEBUG_DIR, `${noteId || 'unknown'}_error`);
  try {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: base + '.png', fullPage: false }).catch(() => {});
    }
  } catch (_) { /* ignore */ }
  if (html) {
    try { fs.writeFileSync(base + '.html', html, 'utf8'); } catch (_) { /* ignore */ }
  }
  try {
    fs.writeFileSync(base + '.json', JSON.stringify({
      note_id: noteId, fail_type: failType, message, time: nowStr(),
    }, null, 2), 'utf8');
  } catch (_) { /* ignore */ }
  return base;
}

/** 封面下载（尽力而为，失败不报错） */
async function saveCover(url, noteId) {
  if (!url) return null;
  ensureDir(COVER_DIR);
  const ext = url.match(/\.(jpe?g|png|webp)/i) ? url.match(/\.(jpe?g|png|webp)/i)[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  const file = path.join(COVER_DIR, `${noteId}.${ext}`);
  if (fs.existsSync(file)) return file;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Referer': 'https://www.xiaohongshu.com/' } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(file, buf);
    return file;
  } catch (e) {
    log('WARN', `封面下载失败: ${e.message.split('\n')[0]}`);
    return null;
  }
}

module.exports = {
  saveJson, appendCsv, writeCache, readCache, listCache, saveDebug, saveCover,
  JSON_DIR, COVER_DIR, CSV_FILE, CACHE_DIR, CSV_HEADERS,
};

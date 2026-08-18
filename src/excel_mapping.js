'use strict';
/**
 * excel_mapping.js — Excel 字段映射层
 * 将来把数据合并进已有 Excel 时，按 EXCEL_COLUMNS 的顺序取值即可。
 * 原则：页面无法确定的字段保持空字符串（''），绝不写 0。
 */
const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir, nowStr } = require('./utils');

/** Excel 目标列（与用户既有分析表对应） */
const EXCEL_COLUMNS = [
  '账号名称',   // account_name
  '链接',       // url
  '发布日期+时间', // published_at
  '观看数',     // view_count（页面不可得则留空）
  '点赞数',     // like_count
  '收藏数',     // favorite_count
  '评论数',     // comment_count
  '分享数',     // share_count
  '标题',       // title
  '文案',       // body
  '素材来源',   // 外部字段：调用方传入（如账号编号/视频文件），默认为空
];

/**
 * 将一条笔记结果映射为 Excel 行（保持字段顺序与 EXCEL_COLUMNS 一致）。
 * @param {object} note 解析结果
 * @param {object} extra { 素材来源 }
 */
function toExcelRow(note, extra) {
  const v = (x) => (x === null || x === undefined ? '' : String(x));
  return {
    账号名称: v(note.account_name),
    链接: v(note.url),
    '发布日期+时间': v(note.published_at || note.published_display),
    观看数: v(note.view_count),
    点赞数: v(note.like_count),
    收藏数: v(note.favorite_count),
    评论数: v(note.comment_count),
    分享数: v(note.share_count),
    标题: v(note.title),
    文案: v(note.body),
    素材来源: v((extra && extra.素材来源) || ''),
  };
}

/**
 * 追加到 Excel 直用 CSV（exports/excel_ready.csv，UTF-8 BOM）。
 */
function appendExcelCsv(note, extra) {
  const file = path.join(ROOT, 'exports', 'excel_ready.csv');
  ensureDir(path.dirname(file));
  const row = toExcelRow(note, extra);
  const isNew = !fs.existsSync(file);
  const cell = (s) => {
    const t = String(s);
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const line = EXCEL_COLUMNS.map(c => cell(row[c])).join(',') + '\n';
  fs.appendFileSync(file, isNew ? '\uFEFF' + EXCEL_COLUMNS.join(',') + '\n' + line : line, 'utf8');
  return file;
}

/** 生成/更新一份汇总 CSV（含本次全部字段的扁平视图），供核对 */
function writeSummary(notes) {
  if (!notes.length) return null;
  const file = path.join(ROOT, 'exports', 'summary.json');
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({
    generated_at: nowStr(),
    count: notes.length,
    notes,
  }, null, 2), 'utf8');
  return file;
}

module.exports = { EXCEL_COLUMNS, toExcelRow, appendExcelCsv, writeSummary };

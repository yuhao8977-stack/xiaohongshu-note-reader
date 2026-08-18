'use strict';
/**
 * parser.js — 页面数据解析
 * 优先级（按需求十五）：
 *   1) 浏览器实际加载完成后的 DOM（多 Selector 回退）
 *   2) 页面中浏览器正常收到的结构化状态数据 window.__INITIAL_STATE__
 *   3) 正常网页脚本可访问的公开数据（meta 等）
 * 绝不破解私有 API / 伪造签名。
 */
const { parseDisplayCount, extractHashtags, extractMentions, formatTime, log } = require('./utils');

/**
 * 在页面内一次性提取原始数据：DOM 候选 + 状态 JSON 关键字段。
 * @param {import('playwright').Page} page
 * @param {string|null} targetNoteId
 * @returns {Promise<object>}
 */
async function extractRaw(page, targetNoteId) {
  const json = await page.evaluate((targetId) => {
    /* Vue ref 解包：小红书把 __INITIAL_STATE__ 变为响应式对象 */
    const unwrap = (v) => {
      if (v && typeof v === 'object' && (v.__v_isRef === true || v._value !== undefined)) {
        return (v._value !== undefined ? v._value : v.value);
      }
      return v;
    };

    /* ---------- DOM 提取（多候选回退） ---------- */
    const pickText = (selectors, clean) => {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            let t = (el.innerText || el.textContent || '').trim();
            if (clean) t = t.replace(clean, '');
            if (t) return t;
          }
        } catch (_) { /* 个别选择器非法则跳过 */ }
      }
      return '';
    };

    const dom = {
      title: pickText([
        'h1#detail-title',
        '.note-content .title',
        'span[class*="title"]',
        '[class*="detail-title"]',
        'h1',
      ]) || pickText(['title'], /\s*-\s*小红书.*$/),
      desc: pickText([
        '.note-text',
        '.desc',
        '#detail-desc',
        '[class*="note-content"] [class*="desc"]',
        '[class*="desc"]',
        'article',
        '[class*="content"]',
      ]),
      author: pickText([
        '.author-wrapper .name',
        '.author .name',
        '.user-name',
        '.user .name',
        '[class*="user-name"]',
        '[class*="author"] [class*="name"]',
        '[class*="nickname"]',
        '.author-info .name',
      ]),
      time: pickText([
        '.date',
        '.time',
        '[class*="date"]',
        '[class*="time"]',
        '[class*="publish-time"]',
        '[class*="publish"]',
      ]),
      counts: {
        like: pickText([
          'button[aria-label*="点赞"] span, span[aria-label*="点赞"]',
          '[class*="like"] [class*="count"]',
          '.like-wrapper .count',
          'section .count',
        ]),
        favorite: pickText([
          'button[aria-label*="收藏"] span, span[aria-label*="收藏"]',
          '[class*="favorite"] [class*="count"], [class*="collect"] [class*="count"]',
          '.collect-wrapper .count',
        ]),
        comment: pickText([
          'button[aria-label*="评论"] span, span[aria-label*="评论"]',
          '[class*="comment"] [class*="count"]',
          '.comment-wrapper .count',
        ]),
        share: pickText([
          'button[aria-label*="分享"] span, span[aria-label*="分享"]',
          '[class*="share"] [class*="count"]',
        ]),
      },
      hasVideo: !!document.querySelector('video'),
      videoDurationText: (() => {
        const v = document.querySelector('video');
        return v && v.duration && !Number.isNaN(v.duration) ? String(Math.round(v.duration)) : '';
      })(),
      comments: (() => {
        const out = [];
        const items = document.querySelectorAll('.comment-item, .comment, [class*="comment-item"], [class*="commentList"] [class*="item"], .comments-el [class*="item"]');
        for (const it of items) {
          if (out.length >= 30) break;
          const text = (it.querySelector('[class*="content"], [class*="text"], .content')?.innerText || '').trim();
          if (!text) continue;
          const like = (it.querySelector('[class*="like"] [class*="count"], [class*="interaction"] [class*="count"], [class*="like"]')?.innerText || '').trim();
          const reply = (it.querySelector('[class*="reply"] [class*="count"], [class*="commentCount"]')?.innerText || '').trim();
          out.push({ comment_text: text, comment_like_count: like, reply_count: reply });
        }
        return out;
      })(),
      noComments: !!document.querySelector('.no-comments, [class*="no-comments"]'),
      pageText: document.body ? document.body.innerText.slice(0, 8000) : '',
      htmlSnippet: document.documentElement ? document.documentElement.outerHTML.slice(0, 4000) : '',
      url: location.href,
    };

    /* ---------- 状态 JSON 提取（页面正常收到的结构化数据） ---------- */
    const state = {};
    try {
      const s = window.__INITIAL_STATE__;
      if (s && s.note) {
        const map = unwrap(s.note.noteDetailMap) || {};
        let key = null;
        let matched = false;
        if (targetId) {
          key = Object.keys(map).find(k => k.toLowerCase().includes(String(targetId).toLowerCase())) || null;
          matched = !!key;
        } else if (Object.keys(map).length > 0) {
          key = Object.keys(map)[0];
          matched = true;
        }
        // 目标笔记未在状态中找到（可能已删除/无权/被跳到推荐流）→ 标记不匹配，拒绝写入
        state.mismatch = !matched;
        const entry = key ? map[key] : null;
        const n = entry ? unwrap(entry.note || entry) : null;
        if (n) {
          const pick = (o, ...names) => {
            if (!o) return null;
            for (const name of names) {
              const v = unwrap(o[name]);
              if (v !== null && v !== undefined) return v;
            }
            return null;
          };
          const user = unwrap(n.user);
          const ii = unwrap(n.interactInfo) || {};
          const v = unwrap(n.video) || {};
          state.noteId = String(pick(n, 'noteId', 'note_id') || '');
          state.type = pick(n, 'type') || null;                 // 'video' | 'normal'
          state.title = pick(n, 'title') || null;
          state.desc = pick(n, 'desc', 'description') || null;
          state.time = pick(n, 'time', 'createTime', 'lastUpdateTime') || null;  // 毫秒时间戳
          state.userId = user ? String(pick(user, 'userId', 'user_id') || '') : null;
          state.nickname = user ? String(pick(user, 'nickname', 'nickName', 'nick_name') || '') : null;
          state.likedCount = pick(ii, 'likedCount', 'liked_count');
          state.collectedCount = pick(ii, 'collectedCount', 'collected_count');
          state.commentCount = pick(ii, 'commentCount', 'comment_count');
          state.shareCount = pick(ii, 'shareCount', 'share_count');
          const tags = unwrap(pick(n, 'tagList', 'tags')) || [];
          state.tags = (Array.isArray(tags) ? tags : []).map(t => (typeof t === 'string' ? t : (pick(t, 'name', 'tagName') || ''))).filter(Boolean);
          const imgs = unwrap(pick(n, 'imageList', 'imagesList', 'images')) || [];
          const img0 = Array.isArray(imgs) && imgs[0] ? imgs[0] : null;
          state.coverUrl = img0 ? String(pick(img0, 'urlDefault', 'url', 'urlPre') || '') : '';
          state.videoDuration = pick(v, 'duration') || pick(unwrap(v.media), 'duration') || null;
          const stream = unwrap(unwrap(v.media) && unwrap(v.media).stream) || {};
          // 流格式键不固定（EF4/EF5/h264 等），遍历找 masterUrl
          let masterUrl = '';
          for (const k of Object.keys(stream)) {
            const arr = unwrap(stream[k]);
            if (Array.isArray(arr) && arr[0] && arr[0].masterUrl) { masterUrl = String(arr[0].masterUrl); break; }
          }
          state.videoUrl = masterUrl;
          const vc = unwrap(v.cover);
          if (!state.coverUrl && vc) state.coverUrl = String(pick(vc, 'urlDefault', 'urlPre', 'url') || '');
          state.videoDuration = state.videoDuration !== null ? Number(state.videoDuration) : null;
        }
        // 登录状态线索（不包含任何凭据）
        const u = unwrap(s.user);
        const li = u ? unwrap(u.loggedIn) : null;
        state.userLoggedIn = (li === true);
        state.hasLoginOverlay = !!document.querySelector('[class*="login"] [class*="modal"], [class*="login-container"], [class*="login-modal"]');
      }
    } catch (e) {
      state.error = String(e && e.message || e);
    }

    return JSON.stringify({ dom, state });
  }, targetNoteId || null);
  return JSON.parse(json);
}

/**
 * 合并 DOM 与状态数据为最终结构化结果。
 * @param {object} raw extractRaw 的返回值
 * @param {object} opts { url, noteId, collectedAt }
 */
function buildNote(raw, opts) {
  const { dom, state } = raw;
  const d = dom || {};
  const s = state || {};

  const title = (d.title || s.title || '').trim();
  let body = (d.desc || s.desc || '').trim();
  // 若 DOM 正文与状态正文都为空，尝试从页面文本截取合理段落（仅作为最后手段，不带推荐内容）
  if (!body && d.pageText) {
    const m = d.pageText.match(/([\s\S]{1,2000}?)(?=\n*#{0,1}话题|$)/);
    body = m ? m[1].trim() : '';
  }
  const hashtags = extractHashtags(s.desc || d.desc || title) || (s.tags || []);
  const mentions = extractMentions(s.desc || d.desc || '');

  const numOrEmpty = v => (v !== null && v !== undefined ? String(v) : '');
  const like = parseDisplayCount((d.counts && d.counts.like) || numOrEmpty(s.likedCount));
  const favorite = parseDisplayCount((d.counts && d.counts.favorite) || numOrEmpty(s.collectedCount));
  let commentRaw = (d.counts && d.counts.comment) || numOrEmpty(s.commentCount);
  // 状态给空字符串且页面明确显示"暂无评论" → 确定为 0
  if ((!commentRaw || commentRaw === '') && d.noComments) commentRaw = '0';
  const comment = parseDisplayCount(commentRaw);
  const share = parseDisplayCount((d.counts && d.counts.share) || numOrEmpty(s.shareCount));

  // 笔记类型：状态优先（video/normal），DOM 视频元素辅助
  let noteType = 'other';
  if (s.type === 'video' || d.hasVideo) noteType = 'video';
  else if (s.type === 'normal') noteType = 'image';

  // 发布时间：状态毫秒时间戳 -> 本地时间；否则保留页面显示文本
  let publishedAt = '';
  let publishedDisplay = '';
  if (s.time) {
    const t = formatTime(Number(s.time));
    if (t) publishedAt = t;
  }
  if (d.time && !/^\d{4}-\d{2}-\d{2}/.test(publishedAt)) publishedDisplay = d.time;

  return {
    account_name: (d.author || s.nickname || '').trim(),
    account_id: (s.userId || '').toString(),
    note_id: (s.noteId || opts.noteId || '').toString(),
    url: opts.url || '',
    normalized_url: opts.normalizedUrl || '',
    published_at: publishedAt,
    published_display: publishedDisplay,
    note_type: noteType,
    title,
    body,
    hashtags,
    mentions,
    like_display: like.display,
    like_count: like.normalized,
    favorite_display: favorite.display,
    favorite_count: favorite.normalized,
    comment_display: comment.display,
    comment_count: comment.normalized,
    share_display: share.display,
    share_count: share.normalized,
    view_count: null,        // 页面无法可靠获得观看/曝光，不猜
    exposure_count: null,
    video_duration: (s.videoDuration !== null && s.videoDuration !== undefined) ? Number(s.videoDuration) : (d.videoDurationText ? Number(d.videoDurationText) : null),
    video_url: (s.videoUrl || '').trim(),
    cover_url: (s.coverUrl || '').trim(),
    comments: (d.comments || []).map(c => ({
      comment_text: c.comment_text,
      comment_like_display: c.comment_like_count,
      comment_like_count: parseDisplayCount(c.comment_like_count).normalized,
      reply_display: c.reply_count,
      reply_count: parseDisplayCount(c.reply_count).normalized,
    })),
    collected_at: opts.collectedAt || '',
    status: 'success',
    error: null,
  };
}

/**
 * 页面加载后调用：等待目标笔记内容出现（防止把推荐内容当数据）。
 */
async function waitForNoteContent(page, noteId) {
  try {
    await page.waitForFunction((id) => {
      const s = window.__INITIAL_STATE__;
      if (s && s.note && s.note.noteDetailMap) {
        const keys = Object.keys(s.note.noteDetailMap);
        if (id) return keys.some(k => k.toLowerCase().includes(id.toLowerCase()));
        return keys.length > 0;
      }
      // 状态不可用时退而求其次：页面出现笔记标题区域或正文区域
      return !!document.querySelector('h1, .note-text, .desc, [class*="note-content"]');
    }, noteId || null, { timeout: 25000 });
  } catch (e) {
    log('WARN', `waitForNoteContent 超时: ${e.message.split('\n')[0]}`);
  }
}

module.exports = { extractRaw, buildNote, waitForNoteContent };

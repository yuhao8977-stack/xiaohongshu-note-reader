'use strict';
/**
 * browser.js — 浏览器生命周期管理
 * 设计要点：
 *  - 使用独立用户目录 browser_profile/xhs_profile，绝不触碰日常 Chrome/Edge 配置。
 *  - 优先使用本机 Edge 内核（channel: msedge）；不可用时回退 Playwright Chromium。
 *  - 登录状态复用：首次人工登录后保存在 profile 里，后续直接复用。
 */
const path = require('path');
const { chromium } = require('playwright');
const { ROOT, ensureDir, log, sleep } = require('./utils');

const PROFILE_DIR = path.join(ROOT, 'browser_profile', 'xhs_profile');

/** 登录 cookie 名（小红书网页登录后设置） */
const LOGIN_COOKIE = 'web_session';

let cachedContext = null;

/**
 * 启动持久化浏览器上下文（有头模式，独立 profile）。
 * 返回 { context, page }。
 */
async function launchBrowser() {
  ensureDir(PROFILE_DIR);
  const options = {
    headless: false,
    locale: 'zh-CN',
    viewport: { width: 1360, height: 900 },
    args: [
      '--start-maximized',
      '--disable-popup-blocking',
    ],
  };

  let context = null;
  let lastErr = null;
  // 1) 优先本机 Edge
  try {
    log('INFO', '尝试使用本机 Edge 内核启动浏览器…');
    context = await chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel: 'msedge' });
  } catch (e) {
    lastErr = e;
    log('WARN', `Edge 启动失败（${e.message.split('\n')[0]}），回退 Playwright Chromium…`);
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, options);
    } catch (e2) {
      lastErr = e2;
    }
  }

  if (!context) {
    throw new Error(`浏览器启动失败: ${lastErr ? lastErr.message : '未知原因'}\n提示：请先运行 npx playwright install chromium 安装内置浏览器，或确认本机已安装 Edge。`);
  }

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30000);
  cachedContext = context;
  return { context, page };
}

/** 关闭浏览器 */
async function closeBrowser() {
  if (cachedContext) {
    try { await cachedContext.close(); } catch (_) { /* ignore */ }
    cachedContext = null;
  }
}

/**
 * 检测当前是否已登录。
 * 小红书页面把 __INITIAL_STATE__ 注入 Vue 响应式对象，loggedIn 可能是 Vue ref（{_value: true}）。
 * 优先读取页面状态；拿不到页面时回退 web_session cookie（弱指标，仅作兜底）。
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} [page]
 */
async function isLoggedIn(context, page) {
  if (page && !page.isClosed()) {
    try {
      const r = await page.evaluate(() => {
        const s = window.__INITIAL_STATE__;
        if (s && s.user) {
          const l = s.user.loggedIn;
          const v = l && typeof l === 'object' ? (l._value !== undefined ? l._value : l.value) : l;
          if (v === true) return 'yes';
          if (v === false) return 'no';
          // 结构不明确时看登录弹窗
          const modal = document.querySelector('[class*="login"] [class*="modal"], [class*="login-container"], [class*="login-modal"]');
          return modal ? 'no' : 'maybe';
        }
        return 'unknown';
      });
      if (r === 'yes') return true;
      if (r === 'no') return false;
      if (r === 'maybe') {
        // 弹窗消失 + 头像存在 → 视为已登录
        const hasAvatar = await page.evaluate(() => !!document.querySelector('[class*="avatar"] img[src], [class*="avatar"] img')).catch(() => false);
        if (hasAvatar) return true;
      }
    } catch (_) { /* 页面不可用则走 cookie 兜底 */ }
  }
  try {
    const cookies = await context.cookies('https://www.xiaohongshu.com');
    return cookies.some(c => c.name === LOGIN_COOKIE && c.value);
  } catch (_) { /* ignore */ }
  return false;
}

/**
 * 等待用户人工登录。
 * @param {import('playwright').Page} page 已经打开小红书首页的页面
 * @param {number} timeoutMs 最长等待毫秒（默认 10 分钟）
 * @returns {Promise<boolean>} 是否检测到登录成功
 */
async function waitForLogin(page, timeoutMs = 10 * 60 * 1000) {
  const start = Date.now();
  let printed = false;
  while (Date.now() - start < timeoutMs) {
    const ok = await isLoggedIn(page.context(), page);
    if (ok) {
      log('INFO', '检测到登录状态（页面 user.loggedIn=true），继续…');
      return true;
    }
    if (!printed) {
      console.log('');
      console.log('============================================');
      console.log('请在打开的浏览器窗口中人工登录小红书。');
      console.log('支持：手机号+验证码 / 扫码 等正常登录方式。');
      console.log('程序不会读取、保存您的账号密码。');
      console.log('登录完成后程序会自动检测并继续（最多等待 10 分钟）。');
      console.log('============================================');
      console.log('');
      printed = true;
    }
    await sleep(3000);
  }
  return false;
}

/** 打开小红书首页（用于登录） */
async function openHome(page) {
  await page.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等首页框架稳定
  await page.waitForTimeout(2000);
}

module.exports = {
  PROFILE_DIR, launchBrowser, closeBrowser, isLoggedIn, waitForLogin, openHome,
};

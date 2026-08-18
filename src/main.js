'use strict';
/**
 * main.js — 小红书笔记读取器 主程序（CLI）
 *
 * 用法：
 *   node src/main.js                交互菜单
 *   node src/main.js --login        打开浏览器人工登录（首次使用）
 *   node src/main.js --url <链接> [--refresh]   直接读取单条
 *   node src/main.js --file <txt>   [--refresh]   读取文件内多行链接
 *   node src/main.js --batch <链接1> <链接2> ...   直接读取多条
 *
 * 原则：
 *  - 只读取本账号正常登录后可见的数据；出现验证码 → 停止自动操作，等人工处理。
 *  - 不记录任何 Cookie/Token/密码。
 *  - 数字无法确定则为 null/空，绝不猜。
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { launchBrowser, closeBrowser, isLoggedIn, waitForLogin, openHome } = require('./browser');
const { extractRaw, buildNote, waitForNoteContent } = require('./parser');
const exporter = require('./exporter');
const excel = require('./excel_mapping');
const {
  ROOT, log, sleep, parseNoteId, normalizeUrl, isShortLink, nowStr,
} = require('./utils');

const BANNER = `
============================
  小红书笔记读取器 v1.0
============================
1 单条读取
2 批量读取
3 打开登录浏览器（人工登录）
4 查看历史结果
5 退出
============================`;

/* ---------------- 错误分类 ---------------- */

/** 检测验证码/登录墙/不存在/无权访问等页面状态 */
function detectPageState(pageText, url) {
  const t = pageText || '';
  const u = url || '';
  if (/验证码|安全验证|拖动滑块|人机验证|请完成验证|verify|滑块验证/i.test(t + ' ' + u)) return 'CAPTCHA_REQUIRED';
  if (/\/(login|login-portal)\b/i.test(u) || /登录后可查看|登录后查看|请先登录|扫码登录|手机号登录|尚未登录/i.test(t)) return 'NOT_LOGGED_IN';
  if (/笔记不存在|该内容已删除|内容已删除|页面不存在|未找到相关内容|该笔记已删除|内容已被删除/i.test(t)) return 'NOTE_NOT_FOUND';
  if (/作者已设置|暂时不可见|仅粉丝可见|无法查看|该内容暂不可见|不可见|仅自己可见|未公开/i.test(t)) return 'ACCESS_DENIED';
  return null;
}

/** 等待验证码被人工处理（最多 waitMs） */
async function waitCaptchaSolved(page, waitMs = 8 * 60 * 1000) {
  const start = Date.now();
  let printed = false;
  while (Date.now() - start < waitMs) {
    const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '').catch(() => '');
    const state = detectPageState(text, page.url());
    if (state !== 'CAPTCHA_REQUIRED') {
      if (printed) log('INFO', '验证码已处理，继续…');
      return true;
    }
    if (!printed) {
      console.log('');
      console.log('============================================');
      console.log('检测到验证码/安全验证。');
      console.log('请在浏览器窗口中人工完成验证（不需要任何自动化）。');
      console.log('完成后程序会自动继续（最多等待 8 分钟）。');
      console.log('============================================');
      console.log('');
      printed = true;
    }
    await sleep(4000);
  }
  return false;
}

/* ---------------- 读取单条 ---------------- */

/**
 * 读取一条笔记。
 * @returns {Promise<{status:string, note?:object, error?:string, failType?:string}>}
 */
async function readNote(url, opts) {
  const { refresh = false, context, pageFactory } = opts;
  const noteId = parseNoteId(url);
  if (!noteId) {
    return { status: 'failed', failType: 'PARSE_FAILED', error: `无法从链接解析 note_id: ${url}` };
  }
  log('INFO', `开始读取 note_id=${noteId}`);

  // 缓存复用
  if (!refresh) {
    const cached = exporter.readCache(noteId);
    if (cached) {
      log('INFO', `命中缓存（collected_at=${cached.collected_at}），跳过重新抓取。如需刷新请用 --refresh`);
      return { status: 'success', note: cached, fromCache: true };
    }
  }

  let page = null;
  let ownedPage = false;
  try {
    if (!context) {
      const b = await launchBrowser();
      page = b.page;
    } else {
      page = context.pages()[0] || await context.newPage();
      ownedPage = page.isClosed && page.isClosed();
      if (page.isClosed()) { page = await context.newPage(); }
    }
    page.setDefaultTimeout(30000);

    // 若未登录：先走登录流程（人工）
    if (!(await isLoggedIn(page.context(), page))) {
      log('WARN', '当前未登录，进入登录流程…');
      await openHome(page);
      const ok = await waitForLogin(page);
      if (!ok) {
        return { status: 'failed', failType: 'NOT_LOGGED_IN', error: '等待人工登录超时' };
      }
    }

    // 访问策略：带 xsec_token 的分享链接直接访问（参数是访问所需）；否则先标准化 URL，失败再回退原 URL
    const hasToken = /xsec_token=/.test(url);
    const accessUrls = hasToken
      ? [url, normalizeUrl(url)]
      : [normalizeUrl(url), url];

    let note = null;
    let lastState = null;
    for (const tryUrl of accessUrls) {
      try {
        await page.goto(tryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1500);
        // 快速失败：跳转完成后 URL 已不含目标 id（短链跳转多给一点时间）
        if (!page.url().includes(String(noteId))) {
          await page.waitForTimeout(2500);
          if (!page.url().includes(String(noteId))) {
            const pt = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '').catch(() => '');
            const st = detectPageState(pt, page.url());
            lastState = st
              ? { failType: st, error: `页面跳转到：${page.url()}` }
              : { failType: 'NOTE_NOT_FOUND', error: `页面跳转到 ${page.url()}，已不包含目标笔记 id，拒绝写入` };
            continue;
          }
        }
        await waitForNoteContent(page, noteId);
        // 等待视频元数据（时长需要）
        await page.waitForFunction(() => { const v = document.querySelector('video'); return !v || v.readyState >= 1; }, { timeout: 7000 }).catch(() => {});
        // 滚动到底部，触发评论区懒加载
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        await page.waitForTimeout(1200);
      } catch (e) {
        const msg = String(e && e.message || e);
        if (/timeout|Timeout/i.test(msg)) {
          lastState = { failType: 'TIMEOUT', error: `页面加载超时: ${msg.split('\n')[0]}` };
        } else if (/net::|ERR_|ECONN|socket/i.test(msg)) {
          lastState = { failType: 'NETWORK_ERROR', error: `网络错误: ${msg.split('\n')[0]}` };
        } else {
          lastState = { failType: 'UNKNOWN_ERROR', error: msg.split('\n')[0] };
        }
        continue;
      }

      // 分类页面状态（验证码/登录墙/不存在/无权）
      const pageText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '').catch(() => '');
      const state = detectPageState(pageText, page.url());
      if (state === 'CAPTCHA_REQUIRED') {
        const solved = await waitCaptchaSolved(page);
        if (!solved) return { status: 'failed', failType: 'CAPTCHA_REQUIRED', error: '等待人工处理验证码超时' };
        continue; // 重新走一次访问
      }
      if (state === 'NOT_LOGGED_IN') {
        await openHome(page);
        const ok = await waitForLogin(page);
        if (!ok) return { status: 'failed', failType: 'NOT_LOGGED_IN', error: '等待人工登录超时' };
        continue;
      }
      if (state === 'NOTE_NOT_FOUND' || state === 'ACCESS_DENIED') {
        lastState = { failType: state, error: `页面提示：${state === 'NOTE_NOT_FOUND' ? '笔记不存在或已删除' : '无权访问'}` };
        continue;
      }

      // 防误读：加载完成后 URL 必须仍包含目标笔记 id（防止跳转到首页/推荐流）
      const finalUrl = page.url();
      if (!finalUrl.includes(String(noteId))) {
        const st2 = detectPageState(pageText, finalUrl);
        lastState = st2
          ? { failType: st2, error: `页面跳转到：${finalUrl}` }
          : { failType: 'NOTE_NOT_FOUND', error: `页面跳转到 ${finalUrl}，已不包含目标笔记 id，拒绝写入` };
        continue;
      }

      // 解析
      const raw = await extractRaw(page, noteId);
      const noteIdFromPage = (raw.state && raw.state.noteId) || noteId;
      const note = buildNote(raw, {
        url,
        noteId,
        normalizedUrl: normalizeUrl(url),
        collectedAt: nowStr(),
      });

      // 防误读：页面状态中没有目标笔记（已删除/无权/跳到推荐流）→ 拒绝写入
      if (raw.state && raw.state.mismatch === true) {
        lastState = { failType: 'NOTE_NOT_FOUND', error: '页面状态中未找到目标笔记（可能已删除、未公开或无权访问）' };
        continue;
      }

      // 防误读：页面 note_id 与目标不一致 → 解析失败
      if (raw.state && raw.state.noteId && noteIdFromPage.toLowerCase() !== String(noteId).toLowerCase()) {
        lastState = { failType: 'PARSE_FAILED', error: `页面返回了其他笔记（${noteIdFromPage}），疑似被跳转，已拒绝写入` };
        continue;
      }

      // 校验：页面有明显内容但关键字段为空 → 解析失败
      const emptyTitle = !note.title;
      const emptyBody = !note.body && !note.cover_url;
      const emptyAccount = !note.account_name;
      if (emptyTitle || (emptyBody && !raw.dom.hasVideo) || emptyAccount) {
        lastState = {
          failType: 'PARSE_FAILED',
          error: `关键字段缺失: title=${JSON.stringify(note.title)} body_len=${note.body.length} account=${JSON.stringify(note.account_name)}`,
        };
        continue;
      }

      note.note_id = noteId; // 以目标为准
      note.url = url;
      note.normalized_url = normalizeUrl(url);
      return { status: 'success', note, usedUrl: tryUrl };
    }

    // 全部尝试失败
    if (lastState) {
      const html = await page.evaluate(() => document.documentElement ? document.documentElement.outerHTML.slice(0, 200000) : '').catch(() => null);
      await exporter.saveDebug(page, noteId, lastState.failType, lastState.error, html);
      return { status: 'failed', ...lastState };
    }
    return { status: 'failed', failType: 'UNKNOWN_ERROR', error: '未知读取失败' };
  } catch (e) {
    const msg = String(e && e.message || e);
    log('ERROR', `读取异常: ${msg.split('\n')[0]}`);
    const failType = /timeout|Timeout/i.test(msg) ? 'TIMEOUT' : 'UNKNOWN_ERROR';
    if (page && !page.isClosed()) {
      const html = await page.evaluate(() => document.documentElement ? document.documentElement.outerHTML.slice(0, 200000) : '').catch(() => null);
      await exporter.saveDebug(page, noteId, failType, msg, html);
    }
    return { status: 'failed', failType, error: msg.split('\n')[0] };
  } finally {
    if (ownedPage && page && !page.isClosed()) await page.close().catch(() => {});
  }
}

/** 打印简短结果 */
function printSummary(note) {
  console.log('');
  console.log('-------- 读取成功 --------');
  console.log(`账号：${note.account_name}`);
  console.log(`标题：${note.title}`);
  console.log(`类型：${note.note_type === 'video' ? '视频笔记' : note.note_type === 'image' ? '图片笔记' : note.note_type}`);
  console.log(`发布时间：${note.published_at || note.published_display || '(未获取)'}`);
  console.log(`点赞：${note.like_display || (note.like_count ?? '(无)')}   收藏：${note.favorite_display || (note.favorite_count ?? '(无)')}`);
  console.log(`评论：${note.comment_display || (note.comment_count ?? '(无)')}   分享：${note.share_display || (note.share_count ?? '(无)')}`);
  console.log(`话题：${note.hashtags.length ? note.hashtags.join('、') : '(无)'}`);
  console.log(`正文：${(note.body || '').slice(0, 120)}${(note.body || '').length > 120 ? '…' : ''}`);
  console.log(`评论数(已读)：${note.comments.length}`);
  console.log('---------------------------');
  console.log('');
}

/** 成功后的输出流程 */
async function handleSuccess(note, extra) {
  const jsonFile = exporter.saveJson(note);
  exporter.writeCache(note);
  const csvFile = exporter.appendCsv(note);
  excel.appendExcelCsv(note, extra);
  let coverFile = null;
  if (note.cover_url) coverFile = await exporter.saveCover(note.cover_url, note.note_id);
  log('INFO', `JSON → ${jsonFile}`);
  log('INFO', `CSV → ${csvFile}`);
  if (coverFile) log('INFO', `封面 → ${coverFile}`);
  return { jsonFile, csvFile };
}

/** 处理一条链接（统一入口，供菜单与命令行复用） */
async function processUrl(url, opts = {}) {
  console.log('');
  console.log(`>>> 链接：${url}`);
  const result = await readNote(url, opts);
  if (result.status === 'success') {
    printSummary(result.note);
    if (!result.fromCache) await handleSuccess(result.note, opts.extra);
    else log('INFO', '（缓存结果，未重复写入 CSV）');
    return true;
  }
  console.log('');
  console.log(`[失败] ${result.failType || 'UNKNOWN_ERROR'}：${result.error}`);
  console.log(`       失败现场已保存到 debug/ 目录（截图/HTML）。`);
  console.log('');
  return false;
}

/* ---------------- 菜单与批量 ---------------- */

// 单一常驻 readline 接口（不要对每个问题新建/关闭，否则管道输入会失效）
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())));
}

async function menu() {
  console.log(BANNER);
  const choice = await ask('请选择（1-5）：');
  switch (choice) {
    case '1': {
      const url = await ask('请输入小红书笔记链接：');
      if (!url) return;
      await processUrl(url, { refresh: process.argv.includes('--refresh') });
      break;
    }
    case '2': {
      console.log('请输入链接（每行一个，输入完成请单独输入一行 end，或直接粘贴多行后回车）：');
      const lines = [];
      await new Promise(resolve => {
        rl.on('line', line => {
          const l = line.trim();
          if (l === 'end') return resolve();
          if (l) lines.push(l);
        });
      });
      await runBatch(lines);
      break;
    }
    case '3': {
      await doLogin();
      break;
    }
    case '4': {
      const caches = exporter.listCache();
      console.log(`\n已缓存 ${caches.length} 条笔记：`);
      caches.forEach(f => {
        try {
          const n = JSON.parse(fs.readFileSync(path.join(exporter.CACHE_DIR, f), 'utf8'));
          console.log(`  ${n.note_id}  [${n.collected_at}]  ${n.title.slice(0, 40)}`);
        } catch (_) { /* ignore */ }
      });
      console.log('');
      break;
    }
    case '5':
      console.log('再见。');
      process.exit(0);
      break;
    default:
      console.log('无效选择。');
  }
}

async function doLogin() {
  const b = await launchBrowser();
  await openHome(b.page);
  if (await isLoggedIn(b.context, b.page)) {
    console.log('已经处于登录状态。');
  } else {
    const ok = await waitForLogin(b.page);
    console.log(ok ? '登录状态已保存，下次直接复用。' : '等待登录超时。');
  }
  await sleep(2000);
}

/** 批量读取（顺序执行，低并发，稳定优先） */
async function runBatch(urls) {
  const list = [...new Set(urls.map(u => u.trim()).filter(Boolean))];
  if (!list.length) { console.log('没有有效链接。'); return; }
  console.log(`\n共 ${list.length} 条，开始顺序读取…\n`);
  const b = await launchBrowser();
  let okCount = 0;
  for (let i = 0; i < list.length; i++) {
    console.log(`\n[${i + 1}/${list.length}]`);
    const ok = await processUrl(list[i], { refresh: process.argv.includes('--refresh'), context: b.context });
    if (ok) okCount++;
    if (i < list.length - 1) {
      console.log('等待 3 秒再处理下一条…');
      await sleep(3000);
    }
  }
  await closeBrowser();
  console.log(`\n批量完成：成功 ${okCount}/${list.length}`);
}

/* ---------------- 命令行入口 ---------------- */

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--login')) {
    await doLogin();
    return;
  }

  const urlArg = argv.indexOf('--url');
  if (urlArg !== -1 && argv[urlArg + 1]) {
    const ok = await processUrl(argv[urlArg + 1], { refresh: argv.includes('--refresh') });
    process.exit(ok ? 0 : 1);
    return;
  }

  const fileArg = argv.indexOf('--file');
  if (fileArg !== -1 && argv[fileArg + 1]) {
    const file = argv[fileArg + 1];
    if (!fs.existsSync(file)) { console.log(`文件不存在：${file}`); process.exit(1); }
    const urls = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    await runBatch(urls);
    return;
  }

  const batchArg = argv.indexOf('--batch');
  if (batchArg !== -1) {
    const urls = argv.slice(batchArg + 1);
    await runBatch(urls);
    return;
  }

  // 交互菜单
  await menu();
  const again = await ask('是否继续？（回车继续 / q 退出）：');
  if (again.toLowerCase() !== 'q') await main();
}

main().catch(e => {
  console.error('程序异常：', e);
  process.exit(1);
});

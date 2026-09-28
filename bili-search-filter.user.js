// ==UserScript==
// @name         B站 搜索页+投稿页 - 播放量/UP主 筛选 + 批量提取链接
// @namespace    https://local.dachuan/bili-view-filter
// @version      1.3.2
// @description  在B站搜索页 / UP主投稿页(video、upload/video)按「播放量 ≥ N」「UP主名字等于指定值（可多选）」筛选视频，自动隐藏不匹配项，并批量采集筛选结果的链接（自动翻页/滚动，跨页按BV去重，支持复制/导出TXT/CSV）
// @author       大川
// @match        *://search.bilibili.com/*
// @match        *://space.bilibili.com/*/video
// @match        *://space.bilibili.com/*/upload/video
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/* 更新记录
 * 1.3.2  作者署名改为「大川」；移除仓库中的页面截图（含他人信息）
 * 1.3.1  修复：投稿页"命中 0 / 整页全隐藏"
 *        根因：Tampermonkey 在 document-idle 执行时，投稿页卡片还是 SPA 异步渲染中，
 *        detectPage() 探测不到 .upload-video-card → 误用搜索页选择器 →
 *        播放量选择器 .bili-video-card__stats--item 在投稿页不存在 → play=NaN → 全部判为不匹配
 *        - detectPage() 改为**优先按域名**判断页面类型，不再依赖 DOM 渲染时机
 *        - applyFilter() 每次执行都重新确认页面类型，卡片渲染完成后自动纠正
 *        - 标题/播放量读取增加跨布局兜底选择器；缓存签名加入页面类型，纠正后自动失效重读
 *        - 新增保险：设置了播放量阈值但某卡片播放量读不到时，该卡片保留显示（绝不整页隐藏），
 *          并在面板提示"N 条播放量读取失败，已保留显示"
 *        - 播放量读不到时不再写入缓存，并每 0.5s 自动重试（上限 12 次 / 用户操作时重置），
 *          适配"B站先渲染卡片、后填播放量数字"，数字到位后自动纠正，无需手动重筛
 * 1.3.0  三个筛选条件（播放量 / UP主 / 标题含）全部可选，任意留空即不按该条件过滤
 *        - 播放量默认值从 1000 改为留空，避免只想按 UP主/标题筛选时被默认播放量误伤
 *        - 输入框占位符标注「留空=不限」
 * 1.2.0  兼容 UP主投稿页：space.bilibili.com/{mid}/video 和 /upload/video
 *        - 投稿页卡片是 .upload-video-card > .bili-video-card，播放量在 .bili-cover-card__stat，
 *          标题在 .bili-video-card__title，作者名取页面顶部 .nickname（投稿页所有视频同属该UP主）
 *        - 投稿页是无限滚动，无分页；一键采集会自动滚到底加载全部
 * 1.1.0  修复：开启「自动隐藏」时命中的卡片也被一起隐藏，导致整页空白（面板数字正常但列表全没了）
 *        - 隐藏条件补上 !ok；隐藏目标增加安全校验（祖先里多于 1 张卡片则退化为卡片本身）
 *        - 新增自愈回滚：命中项全被隐藏时自动撤销隐藏并告警
 *        - 新增本页 0 命中时的占位提示条
 *        - 新增「采集页数」：一键采集支持自动翻页（分页式搜索结果），跨页按 BV 去重，可再点一次停止
 * 1.0.0  首版
 */

(function () {
  'use strict';

  /* ==================== 1. 基础配置 ==================== */
  const STORE_KEY = 'xh_bili_search_filter_cfg_v2';
  const HOST_ID   = 'xh-bili-filter-host';
  const HIDE_CLS  = 'xh-bili-filter-hide';
  const BADGE_CLS = 'xh-bili-filter-badge';

  /* ---------- 两套页面结构（搜索页 / 投稿页） ---------- */
  const SEARCH_S = {
    card:     '.bili-video-card',                    // 视频卡片
    wrap:     '.video-list-item',                    // 卡片外层（老版布局）
    grid:     '[class*="col_"]',                     // 卡片外层（新版布局：col_3 col_md_2 …）
    root:     '.search-page',                        // 搜索结果容器
    title:    '.bili-video-card__info--tit',         // 标题
    author:   '.bili-video-card__info--author',      // UP主名字
    statItem: '.bili-video-card__stats--item',       // 播放/弹幕
    link:     'a[href*="/video/"]'                   // 视频链接
  };

  const SPACE_S = {
    card:     '.bili-video-card',
    wrap:     '.upload-video-card',                  // 投稿页卡片外层（grid-mode / list-mode 通用）
    grid:     '.upload-video-card',
    root:     '.video-list',                         // 投稿页列表容器
    title:    '.bili-video-card__title',             // 标题（title 属性）
    author:   null,                                  // 投稿页无逐卡作者，取页面顶部 .nickname
    statItem: '.bili-cover-card__stat',              // 播放/弹幕/时长
    link:     'a[href*="/video/"]'
  };

  let S = SEARCH_S;                                   // 当前生效的选择器集
  let PAGE = { kind: 'search' };                      // 当前页面类型
  let spaceOwner = '';                                // 投稿页 UP主名字

  // 页面类型判断：**优先看域名**。
  // 关键：Tampermonkey 在 document-idle 就执行，而投稿页的卡片是 SPA 异步渲染的，
  // 此时 DOM 里还没有 .upload-video-card；若只靠 DOM 探测会误判成搜索页，
  // 导致播放量选择器读不到 → 全部判为不匹配（整页 0 命中）。
  function detectPage() {
    const byUrl = /(^|\.)space\.bilibili\.com$/i.test(location.hostname);
    const byDom = !!document.querySelector('.upload-video-card');
    const isSpace = byDom || byUrl;

    if (isSpace) {
      S = SPACE_S;
      PAGE = { kind: 'space' };
      // 作者名在页面头部，可能晚于卡片渲染：读到才覆盖，读不到先保留，下次再试
      const n = document.querySelector('.upinfo-detail .nickname, .upinfo__main .nickname, .nickname');
      const name = n ? n.textContent.trim() : '';
      if (name) spaceOwner = name;
    } else {
      S = SEARCH_S;
      PAGE = { kind: 'search' };
      spaceOwner = '';
    }
  }

  const DEFAULTS = {
    minPlay: '',        // 留空 = 不限播放量
    author: '',
    keyword: '',
    fuzzyAuthor: false,
    autoHide: true,
    maxPages: 5,
    collapsed: false
  };

  const load = () => {
    try { return Object.assign({}, DEFAULTS, JSON.parse(GM_getValue(STORE_KEY, '{}') || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  };
  const save = () => { try { GM_setValue(STORE_KEY, JSON.stringify(cfg)); } catch (e) {} };

  let cfg = load();

  /* ==================== 2. 工具函数 ==================== */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // "1.2万" / "4376" / "10万+" / "1.1亿" -> 数字
  function parsePlay(txt) {
    if (txt == null) return NaN;
    const t = String(txt).replace(/[\s,，]/g, '').replace(/[+＋]/g, '');
    const m = t.match(/(\d+(?:\.\d+)?)\s*(亿|万|w|W|k|K)?/);
    if (!m) return NaN;
    let n = parseFloat(m[1]);
    if (!isFinite(n)) return NaN;
    const u = m[2] || '';
    if (u === '亿') n *= 1e8;
    else if (u === '万' || u === 'w' || u === 'W') n *= 1e4;
    else if (u === 'k' || u === 'K') n *= 1e3;
    return Math.round(n);
  }

  function fmtPlay(n) {
    if (!isFinite(n)) return '未知';
    if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(2).replace(/\.?0+$/, '') + '万';
    return String(n);
  }

  // 逗号/分号/竖线/换行分隔 -> 数组
  function splitNames(str) {
    return String(str || '').split(/[,，;；|\n\r]+/).map(s => s.trim()).filter(Boolean);
  }

  const cardRoot = () => document.querySelector(S.root) || document.body;
  const getCards = () => Array.from(cardRoot().querySelectorAll(S.card));

  /* ==================== 3. 卡片信息解析 ==================== */
  const infoCache = new WeakMap();

  // 跨布局兜底：标题依次尝试「当前页 → 搜索页 → 投稿页」选择器
  function readTitle(card) {
    for (const sel of [S.title, SEARCH_S.title, SPACE_S.title]) {
      if (!sel) continue;
      const el = card.querySelector(sel);
      if (el) {
        const t = (el.getAttribute('title') || el.textContent || '').trim();
        if (t) return t;
      }
    }
    return '';
  }

  // 跨布局兜底：播放量依次尝试各布局的第 1 个 stat（两套布局第 1 项都是播放量）
  function readPlay(card) {
    for (const sel of [S.statItem, SEARCH_S.statItem, SPACE_S.statItem]) {
      if (!sel) continue;
      const items = card.querySelectorAll(sel);
      if (!items.length) continue;
      const sp = items[0].querySelector('span') || items[0];
      const n = parsePlay(sp.textContent);
      if (isFinite(n)) return n;
    }
    return NaN;
  }

  function readInfo(card) {
    const title  = readTitle(card);
    const aEl = S.author ? card.querySelector(S.author) : null;
    // 投稿页无逐卡作者，统一用页面 UP主 名字
    const author = PAGE.kind === 'space' ? spaceOwner : (aEl ? aEl.textContent.trim() : '');
    // 页面类型也纳入签名：一旦 detectPage() 纠正了布局，缓存会自动失效重读
    const sig = PAGE.kind + '\u0001' + title + '\u0001' + author;

    const cached = infoCache.get(card);
    if (cached && cached.sig === sig) return cached;

    // 播放量（stats 第 1 项 = 播放，第 2 项 = 弹幕）
    const play = readPlay(card);

    // 链接 + BV号
    let url = '', bvid = '';
    for (const a of card.querySelectorAll(S.link)) {
      let href = a.getAttribute('href') || '';
      if (!href || /^javascript:/i.test(href)) continue;
      if (href.startsWith('//')) href = location.protocol + href;
      else if (href.startsWith('/')) href = location.origin + href;
      try {
        const u = new URL(href, location.href);
        const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
        if (m) { bvid = m[1]; url = u.origin + '/video/' + m[1] + '/'; break; }
      } catch (e) { /* ignore */ }
    }

    const info = { el: card, title, author, play, url, bvid, sig };
    // 播放量读不到时不写缓存：B站可能"先渲染卡片、后填播放量"，
    // 缓存 NaN 会导致永远 0 命中，所以每次筛选都重试读取
    if (isFinite(play)) infoCache.set(card, info);
    return info;
  }

  /* ==================== 4. 匹配规则 ==================== */
  function hasFilter() {
    const min = Number(cfg.minPlay);
    return (cfg.minPlay !== '' && cfg.minPlay != null && isFinite(min)) ||
           splitNames(cfg.author).length > 0 ||
           splitNames(cfg.keyword).length > 0;
  }

  function isMatch(info) {
    // 播放量 >= N
    if (cfg.minPlay !== '' && cfg.minPlay != null) {
      const min = Number(cfg.minPlay);
      if (isFinite(min)) {
        if (!isFinite(info.play) || info.play < min) return false;
      }
    }
    // UP主名字 等于 指定名字
    const names = splitNames(cfg.author);
    if (names.length) {
      const a = (info.author || '').toLowerCase();
      const ok = names.some(n => {
        const k = n.toLowerCase();
        return cfg.fuzzyAuthor ? a.includes(k) : a === k;
      });
      if (!ok) return false;
    }
    // 标题关键词（可选）
    const kws = splitNames(cfg.keyword);
    if (kws.length) {
      const t = (info.title || '').toLowerCase();
      if (!kws.every(k => t.includes(k.toLowerCase()))) return false;
    }
    return true;
  }

  /* ==================== 5. 筛选执行 ==================== */
  // 隐藏目标：老版 .video-list-item → 新版栅格列 → 卡片本身
  // 安全校验：若命中的祖先里装了不止一张卡片（说明爬太高，会整块列表消失），退化为卡片本身
  function hideTarget(card) {
    let w = card.closest(S.wrap) || card.closest(S.grid) || card;
    if (w !== card && w.querySelectorAll(S.card).length > 1) w = card;
    return w;
  }

  let lastStat = { matched: 0, total: 0, unknown: 0 };

  // 播放量暂时读不到（B站常「先渲染卡片、后填播放量数字」）时短暂轮询重试，
  // 数字填进来后会自动纠正；上限 12 次（约 6 秒）后停止，避免无意义轮询
  let retryTimer = 0, retryCount = 0;
  function scheduleRetry(unknown) {
    clearTimeout(retryTimer);
    if (!unknown) { retryCount = 0; return; }
    if (retryCount >= 12) return;
    retryCount++;
    retryTimer = setTimeout(applyFilter, 500);
  }

  // 本页 0 命中时的占位提示（否则整页全白，容易被误判成脚本坏了）
  const BANNER_ID = 'xh-bili-filter-banner';
  function updateBanner(active, matched, total, unknown) {
    let b = document.getElementById(BANNER_ID);
    // 注意：有「播放量读取失败但被保留显示」的卡片时，不算全空，不显示该提示
    const need = active && cfg.autoHide && matched === 0 && total > 0 && !unknown;
    if (!need) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = BANNER_ID;
      b.style.cssText = 'margin:18px 0;padding:16px;border:1px dashed #fb7299;border-radius:8px;' +
        'color:#fb7299;background:#fff5f8;font-size:14px;text-align:center;line-height:1.7;';
      const list = document.querySelector('.video-list');
      const holder = list && list.parentElement ? list.parentElement : null;
      if (!holder) return;
      holder.insertBefore(b, list);
    }
    b.textContent = `本页 ${total} 个视频都不符合筛选条件，已全部隐藏` +
      (Number(cfg.maxPages) > 1 ? ' —— 点面板里的「一键采集全部链接」可自动翻页继续找' : '');
  }

  function applyFilter() {
    detectPage();   // 每次筛选都重新确认页面类型：SPA 异步渲染，启动瞬间可能还探测不到卡片
    const cards = getCards();
    const active = hasFilter();
    let matched = 0, total = 0, unknown = 0;

    // 用户是否设置了播放量阈值（只有此时"播放量读不到"才需要保守处理）
    const needPlay = cfg.minPlay !== '' && cfg.minPlay != null && isFinite(Number(cfg.minPlay));

    for (const card of cards) {
      const info = readInfo(card);
      const wrap = hideTarget(card);

      // 广告 / 课程 / 直播等非普通视频卡片：过滤时一并隐藏
      if (!info.url) {
        if (cfg.autoHide && active) wrap.classList.add(HIDE_CLS);
        else wrap.classList.remove(HIDE_CLS);
        const b = card.querySelector('.' + BADGE_CLS);
        if (b) b.remove();
        continue;
      }
      total++;

      const ok = active ? isMatch(info) : false;
      if (ok) matched++;

      // 播放量没读到（布局不认识）→ 保守保留显示，绝不整页隐藏
      const playUnknown = needPlay && !isFinite(info.play);
      if (playUnknown) unknown++;

      // ★ 只有「不匹配 且 数据可读」才隐藏；命中/数据缺失的都必须保持显示
      if (cfg.autoHide && active && !ok && !playUnknown) wrap.classList.add(HIDE_CLS);
      else wrap.classList.remove(HIDE_CLS);

      // 命中角标
      let badge = card.querySelector('.' + BADGE_CLS);
      if (ok) {
        if (!badge) {
          badge = document.createElement('div');
          badge.className = BADGE_CLS;
          (card.querySelector('.bili-video-card__info') ||
           card.querySelector('.bili-video-card__details') ||
           card).appendChild(badge);
        }
        badge.textContent = '✔ 命中 · 播放 ' + fmtPlay(info.play) + (info.author ? ' · ' + info.author : '');
      } else if (badge) {
        badge.remove();
      }
    }

    lastStat = { matched, total, unknown };

    // 自愈保护：命中若干条却一条都显示不出来 → 判定隐藏逻辑异常，整体回滚
    if (active && cfg.autoHide && matched > 0) {
      const shown = getCards().filter(c => {
        const inf = readInfo(c);
        return inf.url && isMatch(inf) && !hideTarget(c).classList.contains(HIDE_CLS);
      }).length;
      if (shown === 0) {
        document.querySelectorAll('.' + HIDE_CLS).forEach(e => e.classList.remove(HIDE_CLS));
        console.warn('[B站筛选器] 检测到命中项全部被隐藏，已自动回滚隐藏状态');
        updateStat(`⚠ 命中 ${matched} 条但全被隐藏，已自动回滚（请反馈）`);
        return;
      }
    }

    updateBanner(active, matched, total, unknown);

    const unknownTip = unknown > 0
      ? ` · <b>${unknown} 条播放量读取失败，已保留显示</b>`
      : '';
    updateStat(active
      ? `命中 ${matched} / 共 ${total} 个视频${cfg.autoHide ? '（已隐藏不匹配，含广告/课程）' : ''}${unknownTip}`
      : '未设置筛选条件');

    scheduleRetry(unknown);   // 有播放量没读到的就过 0.5s 再试，等数字填进来
  }

  /* ==================== 6. 自动加载 + 批量采集 ==================== */
  const isEnd = () => /没有更多了|已经到底啦?|到底了|no more/i.test(document.body.textContent.slice(-4000));

  function scrollToBottom() {
    const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    window.scrollTo(0, h);
  }

  async function autoLoadAll(onProgress) {
    let last = getCards().length, stable = 0;
    for (let i = 0; i < 150; i++) {
      scrollToBottom();
      await sleep(900);
      const n = getCards().length;
      if (n <= last) stable++; else stable = 0;
      last = Math.max(last, n);
      onProgress && onProgress(`加载中… 已发现 ${n} 个卡片`);
      if (stable >= 3 || isEnd()) break;
    }
    onProgress && onProgress(`加载完成，共 ${getCards().length} 个卡片`);
  }

  function collectResults() {
    const out = [], seen = new Set();
    for (const card of getCards()) {
      const info = readInfo(card);
      if (!info.url || !isMatch(info)) continue;
      const key = info.bvid || info.url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(info);
    }
    return out;
  }

  /* ---------- 翻页支持（搜索结果 34 页需要一页页点） ---------- */
  function pagerBox() {
    return document.querySelector('.vui_pagenation') ||
           document.querySelector('[class*="pagenation"]');
  }

  function nextPageBtn() {
    const box = pagerBox();
    if (!box) return null;
    const btns = Array.from(box.querySelectorAll('button, a'));
    return btns.find(b => /下一页|下页/.test(b.textContent)) || null;
  }

  const isBtnDisabled = btn =>
    !btn || btn.disabled === true || /disabled/.test(String(btn.className)) ||
    btn.getAttribute('aria-disabled') === 'true';

  const pageKey = () => {
    const c = getCards()[0];
    return c ? (readInfo(c).bvid || readInfo(c).title) : '';
  };

  async function waitListChanged(before, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 10000)) {
      await sleep(300);
      const now = pageKey();
      if (now && now !== before) return true;
    }
    return false;
  }

  // 逐页采集：翻页 + 无限滚动列表都兼容，按 BV 号去重
  let abortFlag = false;
  async function collectAllPages(onProgress) {
    const out = [], seen = new Set();
    const maxPages = Number(cfg.maxPages) > 0 ? Number(cfg.maxPages) : 0; // 0 = 全部页
    let page = 1;

    while (true) {
      if (abortFlag) { onProgress && onProgress(`已手动停止，累计命中 ${out.length} 条`); break; }
      onProgress && onProgress(`第 ${page} 页：正在加载…`);
      await autoLoadAll(null);
      applyFilter();

      for (const info of collectResults()) {
        const key = info.bvid || info.url;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(info);
      }

      const totalPages = pagerBox() ? pagerBox().querySelectorAll('.vui_pagenation--btn-num').length : 0;
      onProgress && onProgress(`第 ${page} 页完成，累计命中 ${out.length} 条${totalPages ? `（分页区可见 ${totalPages} 个页码）` : ''}`);

      if (maxPages && page >= maxPages) break;

      const next = nextPageBtn();
      if (isBtnDisabled(next)) break;               // 没有下一页 / 已到最后一页

      const before = pageKey();
      next.click();
      page++;
      const ok = await waitListChanged(before, 12000);
      if (!ok) { onProgress && onProgress('翻页超时，已停止'); break; }
      window.scrollTo(0, 0);
      await sleep(600);
    }
    return out;
  }

  /* ==================== 7. 导出 ==================== */
  function download(filename, text) {
    const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  const csvCell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  /* ==================== 8. 界面 ==================== */
  let $ = {};   // shadow 内元素引用

  function buildUI() {
    document.getElementById(HOST_ID)?.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    const sr = host.attachShadow({ mode: 'open' });

    sr.innerHTML = `
<style>
  :host{ all: initial; }
  *{ box-sizing: border-box; font-family: -apple-system, "Microsoft YaHei", system-ui, sans-serif; }
  .panel{ position: fixed; top: 90px; right: 20px; width: 320px; background: #fff;
          border: 1px solid #e3e5e7; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.16);
          z-index: 2147483000; color: #18191c; font-size: 13px; }
  .hd{ display:flex; align-items:center; gap:6px; padding:8px 10px; cursor: move;
       background: linear-gradient(90deg,#fb7299,#fc9db8); color:#fff; border-radius: 9px 9px 0 0; user-select:none; }
  .hd b{ font-size:13px; font-weight:600; }
  .hd .sp{ flex:1; }
  .hd button{ background:rgba(255,255,255,.25); border:0; color:#fff; width:22px; height:20px;
              border-radius:4px; cursor:pointer; line-height:1; font-size:12px; }
  .hd button:hover{ background:rgba(255,255,255,.45); }
  .bd{ padding:10px; display:block; }
  .bd.hide{ display:none; }
  .row{ display:flex; align-items:center; gap:6px; margin-bottom:7px; }
  .row > label{ flex:0 0 62px; color:#61666d; }
  .hint{ flex:0 0 auto; color:#9499a0; font-size:11px; }
  input[type=text], input[type=number]{ flex:1; min-width:0; height:26px; padding:0 7px;
      border:1px solid #e3e5e7; border-radius:6px; outline:none; font-size:13px; background:#f6f7f8; color:#18191c; }
  input:focus{ border-color:#fb7299; background:#fff; }
  .chk{ gap:12px; }
  .chk label{ display:flex; align-items:center; gap:4px; color:#61666d; cursor:pointer; flex:none; }
  .btns button{ flex:1; height:28px; border:1px solid #e3e5e7; background:#f6f7f8; color:#18191c;
      border-radius:6px; cursor:pointer; font-size:12.5px; }
  .btns button:hover{ border-color:#fb7299; color:#fb7299; }
  .btns button.primary{ background:#fb7299; border-color:#fb7299; color:#fff; }
  .btns button.primary:hover{ background:#fc8bab; color:#fff; }
  .btns button:disabled{ opacity:.55; cursor: default; }
  .stat{ margin:2px 0 8px; color:#61666d; font-size:12px; line-height:1.5; word-break:break-all; }
  .stat b{ color:#fb7299; }
  textarea{ width:100%; height:120px; resize:vertical; padding:6px 7px; border:1px solid #e3e5e7;
      border-radius:6px; font-size:12px; line-height:1.5; background:#f6f7f8; color:#18191c;
      outline:none; font-family: Consolas, Menlo, monospace; }
  textarea:focus{ border-color:#fb7299; background:#fff; }
  .tip{ color:#9499a0; font-size:11.5px; line-height:1.5; margin-top:6px; }
  .fold{ position: fixed; top: 90px; right: 20px; z-index:2147483000; background:#fb7299; color:#fff;
      border-radius: 16px; padding: 6px 12px; font-size: 12.5px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.2);
      display:none; user-select:none; }
</style>
<div class="fold" id="fold">B站筛选器</div>
<div class="panel" id="panel">
  <div class="hd" id="hd">
    <b>B站筛选器</b>
    <span class="sp"></span>
    <button id="btnFold" title="折叠">—</button>
  </div>
  <div class="bd" id="bd">
    <div class="row"><label>播放量 ≥</label><input id="minPlay" type="number" min="0" step="100" placeholder="留空=不限"></div>
    <div class="row"><label>UP主 =</label><input id="author" type="text" placeholder="留空=不限，多个用逗号分隔"></div>
    <div class="row"><label>标题含</label><input id="keyword" type="text" placeholder="留空=不限，多个用逗号分隔"></div>
    <div class="row chk">
      <label><input type="checkbox" id="fuzzy"> UP主模糊</label>
      <label><input type="checkbox" id="autoHide"> 自动隐藏</label>
    </div>
    <div class="row"><label>采集页数</label><input id="maxPages" type="number" min="0" step="1" placeholder="5，0=全部页"><span class="hint">0=全部</span></div>
    <div class="row btns">
      <button id="btnApply" class="primary">应用筛选</button>
      <button id="btnClear">清除筛选</button>
    </div>
    <div class="stat" id="stat">未设置筛选条件</div>
    <div class="row btns">
      <button id="btnCollect" class="primary">一键采集全部链接</button>
    </div>
    <div class="stat" id="prog"></div>
    <textarea id="out" spellcheck="false" placeholder="采集结果会显示在这里"></textarea>
    <div class="row btns" style="margin-top:7px">
      <button id="btnCopy">复制链接</button>
      <button id="btnTxt">导出TXT</button>
      <button id="btnCsv">导出CSV</button>
    </div>
    <div class="tip">用法：填条件 → 应用筛选 → 一键采集全部链接（自动翻页/滚动，按 BV 号去重汇总）。</div>
  </div>
</div>`;

    document.documentElement.appendChild(host);

    // 全局样式（卡片在 light DOM 中）
    const st = document.createElement('style');
    st.textContent = `
      .${HIDE_CLS}{ display:none !important; }
      .${BADGE_CLS}{ margin-top:4px; display:inline-block; background:#e8fff3; color:#0a8f52;
        border:1px solid #9fe3c1; border-radius:4px; padding:1px 6px; font-size:11px; line-height:16px; }`;
    document.head.appendChild(st);

    $ = {
      host, sr,
      panel:    sr.getElementById('panel'),
      fold:     sr.getElementById('fold'),
      hd:       sr.getElementById('hd'),
      bd:       sr.getElementById('bd'),
      minPlay:  sr.getElementById('minPlay'),
      author:   sr.getElementById('author'),
      keyword:  sr.getElementById('keyword'),
      maxPages: sr.getElementById('maxPages'),
      fuzzy:    sr.getElementById('fuzzy'),
      autoHide: sr.getElementById('autoHide'),
      stat:     sr.getElementById('stat'),
      prog:     sr.getElementById('prog'),
      out:      sr.getElementById('out'),
      btnFold:    sr.getElementById('btnFold'),
      btnApply:   sr.getElementById('btnApply'),
      btnClear:   sr.getElementById('btnClear'),
      btnCollect: sr.getElementById('btnCollect'),
      btnCopy:    sr.getElementById('btnCopy'),
      btnTxt:     sr.getElementById('btnTxt'),
      btnCsv:     sr.getElementById('btnCsv')
    };

    // 回填配置
    $.minPlay.value  = cfg.minPlay;
    $.author.value   = cfg.author;
    $.keyword.value  = cfg.keyword;
    $.maxPages.value = cfg.maxPages;
    $.fuzzy.checked  = !!cfg.fuzzyAuthor;
    $.autoHide.checked = !!cfg.autoHide;
    if (cfg.collapsed) setFold(true);

    bindUI();
  }

  function updateStat(html) { if ($.stat) $.stat.innerHTML = html; }

  function setFold(fold) {
    cfg.collapsed = !!fold;
    $.panel.style.display = fold ? 'none' : 'block';
    $.fold.style.display  = fold ? 'block' : 'none';
    save();
  }

  function readUI() {
    cfg.minPlay    = $.minPlay.value.trim() === '' ? '' : Number($.minPlay.value);
    cfg.author     = $.author.value.trim();
    cfg.keyword    = $.keyword.value.trim();
    cfg.maxPages   = $.maxPages.value.trim() === '' ? 5 : Number($.maxPages.value);
    cfg.fuzzyAuthor = $.fuzzy.checked;
    cfg.autoHide   = $.autoHide.checked;
    save();
  }

  function bindUI() {
    // 拖动
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    $.hd.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      const r = $.panel.getBoundingClientRect();
      dragging = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      $.panel.style.right = 'auto';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    const onMove = e => {
      if (!dragging) return;
      $.panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      $.panel.style.top  = Math.max(0, oy + e.clientY - sy) + 'px';
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    $.btnFold.onclick = () => setFold(true);
    $.fold.onclick    = () => setFold(false);

    $.btnApply.onclick = () => { readUI(); retryCount = 0; applyFilter(); };

    $.btnClear.onclick = () => {
      $.minPlay.value = ''; $.author.value = ''; $.keyword.value = '';
      readUI(); applyFilter();
      updateStat('未设置筛选条件');
    };

    // 输入即时生效（防抖）
    let t = 0;
    const live = () => { clearTimeout(t); t = setTimeout(() => { readUI(); retryCount = 0; applyFilter(); }, 350); };
    [$.minPlay, $.author, $.keyword].forEach(el => el.addEventListener('input', live));
    [$.fuzzy, $.autoHide].forEach(el => el.addEventListener('change', live));

    $.btnCollect.onclick = async () => {
      // 采集中再点一次 = 停止
      if ($.btnCollect.dataset.busy === '1') { abortFlag = true; $.btnCollect.textContent = '正在停止…'; return; }

      readUI();
      if (!hasFilter()) { updateStat('请先设置筛选条件'); return; }

      abortFlag = false;
      $.btnCollect.dataset.busy = '1';
      $.btnCollect.textContent = '采集中…（再点可停止）';
      try {
        const list = await collectAllPages(msg => { $.prog.textContent = msg; });
        applyFilter();
        $.out.value = list.map(i => `${i.title} | ${i.author} | ${fmtPlay(i.play)} | ${i.url}`).join('\n');
        $.prog.textContent = `采集完成：共 ${list.length} 条符合条件（播放量 ≥ ${cfg.minPlay || '不限'}，页数 ${cfg.maxPages || '全部'}）`;
      } catch (e) {
        $.prog.textContent = '采集出错：' + (e && e.message ? e.message : e);
      } finally {
        delete $.btnCollect.dataset.busy;
        $.btnCollect.textContent = '一键采集全部链接';
      }
    };

    $.btnCopy.onclick = () => {
      const links = collectResults().map(i => i.url).join('\n');
      if (!links) { $.prog.textContent = '没有可复制的结果'; return; }
      const n = links.split('\n').length;
      try { GM_setClipboard(links, 'text'); }
      catch (e) {
        const ta = document.createElement('textarea');
        ta.value = links; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      $.prog.textContent = `已复制 ${n} 条链接`;
    };

    $.btnTxt.onclick = () => {
      const list = collectResults();
      if (!list.length) { $.prog.textContent = '没有可导出的结果'; return; }
      download(`bili_links_${stamp()}.txt`, list.map(i => i.url).join('\r\n'));
      $.prog.textContent = `已导出 ${list.length} 条链接（TXT）`;
    };

    $.btnCsv.onclick = () => {
      const list = collectResults();
      if (!list.length) { $.prog.textContent = '没有可导出的结果'; return; }
      const rows = [['标题', 'UP主', '播放量', '链接'].map(csvCell).join(',')];
      list.forEach(i => rows.push([i.title, i.author, i.play, i.url].map(csvCell).join(',')));
      download(`bili_filtered_${stamp()}.csv`, rows.join('\r\n'));
      $.prog.textContent = `已导出 ${list.length} 条（CSV，含标题/UP主/播放量）`;
    };
  }

  /* ==================== 9. 动态内容监听 ==================== */
  let timer = 0;
  function scheduleApply() {
    clearTimeout(timer);
    timer = setTimeout(applyFilter, 250);
  }

  function observeCards() {
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.target && m.target.nodeType === 1 && m.target.closest && m.target.closest('#' + HOST_ID)) continue;
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.classList && n.classList.contains(BADGE_CLS)) continue;
          if ((n.matches && n.matches(S.card)) || (n.querySelector && n.querySelector(S.card))) {
            scheduleApply();
            return;
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // SPA 路由变化（切换搜索 tab / 翻页 / 空间内切换频道）后重新探测并筛选
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      detectPage();
      setTimeout(applyFilter, 1200);
    }
  }, 1200);

  /* ==================== 10. 启动 ==================== */
  function boot() {
    detectPage();
    buildUI();
    observeCards();
    setTimeout(applyFilter, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('显示/隐藏 筛选面板', () => setFold($.panel && $.panel.style.display !== 'none'));
    GM_registerMenuCommand('重新筛选', () => { applyFilter(); });
  }
})();

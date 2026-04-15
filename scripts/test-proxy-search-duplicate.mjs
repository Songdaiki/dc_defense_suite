#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * 프록시 기반 역류글 중복 검색 테스트 스크립트 (통합검색 HTML 방식)
 *
 * 흐름:
 *   1. Webshare API → 프록시 리스트 획득
 *   2. thesingularity 갤러리 목록 → 유동글 제목 파싱 (기존 parser.js 로직 차용)
 *   3. 제목마다 프록시 돌려가며 통합검색 HTML (search.dcinside.com/combine/q/...) 호출
 *   4. 같은 갤 + 같은 제목(정규화) + 다른 글번호 → duplicate 판정
 *
 * 사용법:
 *   node scripts/test-proxy-search-duplicate.mjs
 */

import https from 'node:https';
import http from 'node:http';

// ─── 설정 ──────────────────────────────────────────────────────────
const WEBSHARE_API_KEY = 'urjvuojy8nwnqx0ydgogsvjljanjegec7re4ervg';
const GALLERY_ID = 'thesingularity';
const GALLERY_URL = `https://gall.dcinside.com/mgallery/board/lists/?id=${GALLERY_ID}`;
const SEARCH_TARGET_GALLERY_ID = GALLERY_ID;
const MAX_SEARCH_TITLES = 50; // 유동글 전체
const REQUEST_DELAY_MS = 100; // 프록시 돌리니까 빠르게

// ─── 유틸 ──────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeText(text) {
  return decodeHtml(String(text || '')).replace(/\s+/g, ' ').trim();
}

/**
 * DC 통합검색 URL 인코딩 (% 대신 . 을 사용하는 DC 전용 형식)
 * 예: "씨드림" → ".EC.94.A8.EB.93.9C.EB.A6.BC"
 *
 * 주의: encodeURIComponent는 ( ) ! * ' 를 인코딩하지 않음
 *       DC 서버는 이 문자가 URL path에 들어가면 400을 반환하므로 수동 인코딩 필요
 */
function dcUrlEncode(text) {
  let encoded = encodeURIComponent(text);
  // encodeURIComponent가 빠뜨리는 문자들 수동 인코딩
  encoded = encoded
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27');
  // %XX → .XX 로 변환
  return encoded.replace(/%/g, '.');
}

/**
 * 중복 비교용 정규화: 한글 필러(ᅠ), ZWSP, 불가시 문자 모두 제거
 * 역류기가 제목에 한글 필러(U+3164, U+FFA0 등)를 끼워넣어 우회하는 것을 방어
 */
function normalizeForDup(text) {
  return normalizeText(text)
    // 한글 필러 (U+3164 HANGUL FILLER, U+FFA0 HALFWIDTH HANGUL FILLER)
    .replace(/[\u3164\uFFA0]/g, '')
    // 반각 한글 호환 자모 중 필러 역할 (U+115F, U+1160, U+3164)
    .replace(/[\u115F\u1160]/g, '')
    // Zero-Width 문자들 (ZWSP, ZWNJ, ZWJ, FEFF BOM 등)
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/g, '')
    // 연속 공백 정리
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── 갤러리 파서 (기존 parser.js 로직 동일) ──────────────────────────

function extractSubject(rowHtml) {
  const titleMatch = rowHtml.match(/<td[^>]*class="gall_tit[^"]*"[^>]*>([\s\S]*?)<\/td>/);
  if (!titleMatch) return '';
  const titleHtml = titleMatch[1]
    .replace(/<em[^>]*class="icon_[^"]*"[\s\S]*?<\/em>/gi, ' ')
    .replace(/<span[^>]*class="reply_num"[\s\S]*?<\/span>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return normalizeText(titleHtml);
}

function isRegularBoardRow(rowHtml) {
  const gallNumMatch = rowHtml.match(/<td[^>]*class="gall_num[^"]*"[^>]*>([\s\S]*?)<\/td>/);
  if (!gallNumMatch) return false;
  const gallNumText = normalizeText(gallNumMatch[1].replace(/<[^>]+>/g, ' '));
  return /^\d+$/.test(gallNumText);
}

function extractWriterMeta(rowHtml) {
  const writerMatch = rowHtml.match(/<td[^>]*class="gall_writer[^"]*"[^>]*/);
  if (!writerMatch) return null;
  const writerTag = writerMatch[0];
  const ipMatch = writerTag.match(/data-ip="([^"]*)"/);
  const nickMatch = writerTag.match(/data-nick="([^"]*)"/);
  return {
    ip: decodeHtml(ipMatch ? ipMatch[1] : ''),
    nick: decodeHtml(nickMatch ? nickMatch[1] : ''),
    isFluid: Boolean(ipMatch && ipMatch[1]),
  };
}

function parseBoardPosts(html) {
  const results = [];
  const rowRegex = /<tr[^>]*class="ub-content[^"]*"[^>]*data-no="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const postNo = parseInt(match[1], 10);
    if (postNo <= 0) continue;
    const rowHtml = match[2];
    if (!isRegularBoardRow(rowHtml)) continue;
    const writerMeta = extractWriterMeta(rowHtml);
    if (!writerMeta) continue;
    results.push({
      no: postNo,
      nick: writerMeta.nick,
      ip: writerMeta.ip,
      isFluid: writerMeta.isFluid,
      subject: extractSubject(rowHtml),
    });
  }
  return results;
}

// ─── 통합검색 HTML 파서 ─────────────────────────────────────────────

/**
 * 통합검색 HTML에서 게시물 검색 결과를 파싱
 *
 * 구조:
 *   <ul class="sch_result_list">
 *     <li>
 *       <a href="...?id=thesingularity&no=1108445" class="tit_txt"><b>씨드림</b>...</a>
 *       <p class="link_dsc_txt dsc_sub">
 *         <a href="..." class="sub_txt">특이점이 온다 갤러리</a>
 *         <span class="date_time">2026.04.15 21:18</span>
 *       </p>
 *     </li>
 *   </ul>
 */
function parseSearchResults(html) {
  const results = [];

  // sch_result_list 영역 추출
  const listMatch = html.match(/<ul\s+class="sch_result_list">([\s\S]*?)<\/ul>/);
  if (!listMatch) {
    return results;
  }
  const listHtml = listMatch[1];

  // 각 <li> 파싱
  const liRegex = /<li>([\s\S]*?)<\/li>/g;
  let match;

  while ((match = liRegex.exec(listHtml)) !== null) {
    const liHtml = match[1];

    // 제목 + 링크: <a href="...?id=XXX&no=YYY" class="tit_txt">제목</a>
    const titleMatch = liHtml.match(/<a\s+href="([^"]*)"[^>]*class="tit_txt"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;

    const href = decodeHtml(titleMatch[1]);
    const rawTitle = titleMatch[2];
    // <b> 태그 제거하여 순수 제목 추출
    const title = normalizeText(rawTitle.replace(/<[^>]*>/g, ''));

    // URL에서 id와 no 추출
    const idMatch = href.match(/[?&]id=([^&]+)/);
    const noMatch = href.match(/[?&]no=(\d+)/);
    const boardId = idMatch ? idMatch[1] : '';
    const postNo = noMatch ? parseInt(noMatch[1], 10) : 0;

    // 갤러리 이름: <a class="sub_txt">특이점이 온다 갤러리</a>
    const gallNameMatch = liHtml.match(/<a[^>]*class="sub_txt"[^>]*>([\s\S]*?)<\/a>/);
    const gallName = gallNameMatch ? normalizeText(gallNameMatch[1]) : '';

    // 날짜: <span class="date_time">2026.04.15 21:18</span>
    const dateMatch = liHtml.match(/<span\s+class="date_time">([\s\S]*?)<\/span>/);
    const datetime = dateMatch ? normalizeText(dateMatch[1]) : '';

    results.push({ title, boardId, postNo, gallName, datetime, href });
  }

  return results;
}

// ─── HTTP(S) 유틸 ──────────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Accept-Encoding': 'identity',
        ...headers,
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('타임아웃')); });
  });
}

/** Webshare HTTP 프록시를 통한 요청 */
function httpGetViaProxy(targetUrl, proxy) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const proxyAuth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');

    const options = {
      hostname: proxy.host,
      port: proxy.port,
      path: targetUrl,
      method: 'GET',
      headers: {
        'Host': parsed.hostname,
        'Proxy-Authorization': `Basic ${proxyAuth}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Accept-Encoding': 'identity',
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`프록시 응답 ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('프록시 요청 타임아웃')); });
    req.end();
  });
}

// ─── 1단계: Webshare 프록시 리스트 획득 ─────────────────────────────
async function fetchProxyList() {
  log('PROXY', 'Webshare API에서 프록시 리스트 가져오는 중...');

  const { body } = await httpsGet(
    'https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100',
    { 'Authorization': `Token ${WEBSHARE_API_KEY}` }
  );

  const json = JSON.parse(body);
  if (!json.results || json.results.length === 0) {
    throw new Error(`프록시 리스트 비어있음. 응답: ${body.slice(0, 200)}`);
  }

  const proxies = json.results
    .filter(p => p.valid)
    .map(p => ({
      host: p.proxy_address,
      port: p.port,
      username: p.username,
      password: p.password,
      country: p.country_code,
    }));

  log('PROXY', `유효 프록시 ${proxies.length}개 획득 (총 ${json.count}개 중)`);
  return proxies;
}

// ─── 프록시 라운드로빈 ──────────────────────────────────────────────
let proxyIndex = 0;
function getNextProxy(proxies) {
  const proxy = proxies[proxyIndex % proxies.length];
  proxyIndex++;
  return proxy;
}

// ─── 2단계: 갤러리 목록 파싱 ────────────────────────────────────────
async function fetchGalleryPosts() {
  log('GALLERY', `${GALLERY_ID} 갤러리 목록 가져오는 중 (직접 접근)...`);
  const { body: html } = await httpsGet(GALLERY_URL);
  const allPosts = parseBoardPosts(html);
  log('GALLERY', `전체 파싱 ${allPosts.length}개, 유동글 ${allPosts.filter(p => p.isFluid).length}개`);
  const fluidPosts = allPosts.filter(p => p.isFluid).slice(0, MAX_SEARCH_TITLES);
  const posts = fluidPosts.length > 0 ? fluidPosts : allPosts.slice(0, MAX_SEARCH_TITLES);
  if (posts.length === 0) {
    log('GALLERY', `HTML 앞부분 (디버그): ${html.slice(0, 500)}`);
  }
  return posts;
}

// ─── 3단계: 통합검색 HTML 호출 + 파싱 ───────────────────────────────
async function searchTitle(title, proxy) {
  // DC 통합검색 URL: https://search.dcinside.com/combine/q/.EC.94.A8...
  const dcEncoded = dcUrlEncode(title);
  const searchUrl = `https://search.dcinside.com/combine/q/${dcEncoded}`;

  log('SEARCH', `검색: "${title.slice(0, 40)}" → 프록시: ${proxy.host}:${proxy.port} (${proxy.country})`);
  log('SEARCH', `URL: ${searchUrl.slice(0, 120)}...`);

  try {
    let body;
    let usedProxy = true;

    // 프록시로 시도
    try {
      const resp = await httpGetViaProxy(searchUrl, proxy);
      body = resp.body;
      log('SEARCH', `프록시 응답: ${resp.statusCode}, body길이=${body.length}`);
    } catch (proxyErr) {
      log('SEARCH', `프록시 실패 (${proxyErr.message}), 직접 접근 시도...`);
      usedProxy = false;
      const resp = await httpsGet(searchUrl);
      body = resp.body;
      log('SEARCH', `직접 응답: ${resp.statusCode}, body길이=${body.length}`);
    }

    // 통합검색 HTML 파싱
    const searchResults = parseSearchResults(body);
    log('SEARCH', `파싱 결과: ${searchResults.length}건`);

    // 디버그: 파싱된 결과 첫 3개 출력
    for (const r of searchResults.slice(0, 3)) {
      log('SEARCH', `  → [${r.boardId}] #${r.postNo} "${r.title.slice(0, 40)}" (${r.gallName}) ${r.datetime}`);
    }

    return { results: searchResults, error: null, usedProxy };
  } catch (e) {
    log('SEARCH', `검색 실패: ${e.message}`);
    return { results: [], error: e.message };
  }
}

// ─── 4단계: 중복 판정 ───────────────────────────────────────────────
function checkDuplicates(currentPost, searchResults) {
  const currentNorm = normalizeForDup(currentPost.subject);
  const duplicates = [];

  for (const result of searchResults) {
    const resultNorm = normalizeForDup(result.title);

    // 조건1: 같은 갤
    const sameGallery = result.boardId === SEARCH_TARGET_GALLERY_ID;
    // 조건2: 같은 제목 (필러 문자 제거 후 비교)
    const sameTitle = resultNorm === currentNorm;
    // 조건3: 다른 글번호 (자기 자신 제외)
    const differentPost = result.postNo !== currentPost.no;

    if (sameGallery && sameTitle && differentPost) {
      duplicates.push(result);
    }
  }

  return duplicates;
}

// ─── 메인 ──────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(70));
  console.log('  프록시 기반 역류글 중복 검색 테스트 (통합검색 HTML 방식)');
  console.log('='.repeat(70));
  console.log();

  // 1. 프록시 리스트
  let proxies;
  try {
    proxies = await fetchProxyList();
  } catch (e) {
    log('ERROR', `프록시 리스트 획득 실패: ${e.message}`);
    process.exit(1);
  }

  log('PROXY', '프록시 샘플 (처음 3개):');
  for (const p of proxies.slice(0, 3)) {
    log('PROXY', `  ${p.host}:${p.port} (${p.country}) user=${p.username}`);
  }
  console.log();

  // 2. 갤러리 목록 파싱
  let posts;
  try {
    posts = await fetchGalleryPosts();
  } catch (e) {
    log('ERROR', `갤러리 접근 실패: ${e.message}`);
    process.exit(1);
  }

  if (posts.length === 0) {
    log('ERROR', '파싱된 게시물이 없습니다');
    process.exit(1);
  }

  log('GALLERY', `테스트 대상 게시물 ${posts.length}개:`);
  for (const p of posts) {
    log('GALLERY', `  #${p.no} [${p.isFluid ? '유동' : '고닉'}] ${p.nick}(${p.ip || 'N/A'}): "${p.subject}"`);
  }
  console.log();

  // 3. 검색 + 판정
  const results = [];

  for (const post of posts) {
    const proxy = getNextProxy(proxies);
    const searchResult = await searchTitle(post.subject, proxy);

    if (searchResult.error) {
      results.push({
        post, proxy: `${proxy.host}:${proxy.port}`,
        status: 'ERROR', error: searchResult.error,
        duplicates: [],
      });
    } else {
      const duplicates = checkDuplicates(post, searchResult.results);
      results.push({
        post, proxy: `${proxy.host}:${proxy.port}`,
        status: duplicates.length > 0 ? '🔴 DUPLICATE' : '🟢 UNIQUE',
        totalResults: searchResult.results.length,
        sameGalleryResults: searchResult.results.filter(r => r.boardId === SEARCH_TARGET_GALLERY_ID).length,
        duplicates,
        usedProxy: searchResult.usedProxy,
      });
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // ─── 결과 출력 ──────────────────────────────────────────────────
  console.log();
  console.log('='.repeat(70));
  console.log('  결과 요약');
  console.log('='.repeat(70));
  console.log();

  for (const r of results) {
    const icon = r.status;

    console.log(`${icon}  #${r.post.no}: "${r.post.subject}"`);
    console.log(`         프록시: ${r.proxy} (${r.usedProxy ? '프록시 사용' : '직접 접근'})`);

    if (r.error) {
      console.log(`         에러: ${r.error}`);
    } else {
      console.log(`         검색: 전체 ${r.totalResults}건, 같은 갤 ${r.sameGalleryResults}건`);
      if (r.duplicates.length > 0) {
        for (const d of r.duplicates) {
          console.log(`         ↳ 중복 발견: #${d.postNo} "${d.title}" (${d.datetime}) [${d.gallName}]`);
        }
      }
    }
    console.log();
  }

  const dupCount = results.filter(r => r.status.includes('DUPLICATE')).length;
  const uniqueCount = results.filter(r => r.status.includes('UNIQUE')).length;
  const errCount = results.filter(r => r.error).length;

  console.log('─'.repeat(70));
  console.log(`  총 ${results.length}건 | 🔴 중복 ${dupCount} | 🟢 고유 ${uniqueCount} | ⚠️  에러 ${errCount}`);
  console.log('─'.repeat(70));
}

main().catch(e => {
  log('FATAL', e.stack || e.message);
  process.exit(1);
});

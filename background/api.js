/**
 * DC Comment Protect - API 모듈
 * 
 * 디시인사이드 내부 API 호출을 담당합니다.
 * SPEC.md에서 확인된 엔드포인트와 파라미터를 사용합니다.
 */

// ============================================================
// 설정
// ============================================================
const DC_CONFIG = {
  galleryId: 'thesingularity',
  galleryType: 'M',           // M = 마이너 갤러리
  baseUrl: 'https://gall.dcinside.com',
};

// ============================================================
// 공통 fetch 래퍼
// ============================================================

/**
 * 디시인사이드 API 요청 공통 래퍼
 * - credentials: include → 로그인 세션 쿠키 자동 포함
 * - X-Requested-With → AJAX 요청으로 인식
 */
async function dcFetch(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'include',
    headers: options.headers || {},
    ...options,
  });

  return response;
}

/**
 * 레이트 리밋 대응 재시도 래퍼
 */
async function dcFetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await dcFetch(url, options);

      if (response.status === 429) {
        const backoff = (i + 1) * 2000;
        console.warn(`[API] 레이트 리밋 감지. ${backoff}ms 대기 후 재시도...`);
        await delay(backoff);
        continue;
      }

      if (response.status === 403) {
        console.warn('[API] ⚠️ 접근 차단 감지. 30초 대기...');
        await delay(30000);
        continue;
      }

      return response;
    } catch (error) {
      console.error(`[API] 네트워크 에러: ${error.message}. 재시도 ${i + 1}/${maxRetries}`);
      await delay(1000);
    }
  }

  throw new Error('[API] 최대 재시도 횟수 초과');
}

// ============================================================
// API 함수들
// ============================================================

/**
 * 게시물 목록 가져오기
 * @param {number} page - 페이지 번호 (1~)
 * @returns {Promise<{posts: Array<{no: number, commentCount: number}>, esno: string|null}>}
 */
async function fetchPostList(page = 1) {
  const url = `${DC_CONFIG.baseUrl}/mgallery/board/lists/?id=${DC_CONFIG.galleryId}&page=${page}`;

  const response = await dcFetchWithRetry(url);
  const html = await response.text();
  const esno = extractEsno(html);

  // 목록 행에서 게시물 번호와 댓글 수를 같이 추출
  const posts = [];
  const rowRegex = /<tr class="ub-content[^"]*"[^>]*data-no="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const no = parseInt(match[1], 10);
    if (no > 0) {
      const rowHtml = match[2];
      const replyMatch = rowHtml.match(/<span class="reply_num">\[(\d+)\]<\/span>/);
      const commentCount = replyMatch ? parseInt(replyMatch[1], 10) : 0;
      posts.push({ no, commentCount });
    }
  }

  // fallback: 행 파싱에 실패하면 번호만 추출
  if (posts.length === 0) {
    const dataNoRegex = /data-no="(\d+)"/g;
    while ((match = dataNoRegex.exec(html)) !== null) {
      const no = parseInt(match[1], 10);
      if (no > 0) {
        posts.push({ no, commentCount: 0 });
      }
    }
  }

  const dedupedPosts = [];
  const seen = new Map();

  for (const post of posts) {
    if (!seen.has(post.no)) {
      seen.set(post.no, dedupedPosts.length);
      dedupedPosts.push(post);
      continue;
    }

    const index = seen.get(post.no);
    dedupedPosts[index].commentCount = Math.max(dedupedPosts[index].commentCount, post.commentCount);
  }

  return {
    posts: dedupedPosts,
    esno,
  };
}

/**
 * 게시물 페이지 HTML 가져오기 (e_s_n_o 토큰 추출용)
 * @param {number} postNo - 게시물 번호
 * @returns {Promise<string>} 페이지 HTML
 */
async function fetchPostPage(postNo) {
  const url = `${DC_CONFIG.baseUrl}/mgallery/board/view/?id=${DC_CONFIG.galleryId}&no=${postNo}`;
  
  const response = await dcFetchWithRetry(url);
  const html = await response.text();

  if (html.includes('정상적인 접근이 아닙니다')) {
    throw new Error('게시물 페이지 접근 차단 응답을 받았습니다');
  }

  return html;
}

/**
 * 게시물 페이지 HTML에서 e_s_n_o 토큰 추출
 * @param {string} html - 게시물 페이지 HTML
 * @returns {string|null} e_s_n_o 토큰
 */
function extractEsno(html) {
  // 방법 1: JavaScript 변수에서 추출
  const match1 = html.match(/e_s_n_o\s*=\s*['"]([^'"]+)['"]/);
  if (match1) return match1[1];

  // 방법 2: hidden input에서 추출
  const match2 = html.match(/name=['"]e_s_n_o['"][^>]*value=['"]([^'"]+)['"]/);
  if (match2) return match2[1];

  // 방법 3: data attribute에서 추출
  const match3 = html.match(/data-esno=['"]([^'"]+)['"]/);
  if (match3) return match3[1];

  console.error('[API] e_s_n_o 토큰 추출 실패!');
  return null;
}

/**
 * 댓글 목록 가져오기
 * 
 * POST /board/comment/
 * Body: id, no, cmt_id, cmt_no, e_s_n_o, comment_page, sort, _GALLTYPE_
 * 
 * @param {number} postNo - 게시물 번호
 * @param {string} esno - e_s_n_o 토큰
 * @param {number} commentPage - 댓글 페이지 (기본 1)
 * @returns {Promise<{comments: Array, totalCnt: number}>}
 */
async function fetchComments(postNo, esno, commentPage = 1) {
  const url = `${DC_CONFIG.baseUrl}/board/comment/`;

  const body = new URLSearchParams({
    id: DC_CONFIG.galleryId,
    no: String(postNo),
    cmt_id: DC_CONFIG.galleryId,
    cmt_no: String(postNo),
    e_s_n_o: esno,
    comment_page: String(commentPage),
    sort: 'D',
    _GALLTYPE_: DC_CONFIG.galleryType,
  });

  const response = await dcFetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${DC_CONFIG.baseUrl}/mgallery/board/view/?id=${DC_CONFIG.galleryId}&no=${postNo}`,
    },
    body: body.toString(),
  });

  const data = await response.json();

  return {
    comments: data.comments || [],
    totalCnt: data.total_cnt || 0,
  };
}

/**
 * 댓글 전체 페이지 가져오기
 *
 * 댓글 API는 페이지 단위로 응답하므로, total_cnt 기준으로 후속 페이지를 추가 조회합니다.
 *
 * @param {number} postNo - 게시물 번호
 * @param {string} esno - e_s_n_o 토큰
 * @returns {Promise<{comments: Array, totalCnt: number}>}
 */
async function fetchAllComments(postNo, esno, pageConcurrency = 4) {
  const firstPage = await fetchComments(postNo, esno, 1);
  const allComments = [...firstPage.comments];
  const firstPageSize = firstPage.comments.length || 20;
  const totalPages = Math.max(1, Math.ceil(firstPage.totalCnt / firstPageSize));

  if (totalPages > 1) {
    const pageNumbers = [];
    for (let page = 2; page <= totalPages; page++) {
      pageNumbers.push(page);
    }

    const pageResults = await mapWithConcurrency(
      pageNumbers,
      pageConcurrency,
      async (page) => ({
        page,
        data: await fetchComments(postNo, esno, page),
      }),
    );

    for (const result of pageResults) {
      allComments.push(...result.data.comments);
    }
  }

  return {
    comments: allComments,
    totalCnt: firstPage.totalCnt,
  };
}

/**
 * ci_t 토큰 가져오기 (= ci_c 쿠키값)
 * @returns {Promise<string|null>}
 */
async function getCiToken() {
  try {
    const cookie = await chrome.cookies.get({
      url: DC_CONFIG.baseUrl,
      name: 'ci_c',
    });
    return cookie ? cookie.value : null;
  } catch (error) {
    console.error('[API] ci_c 쿠키 가져오기 실패:', error.message);
    return null;
  }
}

/**
 * 댓글 삭제 (부매니저/매니저 전용)
 * 
 * POST /ajax/minor_manager_board_ajax/delete_comment
 * Body: ci_t, id, _GALLTYPE_, pno, cmt_nos[]
 * 
 * @param {number} postNo - 게시물 번호
 * @param {string[]} commentNos - 삭제할 댓글 번호 배열
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function deleteComments(postNo, commentNos) {
  if (commentNos.length === 0) {
    return { success: true, message: '삭제할 댓글 없음' };
  }

  const ciToken = await getCiToken();
  if (!ciToken) {
    return { success: false, message: 'ci_t 토큰(ci_c 쿠키) 없음. 로그인 상태를 확인하세요.' };
  }

  const url = `${DC_CONFIG.baseUrl}/ajax/minor_manager_board_ajax/delete_comment`;

  // cmt_nos[]는 배열 파라미터 → 수동 직렬화
  const bodyParts = [
    `ci_t=${encodeURIComponent(ciToken)}`,
    `id=${encodeURIComponent(DC_CONFIG.galleryId)}`,
    `_GALLTYPE_=${encodeURIComponent(DC_CONFIG.galleryType)}`,
    `pno=${encodeURIComponent(String(postNo))}`,
  ];

  for (const cno of commentNos) {
    bodyParts.push(`cmt_nos%5B%5D=${encodeURIComponent(String(cno))}`);
  }

  const response = await dcFetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${DC_CONFIG.baseUrl}/mgallery/board/view/?id=${DC_CONFIG.galleryId}&no=${postNo}`,
      'Origin': DC_CONFIG.baseUrl,
    },
    body: bodyParts.join('&'),
  });

  const responseText = await response.text();

  try {
    const data = JSON.parse(responseText);
    return {
      success: isDeleteResponseSuccessful(response, data),
      message: JSON.stringify(data),
    };
  } catch {
    return { success: response.ok, message: responseText };
  }
}

// ============================================================
// 유틸리티
// ============================================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (items.length === 0) {
    return [];
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

function isDeleteResponseSuccessful(response, data) {
  if (!response.ok) {
    return false;
  }

  if (!data || typeof data !== 'object') {
    return true;
  }

  if ('success' in data) {
    return data.success === true || data.success === 'true';
  }

  const result = String(data.result || data.status || '').toLowerCase();
  if (!result) {
    return true;
  }

  return result === 'success' || result === 'ok' || result === 'true';
}

// ============================================================
// Export
// ============================================================
export {
  DC_CONFIG,
  fetchPostList,
  fetchPostPage,
  extractEsno,
  fetchComments,
  fetchAllComments,
  getCiToken,
  deleteComments,
  delay,
};

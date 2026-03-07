/**
 * DC Post Protect - 파서/필터링 모듈
 * 
 * 게시물 목록 HTML을 파싱하여 유동닉 게시물을 식별합니다.
 * SPEC.md에서 확인된 판별 로직을 사용합니다.
 * 
 * 확인된 사실 (SPEC.md §1):
 * - 유동닉: <td class="gall_writer"> 의 data-ip 속성에 값 있음 (예: "115.4")
 * - 고정닉: data-ip 속성이 빈 문자열 ("")
 * - 게시물 번호: <tr> 태그의 data-no 속성
 * - 현재 머릿말: <td class="gall_subject"> 텍스트
 */

// ============================================================
// HTML 파싱
// ============================================================

/**
 * 게시물 목록 HTML에서 유동닉 게시물 추출
 * 
 * @param {string} html - 게시물 목록 페이지 HTML
 * @returns {Array<{no: number, nick: string, ip: string, currentHead: string}>}
 */
function parseFluidPosts(html) {
    const results = [];

    // 각 게시물 행 매칭: <tr class="ub-content ..." data-no="...">...</tr>
    const rowRegex = /<tr[^>]*class="ub-content[^"]*"[^>]*data-no="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
    let match;

    while ((match = rowRegex.exec(html)) !== null) {
        const postNo = parseInt(match[1], 10);
        if (postNo <= 0) continue;

        const rowHtml = match[2];

        // gall_writer td 전체 태그 매칭
        const writerMatch = rowHtml.match(/<td[^>]*class="gall_writer[^"]*"[^>]*>/);
        if (!writerMatch) continue;

        const writerTag = writerMatch[0];

        // data-ip 속성 추출
        const ipMatch = writerTag.match(/data-ip="([^"]*)"/);
        const ip = ipMatch ? ipMatch[1] : '';

        // 유동닉이 아니면 스킵 (IP 없음 = 고정닉)
        if (!ip) continue;

        // data-nick 속성 추출
        const nickMatch = writerTag.match(/data-nick="([^"]*)"/);
        const nick = nickMatch ? nickMatch[1] : '';

        // 현재 머릿말 확인 (이미 도배기면 스킵)
        const currentHead = extractCurrentHead(rowHtml);

        if (currentHead.includes('도배기')) continue;

        results.push({
            no: postNo,
            nick,
            ip,
            currentHead,
        });
    }

    return results;
}

/**
 * 파싱된 유동닉 게시물에서 번호만 추출
 * 
 * @param {Array} posts - parseFluidPosts() 결과
 * @returns {string[]} 게시물 번호 배열
 */
function extractPostNos(posts) {
    return posts.map(p => String(p.no));
}

function extractCurrentHead(rowHtml) {
    const subjectMatch = rowHtml.match(/<td[^>]*class="gall_subject[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    if (!subjectMatch) {
        return '';
    }

    const subjectHtml = subjectMatch[1]
        .replace(/<p[^>]*class="subject_inner"[\s\S]*?<\/p>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&#39;/g, '\'')
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, ' ')
        .trim();

    return subjectHtml.replace(/\s*,\s*/g, ',').replace(/,+$/g, '');
}

// ============================================================
// Export
// ============================================================
export {
    parseFluidPosts,
    extractPostNos,
};

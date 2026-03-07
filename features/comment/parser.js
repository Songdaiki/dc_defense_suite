/**
 * DC Comment Protect - 파서/필터링 모듈
 * 
 * 댓글 응답을 파싱하고 유동닉 댓글을 필터링합니다.
 * SPEC.md에서 확인된 판별 로직을 사용합니다.
 */

// ============================================================
// 유동닉 판별 로직
// ============================================================

/**
 * 유동닉(비로그인) 여부 판별
 * 
 * 확인된 사실 (SPEC.md §2):
 * - 고정닉(로그인): ip === "" (빈 문자열)
 * - 유동닉(비로그인): ip === "220.87" 등 IP 값 존재
 * 
 * @param {Object} comment - 댓글 객체
 * @returns {boolean}
 */
function isFluidUser(comment) {
    return comment.ip !== '';
}

/**
 * 필터링에서 제외해야 할 댓글인지 확인
 * 
 * - 댓글돌이(광고): nicktype === "COMMENT_BOY"
 * - 시스템 댓글: no === 0
 * 
 * @param {Object} comment - 댓글 객체
 * @returns {boolean} true면 스킵
 */
function shouldSkip(comment) {
    return comment.nicktype === 'COMMENT_BOY'
        || comment.no === 0
        || comment.no === '0'
        || comment.del_yn === 'Y'
        || comment.is_delete === '1'
        || comment.is_delete === 1;
}

// ============================================================
// 필터링 함수
// ============================================================

/**
 * 댓글 목록에서 삭제 대상 유동닉 댓글만 추출
 * 
 * @param {Array} comments - 댓글 배열 (API 응답)
 * @returns {Array} 삭제 대상 댓글 배열
 */
function filterFluidComments(comments) {
    return comments.filter(comment => {
        // 시스템/광고 댓글은 스킵
        if (shouldSkip(comment)) return false;

        // 유동닉만 대상
        return isFluidUser(comment);
    });
}

/**
 * 삭제 대상 댓글에서 댓글 번호만 추출
 * 
 * @param {Array} comments - 필터링된 댓글 배열
 * @returns {string[]} 댓글 번호 배열
 */
function extractCommentNos(comments) {
    return comments.map(c => String(c.no));
}

/**
 * 댓글 목록을 요약 로그용으로 변환
 * 
 * @param {Array} comments - 댓글 배열
 * @returns {string} 요약 문자열
 */
function summarizeComments(comments) {
    return comments.map(c => {
        const name = c.name || '?';
        const ip = c.ip || '';
        const memo = (c.memo || '').substring(0, 20);
        return `[${c.no}] ${name}(${ip}): ${memo}...`;
    }).join('\n');
}

// ============================================================
// Export
// ============================================================
export {
    isFluidUser,
    shouldSkip,
    filterFluidComments,
    extractCommentNos,
    summarizeComments,
};

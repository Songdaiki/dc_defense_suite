/**
 * DC Comment Protect - 파서/필터링 모듈
 * 
 * 댓글 응답을 파싱하고 유동닉 댓글을 필터링합니다.
 * SPEC.md에서 확인된 판별 로직을 사용합니다.
 */

import { COMMENT_ATTACK_MODE, normalizeCommentAttackMode } from './attack-mode.js';
import {
    buildRefluxSearchQuery,
    normalizeRefluxCompareKey,
} from '../reflux-normalization.js';

const PURE_HANGUL_COMMENT_REGEX = /^[\p{Script=Hangul}\s]+$/u;
const HTML_ENTITY_MAP = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: '\'',
    nbsp: ' ',
};

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
 * 댓글 본문을 순수 문자열 비교용으로 정규화
 *
 * @param {unknown} memo
 * @returns {string}
 */
function normalizeCommentMemo(memo) {
    const decoded = decodeHtmlEntities(String(memo ?? ''));
    return decoded
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 댓글 dataset exact-match 비교용 정규화
 *
 * @param {unknown} memo
 * @returns {string}
 */
function normalizeCommentRefluxMemo(memo) {
    return normalizeCommentRefluxCompareKey(memo);
}

/**
 * 댓글 검색용 query 정규화
 *
 * HTML/entity 제거 후 공용 역류 검색 정규화를 적용한다.
 *
 * @param {unknown} memo
 * @returns {string}
 */
function buildCommentRefluxSearchQuery(memo) {
    return buildRefluxSearchQuery(normalizeCommentMemo(memo));
}

/**
 * 댓글 검색/dataset 공용 compare key 정규화
 *
 * @param {unknown} memo
 * @returns {string}
 */
function normalizeCommentRefluxCompareKey(memo) {
    return normalizeRefluxCompareKey(normalizeCommentMemo(memo));
}

/**
 * 순수 한글 댓글 여부 확인
 *
 * @param {unknown} memo
 * @returns {boolean}
 */
function isPureHangulCommentMemo(memo) {
    const normalized = normalizeCommentMemo(memo);
    if (!normalized) {
        return false;
    }

    return PURE_HANGUL_COMMENT_REGEX.test(normalized);
}

/**
 * 실제 삭제 대상으로 사용할 댓글만 추출
 *
 * @param {Array} comments
 * @param {{ excludePureHangul?: boolean, attackMode?: string, matchesCommentRefluxMemo?: Function }} [options]
 * @returns {Array}
 */
function filterDeletionTargetComments(comments, options = {}) {
    const attackMode = normalizeCommentAttackMode(
        options.attackMode ?? (options.excludePureHangul === true ? COMMENT_ATTACK_MODE.EXCLUDE_PURE_HANGUL : COMMENT_ATTACK_MODE.DEFAULT),
    );

    if (attackMode === COMMENT_ATTACK_MODE.DEFAULT) {
        return comments;
    }

    if (attackMode === COMMENT_ATTACK_MODE.COMMENT_REFLUX) {
        const matcher = typeof options.matchesCommentRefluxMemo === 'function'
            ? options.matchesCommentRefluxMemo
            : () => false;
        return comments.filter((comment) => matcher(comment?.memo));
    }

    return comments.filter((comment) => !isPureHangulCommentMemo(comment?.memo));
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
        const memo = normalizeCommentMemo(c.memo).substring(0, 20);
        return `[${c.no}] ${name}(${ip}): ${memo}...`;
    }).join('\n');
}

function decodeHtmlEntities(value) {
    return value
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCodePointSafe(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, decimal) => fromCodePointSafe(parseInt(decimal, 10)))
        .replace(/&([a-z]+);/gi, (match, name) => HTML_ENTITY_MAP[name.toLowerCase()] ?? match);
}

function fromCodePointSafe(codePoint) {
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10FFFF) {
        return '';
    }

    try {
        return String.fromCodePoint(codePoint);
    } catch {
        return '';
    }
}

// ============================================================
// Export
// ============================================================
export {
    buildCommentRefluxSearchQuery,
    isFluidUser,
    shouldSkip,
    filterFluidComments,
    normalizeCommentMemo,
    normalizeCommentRefluxCompareKey,
    normalizeCommentRefluxMemo,
    isPureHangulCommentMemo,
    filterDeletionTargetComments,
    extractCommentNos,
    summarizeComments,
};

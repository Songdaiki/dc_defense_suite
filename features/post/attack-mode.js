import { isHanCjkSpamLikePost } from './parser.js';

const ATTACK_MODE = {
  DEFAULT: 'default',
  CJK_NARROW: 'cjk_narrow',
  SEMICONDUCTOR_REFLUX: 'semiconductor_reflux',
};

const ATTACK_MODE_SAMPLE_POST_LIMIT = 5;
const ATTACK_MODE_SAMPLE_MATCH_THRESHOLD = 3;
const INVISIBLE_CHARS_REGEX = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

function normalizeAttackMode(value) {
  if (value === ATTACK_MODE.CJK_NARROW || value === ATTACK_MODE.SEMICONDUCTOR_REFLUX) {
    return value;
  }

  return ATTACK_MODE.DEFAULT;
}

function isNarrowAttackMode(value) {
  return normalizeAttackMode(value) !== ATTACK_MODE.DEFAULT;
}

function formatAttackModeLabel(value) {
  switch (normalizeAttackMode(value)) {
    case ATTACK_MODE.CJK_NARROW:
      return 'CJK_NARROW';
    case ATTACK_MODE.SEMICONDUCTOR_REFLUX:
      return 'SEMICONDUCTOR_REFLUX';
    default:
      return 'DEFAULT';
  }
}

function getAttackModeHumanLabel(value) {
  switch (normalizeAttackMode(value)) {
    case ATTACK_MODE.CJK_NARROW:
      return '중국어/한자 공격';
    case ATTACK_MODE.SEMICONDUCTOR_REFLUX:
      return '반도체 역류 공격';
    default:
      return '일반 공격';
  }
}

function getAttackModeFilterLabel(value) {
  switch (normalizeAttackMode(value)) {
    case ATTACK_MODE.CJK_NARROW:
      return '한자/CJK 필터';
    case ATTACK_MODE.SEMICONDUCTOR_REFLUX:
      return '반도체 역류 제목 필터';
    default:
      return '전체 유동';
  }
}

function getAttackModeSubjectLabel(value) {
  switch (normalizeAttackMode(value)) {
    case ATTACK_MODE.CJK_NARROW:
      return '한자/CJK 제목';
    case ATTACK_MODE.SEMICONDUCTOR_REFLUX:
      return '반도체 역류 제목';
    default:
      return '일반 제목';
  }
}

function normalizeSemiconductorRefluxTitle(value) {
  let normalizedTitle = String(value || '');
  try {
    normalizedTitle = normalizedTitle.normalize('NFKC');
  } catch (error) {
    // normalize 미지원 환경에서도 문자열 정리만 계속 진행한다.
  }

  return normalizedTitle
    .replace(INVISIBLE_CHARS_REGEX, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAttackModeDecision(
  samplePosts,
  {
    isSemiconductorRefluxDatasetReady = false,
    matchesSemiconductorRefluxTitle = () => false,
  } = {},
) {
  const normalizedSamplePosts = dedupePostsByNo(samplePosts)
    .filter((post) => post?.isFluid)
    .sort((left, right) => (Number(right?.no) || 0) - (Number(left?.no) || 0))
    .slice(0, ATTACK_MODE_SAMPLE_POST_LIMIT);
  const sampleTitles = normalizedSamplePosts.map((post) => String(post?.subject || '').trim()).filter(Boolean);
  const hanLikeCount = normalizedSamplePosts.filter((post) => isHanCjkSpamLikePost(post)).length;
  const refluxLikeCount = isSemiconductorRefluxDatasetReady
    ? normalizedSamplePosts.filter((post) => matchesSemiconductorRefluxTitle(post?.subject)).length
    : 0;

  if (normalizedSamplePosts.length < ATTACK_MODE_SAMPLE_POST_LIMIT) {
    return {
      attackMode: ATTACK_MODE.DEFAULT,
      reason: `샘플 유동글이 ${ATTACK_MODE_SAMPLE_POST_LIMIT}개 미만이라 DEFAULT 유지`,
      sampleCount: normalizedSamplePosts.length,
      hanLikeCount,
      refluxLikeCount,
      sampleTitles,
    };
  }

  if (hanLikeCount >= ATTACK_MODE_SAMPLE_MATCH_THRESHOLD && refluxLikeCount <= 0) {
    return {
      attackMode: ATTACK_MODE.CJK_NARROW,
      reason: `새 유동글 샘플 ${normalizedSamplePosts.length}개 중 ${hanLikeCount}개가 Han/CJK 제목`,
      sampleCount: normalizedSamplePosts.length,
      hanLikeCount,
      refluxLikeCount,
      sampleTitles,
    };
  }

  if (refluxLikeCount >= ATTACK_MODE_SAMPLE_MATCH_THRESHOLD && hanLikeCount <= 0) {
    return {
      attackMode: ATTACK_MODE.SEMICONDUCTOR_REFLUX,
      reason: `새 유동글 샘플 ${normalizedSamplePosts.length}개 중 ${refluxLikeCount}개가 반도체 역류 제목`,
      sampleCount: normalizedSamplePosts.length,
      hanLikeCount,
      refluxLikeCount,
      sampleTitles,
    };
  }

  if (hanLikeCount > 0 && refluxLikeCount > 0) {
    return {
      attackMode: ATTACK_MODE.DEFAULT,
      reason: `새 유동글 샘플 ${normalizedSamplePosts.length}개에 Han/CJK 제목과 반도체 역류 제목이 섞여 있어 DEFAULT 유지`,
      sampleCount: normalizedSamplePosts.length,
      hanLikeCount,
      refluxLikeCount,
      sampleTitles,
    };
  }

  return {
    attackMode: ATTACK_MODE.DEFAULT,
    reason: `새 유동글 샘플 ${normalizedSamplePosts.length}개 중 어느 쪽도 ${ATTACK_MODE_SAMPLE_MATCH_THRESHOLD}개에 못 미쳐 DEFAULT 유지`,
    sampleCount: normalizedSamplePosts.length,
    hanLikeCount,
    refluxLikeCount,
    sampleTitles,
  };
}

function isEligibleForAttackMode(
  post,
  attackMode,
  {
    isSemiconductorRefluxDatasetReady = false,
    matchesSemiconductorRefluxTitle = () => false,
  } = {},
) {
  const normalizedAttackMode = normalizeAttackMode(attackMode);

  if (normalizedAttackMode === ATTACK_MODE.DEFAULT) {
    return true;
  }

  if (normalizedAttackMode === ATTACK_MODE.CJK_NARROW) {
    return isHanCjkSpamLikePost(post);
  }

  if (!isSemiconductorRefluxDatasetReady) {
    return false;
  }

  return matchesSemiconductorRefluxTitle(post?.subject);
}

function dedupePostsByNo(posts) {
  const postMap = new Map();

  for (const post of Array.isArray(posts) ? posts : []) {
    const postNo = String(post?.no || '').trim();
    if (!/^\d+$/.test(postNo) || postMap.has(postNo)) {
      continue;
    }
    postMap.set(postNo, post);
  }

  return [...postMap.values()];
}

export {
  ATTACK_MODE,
  ATTACK_MODE_SAMPLE_MATCH_THRESHOLD,
  ATTACK_MODE_SAMPLE_POST_LIMIT,
  buildAttackModeDecision,
  formatAttackModeLabel,
  getAttackModeFilterLabel,
  getAttackModeHumanLabel,
  getAttackModeSubjectLabel,
  isEligibleForAttackMode,
  isNarrowAttackMode,
  normalizeAttackMode,
  normalizeSemiconductorRefluxTitle,
};

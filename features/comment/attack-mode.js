const COMMENT_ATTACK_MODE = {
  DEFAULT: 'default',
  EXCLUDE_PURE_HANGUL: 'exclude_pure_hangul',
  COMMENT_REFLUX: 'comment_reflux',
};

function normalizeCommentAttackMode(value) {
  if (value === COMMENT_ATTACK_MODE.EXCLUDE_PURE_HANGUL || value === COMMENT_ATTACK_MODE.COMMENT_REFLUX) {
    return value;
  }

  return COMMENT_ATTACK_MODE.DEFAULT;
}

function getCommentAttackModeHumanLabel(value) {
  switch (normalizeCommentAttackMode(value)) {
    case COMMENT_ATTACK_MODE.EXCLUDE_PURE_HANGUL:
      return '한글제외 유동닉댓글 삭제';
    case COMMENT_ATTACK_MODE.COMMENT_REFLUX:
      return '역류기 공용 dataset 공격';
    default:
      return '일반 댓글 방어';
  }
}

export {
  COMMENT_ATTACK_MODE,
  getCommentAttackModeHumanLabel,
  normalizeCommentAttackMode,
};

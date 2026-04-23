import { normalizeCommentMemo, shouldSkip as shouldSkipComment } from '../comment/parser.js';

const COMMAND_TYPE = {
  POST_DEFENSE: 'post_defense',
  COMMENT_DEFENSE: 'comment_defense',
};

function normalizeTrustedUsers(trustedUsers = []) {
  const deduped = [];
  const seen = new Set();

  for (const user of Array.isArray(trustedUsers) ? trustedUsers : []) {
    const userId = String(user?.userId || '').trim();
    const label = String(user?.label || '').trim();
    if (!userId || seen.has(userId)) {
      continue;
    }

    seen.add(userId);
    deduped.push({
      userId,
      label: (label || userId).slice(0, 32),
    });
  }

  return deduped;
}

function parseTrustedUsersText(value) {
  const rawText = String(value || '').trim();
  if (!rawText) {
    return [];
  }

  const rows = rawText
    .split(/[\n,]+/g)
    .map((row) => String(row || '').trim())
    .filter(Boolean);

  const parsedUsers = rows.map((row) => {
    const [userIdPart, ...labelParts] = row.split(/\s+/);
    return {
      userId: String(userIdPart || '').trim(),
      label: String(labelParts.join(' ') || '').trim(),
    };
  });

  return normalizeTrustedUsers(parsedUsers);
}

function serializeTrustedUsersText(trustedUsers = []) {
  return normalizeTrustedUsers(trustedUsers)
    .map((user) => {
      if (!user.label || user.label === user.userId) {
        return user.userId;
      }
      return `${user.userId} ${user.label}`;
    })
    .join('\n');
}

function parseCommandPostTarget(value, fallbackGalleryId = '') {
  const rawValue = String(value || '').trim();
  const normalizedFallbackGalleryId = String(fallbackGalleryId || '').trim();

  if (!rawValue) {
    return {
      success: false,
      message: '명령 게시물 링크 또는 번호를 입력하세요.',
      commandPostUrl: '',
      commandGalleryId: normalizedFallbackGalleryId,
      commandPostNo: '',
    };
  }

  if (/^\d+$/.test(rawValue)) {
    if (!normalizedFallbackGalleryId) {
      return {
        success: false,
        message: '게시물 번호만 입력할 때는 공통 갤 ID가 필요합니다.',
        commandPostUrl: '',
        commandGalleryId: '',
        commandPostNo: '',
      };
    }

    return buildNormalizedCommandPostTarget(normalizedFallbackGalleryId, rawValue);
  }

  try {
    const url = new URL(rawValue);
    const commandPostNo = String(url.searchParams.get('no') || '').trim();
    const commandGalleryId = String(url.searchParams.get('id') || normalizedFallbackGalleryId).trim();

    if (!/^\d+$/.test(commandPostNo)) {
      return {
        success: false,
        message: '명령 게시물 링크에서 게시물 번호를 추출하지 못했습니다.',
        commandPostUrl: '',
        commandGalleryId,
        commandPostNo: '',
      };
    }

    if (!commandGalleryId) {
      return {
        success: false,
        message: '명령 게시물 링크에서 갤 ID를 추출하지 못했습니다.',
        commandPostUrl: '',
        commandGalleryId: '',
        commandPostNo,
      };
    }

    return buildNormalizedCommandPostTarget(commandGalleryId, commandPostNo);
  } catch {
    const noMatch = rawValue.match(/[?&]no=(\d+)/i);
    const idMatch = rawValue.match(/[?&]id=([^&#]+)/i);
    const commandPostNo = String(noMatch?.[1] || '').trim();
    const commandGalleryId = String(idMatch?.[1] || normalizedFallbackGalleryId).trim();
    if (/^\d+$/.test(commandPostNo) && commandGalleryId) {
      return buildNormalizedCommandPostTarget(commandGalleryId, commandPostNo);
    }

    return {
      success: false,
      message: '명령 게시물 링크 형식이 올바르지 않습니다.',
      commandPostUrl: '',
      commandGalleryId: '',
      commandPostNo: '',
    };
  }
}

function buildNormalizedCommandPostTarget(commandGalleryId, commandPostNo) {
  const normalizedGalleryId = String(commandGalleryId || '').trim();
  const normalizedPostNo = String(commandPostNo || '').trim();
  return {
    success: true,
    message: '',
    commandGalleryId: normalizedGalleryId,
    commandPostNo: normalizedPostNo,
    commandPostUrl: `https://gall.dcinside.com/mgallery/board/view/?id=${encodeURIComponent(normalizedGalleryId)}&no=${encodeURIComponent(normalizedPostNo)}`,
  };
}

function parseTrustedCommand(comment, commandPrefix = '@특갤봇') {
  if (shouldSkipComment(comment)) {
    return {
      success: false,
      reason: '삭제/시스템 댓글',
    };
  }

  const trustedUserId = String(comment?.user_id || '').trim();
  if (!trustedUserId) {
    return {
      success: false,
      reason: 'user_id 없음',
    };
  }

  const normalizedPrefix = String(commandPrefix || '').trim().replace(/\s+/g, ' ');
  const normalizedMemo = normalizeCommentMemo(comment?.memo).replace(/\s+/g, ' ').trim();
  if (!normalizedPrefix || !normalizedMemo.startsWith(normalizedPrefix)) {
    return {
      success: false,
      reason: '명령 prefix 없음',
    };
  }

  const body = normalizedMemo.slice(normalizedPrefix.length).trim();
  if (!body) {
    return {
      success: false,
      reason: '명령 본문 없음',
    };
  }

  const normalizedBody = body.replace(/\s+/g, '');
  if (normalizedBody === '게시물방어') {
    return {
      success: true,
      type: COMMAND_TYPE.POST_DEFENSE,
      commandText: normalizedMemo,
      commandCommentNo: String(comment?.no || '').trim(),
      commandUserId: trustedUserId,
    };
  }

  if (normalizedBody === '댓글방어') {
    return {
      success: true,
      type: COMMAND_TYPE.COMMENT_DEFENSE,
      commandText: normalizedMemo,
      commandCommentNo: String(comment?.no || '').trim(),
      commandUserId: trustedUserId,
    };
  }

  return {
    success: false,
    reason: '허용되지 않은 명령',
  };
}

function sortCommentsByNo(comments = []) {
  return [...(Array.isArray(comments) ? comments : [])].sort((left, right) => {
    const leftNo = Number(left?.no) || 0;
    const rightNo = Number(right?.no) || 0;
    return leftNo - rightNo;
  });
}

function isTrustedUserComment(comment, trustedUsers = []) {
  const trustedUserId = String(comment?.user_id || '').trim();
  if (!trustedUserId) {
    return false;
  }

  return normalizeTrustedUsers(trustedUsers).some((user) => user.userId === trustedUserId);
}

export {
  COMMAND_TYPE,
  isTrustedUserComment,
  normalizeTrustedUsers,
  parseCommandPostTarget,
  parseTrustedCommand,
  parseTrustedUsersText,
  serializeTrustedUsersText,
  sortCommentsByNo,
};

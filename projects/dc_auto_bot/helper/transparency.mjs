function renderTransparencyListPage({ records, nextCursor, total }) {
  const cards = records.length > 0
    ? records.map((record) => renderRecordCard(record)).join('')
    : '<section class="record-card empty-card"><p class="empty">아직 공개된 판정 기록이 없습니다.</p></section>';

  const nextLink = nextCursor
    ? `<a class="pager-link" href="/transparency?cursor=${encodeURIComponent(nextCursor)}">다음</a>`
    : '';

  return renderPageLayout(
    '특갤봇 공개 판정 기록',
    `
      <section class="page-header">
        <h1>특갤봇 공개 판정 기록</h1>
        <p>신고 사유와 Gemini 판정 이유를 누구나 확인할 수 있는 공개 페이지입니다.</p>
      </section>

      <section class="summary">
        <p>총 ${escapeHtml(String(total))}건</p>
      </section>

      <section class="record-list">
        ${cards}
      </section>

      <section class="pager">
        ${nextLink}
      </section>
    `,
  );
}

function renderTransparencyDetailPage(record) {
  const thumbnailSection = record.blurredThumbnailPath
    ? `
        <section class="detail-block detail-thumb-block">
          <h2>공개 썸네일</h2>
          <img class="detail-thumb" src="${escapeAttribute(record.blurredThumbnailPath)}" alt="블러 처리된 게시물 이미지">
        </section>
      `
    : '';

  return renderPageLayout(
    `${record.publicTitle || record.targetPostNo || '공개 판정 기록'}`,
    `
      <section class="page-header">
        <h1>${escapeHtml(record.publicTitle || record.targetPostNo || '공개 판정 기록')}</h1>
        <p><a href="/transparency">목록으로 돌아가기</a></p>
      </section>

      ${thumbnailSection}

      <section class="detail-grid">
        ${renderDetailItem('기록 시각', formatDateTime(record.createdAt))}
        ${renderDetailItem('게시물 번호', record.targetPostNo || '-')}
        ${renderDetailItem('신고 사유', record.reportReason || '-')}
        ${renderDetailItem('판정', getDecisionLabel(record.decision).label)}
        ${renderDetailItem('신뢰도', formatConfidence(record.confidence))}
        ${renderDetailItem('정책 ID', (record.policyIds || []).join(', ') || '-')}
        ${renderDetailItem('이미지 수', formatImageCount(record.imageCount))}
        ${renderDetailItem('게시물 링크', record.targetUrl || '-', true)}
      </section>

      <section class="detail-block">
        <h2>Gemini reason</h2>
        <p class="detail-reason">${escapeHtml(record.reason || '-')}</p>
      </section>
    `,
  );
}

function renderRecordCard(record) {
  const decision = getDecisionLabel(record.decision);
  const thumbnail = record.blurredThumbnailPath
    ? `<img class="record-thumb" src="${escapeAttribute(record.blurredThumbnailPath)}" alt="블러 처리된 게시물 이미지">`
    : '<div class="record-thumb placeholder">이미지 없음</div>';

  return `
    <article class="record-card">
      <div class="record-visual">
        ${thumbnail}
      </div>

      <div class="record-content">
        <div class="record-head">
          <p class="record-time">${escapeHtml(formatDateTime(record.createdAt))}</p>
          <span class="decision-badge decision-${escapeAttribute(decision.className)}">${escapeHtml(decision.label)}</span>
        </div>

        <h2 class="record-title">${escapeHtml(record.publicTitle || '(제목 없음)')}</h2>

        <dl class="record-meta-list">
          <div>
            <dt>신고 사유</dt>
            <dd>${escapeHtml(record.reportReason || '-')}</dd>
          </div>
          <div>
            <dt>정책 ID</dt>
            <dd>${escapeHtml((record.policyIds || []).join(', ') || '-')}</dd>
          </div>
          <div>
            <dt>신뢰도</dt>
            <dd>${escapeHtml(formatConfidence(record.confidence))}</dd>
          </div>
          <div>
            <dt>이미지</dt>
            <dd>${escapeHtml(formatImageCount(record.imageCount))}</dd>
          </div>
        </dl>

        <p class="record-reason">${escapeHtml(record.reason || '-')}</p>

        <div class="record-links">
          <a href="${escapeAttribute(record.targetUrl || '#')}" target="_blank" rel="noreferrer">원문 링크</a>
          <a href="/transparency/${encodeURIComponent(record.id)}">상세 보기</a>
        </div>
      </div>
    </article>
  `;
}

function renderPageLayout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/transparency.css">
</head>
<body>
  <main class="app">
    ${bodyHtml}
  </main>
</body>
</html>`;
}

function renderDetailItem(label, value, isLink = false) {
  if (isLink && value && value !== '-') {
    return `<div class="detail-item"><span class="detail-label">${escapeHtml(label)}</span><a class="detail-value detail-link" href="${escapeAttribute(value)}" target="_blank" rel="noreferrer">${escapeHtml(value)}</a></div>`;
  }

  return `<div class="detail-item"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(value || '-')}</span></div>`;
}

function getDecisionLabel(decision) {
  const normalizedDecision = String(decision || '').trim().toLowerCase();
  if (normalizedDecision === 'allow') {
    return { label: '삭제 승인', className: 'allow' };
  }
  if (normalizedDecision === 'deny') {
    return { label: '삭제 반려', className: 'deny' };
  }
  if (normalizedDecision === 'review') {
    return { label: '검토 필요', className: 'review' };
  }
  return { label: '판정 없음', className: 'unknown' };
}

function formatDateTime(value) {
  if (!value) {
    return '-';
  }

  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function formatConfidence(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(2) : '-';
}

function formatImageCount(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return '없음';
  }

  return `${Math.floor(numericValue)}장`;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

export {
  renderTransparencyDetailPage,
  renderTransparencyListPage,
};

const TRANSPARENCY_AUTO_REFRESH_MS = 10000;

function renderTransparencyListPage({ records, nextCursor, total, healthStatus, currentFilter = '' }) {
  const stats = countDecisions(records);

  const tableRows = records.length > 0
    ? records.map((record) => renderTableRow(record)).join('')
    : '';

  const emptyBlock = records.length === 0
    ? '<div class="empty-state">아직 공개된 판정 기록이 없습니다.</div>'
    : '';

  const nextLink = nextCursor
    ? `<a class="pager-link" href="${escapeAttribute(buildListHref(nextCursor, currentFilter))}">다음 ▶</a>`
    : '';

  const tableBlock = records.length > 0
    ? `
      <div class="record-list">
        <table class="board-table">
          <thead>
            <tr>
              <th class="col-no">번호</th>
              <th class="col-title">제목</th>
              <th class="col-decision">판정</th>
              <th class="col-policy">정책</th>
              <th class="col-reason">신고 사유</th>
              <th class="col-date">날짜</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    `
    : '';

  return renderPageLayout(
    '특갤봇 운영 내역',
    `
      <div class="main-content">
        ${renderGalleryHeader()}

        <div class="stats-bar">
          <span class="stats-total">총 <strong>${escapeHtml(String(total))}</strong>건</span>
          <div class="stats-counts">
            <span class="stat-item"><span class="stat-dot stat-dot-allow"></span> 삭제 승인 ${stats.allow}</span>
            <span class="stat-item"><span class="stat-dot stat-dot-deny"></span> 삭제 반려 ${stats.deny}</span>
            <span class="stat-item"><span class="stat-dot stat-dot-review"></span> 검토 필요 ${stats.review}</span>
          </div>
        </div>

        ${renderFilterTabs(currentFilter)}

        ${tableBlock}
        ${emptyBlock}

        <div class="pager">
          ${nextLink}
        </div>
      </div>

      ${renderSidebar(total, stats)}
      <script>
        setTimeout(() => {
          window.location.reload();
        }, ${TRANSPARENCY_AUTO_REFRESH_MS});
      </script>
    `,
    healthStatus,
  );
}

function renderTransparencyDetailPage(record, healthStatus, options = {}) {
  const showDebugReason = Boolean(options?.showDebugReason);
  const decision = getDecisionLabel(record.decision, record.status, record);
  const displayTitle = getDisplayTitle(record);
  const autoRefreshScript = record.status === 'pending'
    ? `
      <script>
        setTimeout(() => {
          window.location.reload();
        }, ${TRANSPARENCY_AUTO_REFRESH_MS});
      </script>
    `
    : '';

  const thumbnailSection = record.blurredThumbnailPath
    ? `
        <div class="detail-thumb-area">
          <h3>공개 썸네일 (블러 처리됨)</h3>
          <img class="detail-thumb" src="${escapeAttribute(record.blurredThumbnailPath)}" alt="블러 처리된 게시물 이미지">
        </div>
      `
    : '';
  const formattedReason = formatReason(record);
  const debugReasonSection = buildDebugReasonSection(record, formattedReason, showDebugReason);

  return renderPageLayout(
    `${displayTitle || record.targetPostNo || '운영 내역'}`,
    `
      <div class="main-content">
        <a class="back-link" href="/transparency">목록으로 돌아가기</a>

        <div class="detail-view">
          <div class="detail-header">
            <div class="detail-header-top">
              <span class="badge badge-${escapeAttribute(decision.className)}">${escapeHtml(decision.label)}</span>
            </div>
            <h1 class="detail-title">${escapeHtml(displayTitle)}</h1>
            <div class="detail-meta">
              <span><span class="detail-meta-label">기록 시각</span> ${escapeHtml(formatDateTime(record.createdAt))}</span>
              <span><span class="detail-meta-label">게시물 번호</span> ${escapeHtml(record.targetPostNo || '-')}</span>
              <span><span class="detail-meta-label">이미지</span> ${escapeHtml(formatImageCount(record.imageCount))}</span>
            </div>
          </div>

          <div class="detail-body">
            ${thumbnailSection}

            <div class="post-content">
              <p class="post-body">${escapeHtml(record.publicBody || '(본문 없음)')}</p>
            </div>

            <table class="info-table">
              <tbody>
                <tr>
                  <th>신고 사유</th>
                  <td>${escapeHtml(record.reportReason || '-')}</td>
                </tr>
                <tr>
                  <th>Gemini 판정</th>
                  <td><span class="badge badge-${escapeAttribute(decision.className)}">${escapeHtml(decision.label)}</span></td>
                </tr>
                <tr>
                  <th>신뢰도</th>
                  <td>${escapeHtml(formatConfidence(record.confidence, record.status))}</td>
                </tr>
                <tr>
                  <th>정책 ID</th>
                  <td>${escapeHtml(formatPolicyIds(record.policyIds, record.status))}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="reason-box">
            <h3><img class="gemini-icon" src="/gemini-icon.webp" alt="Gemini" width="14" height="14"> Gemini 판단 이유</h3>
            <p class="reason-text">${escapeHtml(formattedReason)}</p>
            ${debugReasonSection}
          </div>

          <div class="detail-footer">
            <a href="/transparency">◀ 목록으로</a>
          </div>
        </div>
      </div>

      <div class="sidebar"></div>
      ${autoRefreshScript}
    `,
    healthStatus,
  );
}

function renderGalleryHeader() {
  return `
    <div class="gallery-header">
      <div class="gallery-icon"><img src="/bot-icon.png" alt="특갤봇" width="80" height="80"></div>
      <div class="gallery-info">
        <div class="gallery-title">특갤봇 운영 내역</div>
        <div class="gallery-desc">신고 사유와 Gemini 판정 이유를 누구나 확인할 수 있는 공개 페이지</div>
        <div class="gallery-manager">운영 봇: <strong>특갤봇</strong> · AI 판사: <strong>Gemini</strong></div>
      </div>
    </div>
  `;
}

function renderFilterTabs(currentFilter) {
  const tabs = [
    { label: '전체', value: '', href: '/transparency' },
    { label: '삭제 승인', value: 'allow', href: '/transparency?decision=allow' },
    { label: '삭제 반려', value: 'deny', href: '/transparency?decision=deny' },
    { label: '검토 필요', value: 'review', href: '/transparency?decision=review' },
  ];

  const tabHtml = tabs.map((tab) => {
    const active = tab.value === currentFilter ? ' active' : '';
    return `<a class="filter-tab${active}" href="${escapeAttribute(tab.href)}">${escapeHtml(tab.label)}</a>`;
  }).join('');

  return `<div class="filter-tabs">${tabHtml}</div>`;
}

function buildListHref(cursor, currentFilter) {
  const params = new URLSearchParams();
  if (currentFilter) {
    params.set('decision', currentFilter);
  }
  if (cursor) {
    params.set('cursor', String(cursor));
  }
  const query = params.toString();
  return query ? `/transparency?${query}` : '/transparency';
}

function renderSidebar(total, stats) {
  return `
    <div class="sidebar">
      <div class="sidebar-box">
        <div class="sidebar-box-title">봇 정보</div>
        <div class="sidebar-box-body">
          <div class="sidebar-info-row">
            <span class="sidebar-info-label">봇 이름</span>
            <span class="sidebar-info-value">특갤봇</span>
          </div>
          <div class="sidebar-info-row">
            <span class="sidebar-info-label">AI 판사</span>
            <span class="sidebar-info-value">Gemini</span>
          </div>
          <div class="sidebar-info-row">
            <span class="sidebar-info-label">총 처리</span>
            <span class="sidebar-info-value">${total}건</span>
          </div>
          <div class="sidebar-info-row">
            <span class="sidebar-info-label">삭제 승인</span>
            <span class="sidebar-info-value">${stats.allow}건</span>
          </div>
          <div class="sidebar-info-row">
            <span class="sidebar-info-label">삭제 반려</span>
            <span class="sidebar-info-value">${stats.deny}건</span>
          </div>
          <div class="sidebar-info-row">
            <span class="sidebar-info-label">검토 필요</span>
            <span class="sidebar-info-value">${stats.review}건</span>
          </div>
        </div>
      </div>

      <div class="sidebar-box">
        <div class="sidebar-box-title">운영 정책 요약</div>
        <div class="sidebar-box-body">
          <div class="sidebar-policy-list">
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P1</span>이용약관·법률 위반</summary>
              <div class="policy-detail">디시인사이드 이용 약관, 법률, 건전한 사회 통념을 위반하는 내용<br><span class="policy-penalty">글 삭제, 30일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P2</span>닉언·친목·사칭</summary>
              <div class="policy-detail">닉네임 언급, 친목질, 사칭 행위<br><span class="policy-penalty">글 삭제, 30일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P3</span>분탕·어그로</summary>
              <div class="policy-detail">분탕 및 어그로 (꼬투리 잡기 등 고로시 포함)<br><span class="policy-penalty">글 삭제, 30일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P4</span>종교·음모론</summary>
              <div class="policy-detail">모든 종류의 종교, 음모론 관련 글 (자연의 섭리 포함)<br>명확한 레퍼런스 없이 특정 사건/현상을 특정 인물/단체가 의도적으로 야기했다고 주장 또는 의혹 제기<br><span class="policy-penalty">글 삭제, 30일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P5</span>반과학·직업비하</summary>
              <div class="policy-detail">반과학, 유사과학, 반지성주의, 직업 비하/조롱<br>예: 전자레인지는 발암물질을 생성한다, 특정 직업은 소멸할 일만 남았다 등<br><span class="policy-penalty">글 삭제, 30일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P6</span>레퍼런스 미첨부</summary>
              <div class="policy-detail">1개 이상의 레퍼런스를 첨부하지 않은 선형글<br>선형글: 특이점주의에 반하는 주장 (기술적 특이점은 2045년 이후에 발생한다, AGI는 불가능하다 등)<br><span class="policy-penalty">글 삭제, 30일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P7</span>주제무관·설교</summary>
              <div class="policy-detail">주제 무관, 본 갤러리 또는 이용자에 대한 일침/설교성 글<br><span class="policy-penalty">글 삭제, 30일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P8</span>무인증 전문가</summary>
              <div class="policy-detail">구체적 인증 없이 현직자/전공자를 주장하며 작성한 글, 과도한 특정 인물 팬보이 글, 의도적 갈드컵 유발 글<br>공격 또는 비하 의도가 없는 단순 모델/기업 비교는 해당 없음<br><span class="policy-penalty">글 삭제, 7~30일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P9</span>주식·코인·투자</summary>
              <div class="policy-detail">주식, 코인, 투자 관련 글<br><span class="policy-penalty">글 삭제, 7일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P10</span>과도한 국뽕·혐한</summary>
              <div class="policy-detail">과도한 국뽕, 일뽕, 중뽕, 출산율, 혐한/국까 떡밥<br>예: 조센징은 일본한테 안된다, 미개한 한국은 특이점 못 온다 등<br><span class="policy-penalty">글 삭제, 7일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P11</span>정치·성별혐오</summary>
              <div class="policy-detail">모든 종류의 국내 정치인/정당/정책/공약/정치사상적 주장, 지역드립, 성별 혐오<br>시행 확정된 국가 정책의 사실 전달은 허용 (의견 불가)<br><span class="policy-penalty">글 삭제, 7일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P12</span>타 갤러리 언급</summary>
              <div class="policy-detail">타 갤러리, 타 커뮤니티 언급<br><span class="policy-penalty">글 삭제, 1일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P13</span>시비성 욕설</summary>
              <div class="policy-detail">맥락 없는 시비성 욕설, 상호 간 욕설이 포함된 싸움<br><span class="policy-penalty">글 삭제, 1일 차단</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P14</span>금지 떡밥</summary>
              <div class="policy-detail">신세한탄/우울글, 망상글, 체감글/저격글, 낚시글/허위사실, 기본소득, 주제 무관 글, 나눔 없는 자랑 글, 개인 간 분쟁 등<br><span class="policy-penalty">글 삭제</span></div>
            </details>
            <details class="policy-accordion">
              <summary><span class="sidebar-policy-id">P15</span>개념글 제한</summary>
              <div class="policy-detail">신분 미확인 인물의 AGI/특이점 시기 떡밥, 갈드컵/혐오 요소 포함 유머글, 분탕/일침성 게시글<br><span class="policy-penalty">개념글 제한</span></div>
            </details>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderTableRow(record) {
  const decision = getDecisionLabel(record.decision, record.status, record);
  const postNo = record.targetPostNo || '-';
  const title = getDisplayTitle(record);
  const detailHref = `/transparency/${encodeURIComponent(record.id)}`;
  const policyText = formatPolicyIds(record.policyIds);

  return `
    <tr>
      <td class="cell-no">${escapeHtml(postNo)}</td>
      <td class="cell-title"><a href="${escapeAttribute(detailHref)}">${escapeHtml(title)}</a></td>
      <td class="cell-decision"><span class="badge badge-${escapeAttribute(decision.className)}">${escapeHtml(decision.label)}</span></td>
      <td class="cell-policy">${escapeHtml(policyText)}</td>
      <td class="cell-reason">${escapeHtml(truncateText(record.reportReason || '-', 12))}</td>
      <td class="cell-date">${escapeHtml(formatShortDate(record.createdAt))}</td>
    </tr>
  `;
}

function renderPageLayout(title, bodyHtml, healthStatus = { isHealthy: false, label: '서버 상태', emoji: '🔴' }) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/transparency.css">
</head>
<body>
  <nav class="top-nav">
    <div class="top-nav-inner">
      <span class="top-nav-logo">특이점이 온다 <span>운영 내역</span></span>
      <div class="top-nav-links">
        <a href="/transparency">운영 내역</a>
        <span class="server-status ${healthStatus.isHealthy ? 'healthy' : 'unhealthy'}">${escapeHtml(healthStatus.label)} ${escapeHtml(healthStatus.emoji)}</span>
      </div>
    </div>
  </nav>

  <main class="app">
    ${bodyHtml}
  </main>

  <footer class="site-footer">
    특갤봇 · Gemini 기반 자동 운영 시스템 · 판정 기록 공개 페이지
  </footer>
</body>
</html>`;
}

function renderNotFoundPage(message, healthStatus) {
  return renderPageLayout('페이지를 찾을 수 없습니다', `
    <div class="main-content">
      <div class="gallery-header">
        <div class="gallery-icon">❌</div>
        <div class="gallery-info">
          <div class="gallery-title">페이지를 찾을 수 없습니다</div>
          <div class="gallery-desc">${escapeHtml(message || '요청한 페이지를 찾지 못했습니다.')}</div>
        </div>
      </div>
      <div style="background:#fff;border:1px solid #ccc;padding:40px 20px;text-align:center;">
        <a href="/transparency">◀ 목록으로 돌아가기</a>
      </div>
    </div>
    <div class="sidebar"></div>
  `, healthStatus);
}

function countDecisions(records) {
  let allow = 0;
  let deny = 0;
  let review = 0;

  for (const record of records) {
    const status = String(record.status || '').toLowerCase();
    if (status === 'pending') {
      review += 1;
      continue;
    }
    if (status === 'failed') {
      continue;
    }
    const d = String(record.decision || '').toLowerCase();
    if (d === 'allow') allow += 1;
    else if (d === 'deny') deny += 1;
    else if (d === 'review') review += 1;
  }

  return { allow, deny, review };
}

function getDecisionLabel(decision, status = 'completed', record = null) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus === 'pending') {
    return { label: '검토중', className: 'pending' };
  }
  if (normalizedStatus === 'failed') {
    if (record && isLikelyAlreadyProcessedPost(record)) {
      return { label: '처리 완료', className: 'done' };
    }
    if (record && isAuthorFilterFailed(record)) {
      return { label: '처리 불가', className: 'filtered' };
    }
    return { label: '처리 실패', className: 'unknown' };
  }

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
    const d = new Date(value);
    const opts = { timeZone: 'Asia/Seoul' };
    const y = d.toLocaleString('en-US', { ...opts, year: 'numeric' });
    const m = d.toLocaleString('en-US', { ...opts, month: '2-digit' });
    const day = d.toLocaleString('en-US', { ...opts, day: '2-digit' });
    const h = d.toLocaleString('en-US', { ...opts, hour: '2-digit', hour12: false });
    const min = d.toLocaleString('en-US', { ...opts, minute: '2-digit' });
    const s = d.toLocaleString('en-US', { ...opts, second: '2-digit' });
    return `${y}.${m}.${day} ${h.padStart(2, '0')}:${min.padStart(2, '0')}:${s.padStart(2, '0')}`;
  } catch {
    return String(value);
  }
}

function formatShortDate(value) {
  if (!value) {
    return '-';
  }

  try {
    const d = new Date(value);
    const opts = { timeZone: 'Asia/Seoul' };
    const m = d.toLocaleString('en-US', { ...opts, month: '2-digit' });
    const day = d.toLocaleString('en-US', { ...opts, day: '2-digit' });
    const h = d.toLocaleString('en-US', { ...opts, hour: '2-digit', hour12: false });
    const min = d.toLocaleString('en-US', { ...opts, minute: '2-digit' });
    return `${m}.${day} ${h.padStart(2, '0')}:${min.padStart(2, '0')}`;
  } catch {
    return String(value);
  }
}

function formatConfidence(value, status = 'completed') {
  if (String(status || '').toLowerCase() === 'pending') {
    return '검토중';
  }
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

function formatPolicyIds(values, status = 'completed') {
  if (String(status || '').toLowerCase() === 'pending') {
    return '검토중';
  }
  const policyIds = Array.isArray(values) ? values.map((value) => String(value || '').trim()).filter(Boolean) : [];
  if (policyIds.length === 0) {
    return '-';
  }

  return policyIds
    .map((policyId) => (policyId.toUpperCase() === 'NONE' ? '위반 없음' : policyId))
    .join(', ');
}

function getDisplayTitle(record) {
  const rawTitle = String(record?.publicTitle || '').trim();
  if (rawTitle && rawTitle !== '(제목 없음)') {
    return rawTitle;
  }

  if (isLikelyAlreadyProcessedPost(record)) {
    return '(이미 처리된 게시물입니다.)';
  }

  return rawTitle || '(제목 없음)';
}

function isLikelyAlreadyProcessedPost(record) {
  const status = String(record?.status || '').trim().toLowerCase();
  if (status !== 'failed') {
    return false;
  }

  const rawBody = String(record?.publicBody || '').trim();
  if (rawBody) {
    return false;
  }

  const rawReason = String(record?.reason || '').trim();
  return rawReason.startsWith('작성자 판정 실패:')
    && (
      rawReason.includes('본문 작성자 메타를 찾지 못했습니다.')
      || rawReason.includes('작성자 uid/ip를 모두 확인하지 못했습니다.')
    );
}

/**
 * 작성자 필터 미통과로 자동 처리를 건너뛴 케이스인지 확인
 * (일반 활동 계정으로 분류된 경우)
 */
function isAuthorFilterFailed(record) {
  const rawReason = String(record?.reason || '').trim();
  return rawReason.startsWith('v2 core 작성자 필터 미통과:');
}

function formatReason(record) {
  const status = String(record?.status || '').toLowerCase();
  if (status === 'pending') {
    return '검토중';
  }

  const rawReason = String(record?.reason || '').trim();
  if (status !== 'failed') {
    return rawReason || '-';
  }

  return mapFailedReasonToPublicMessage(rawReason);
}

function mapFailedReasonToPublicMessage(reason) {
  const rawReason = String(reason || '').trim();
  if (!rawReason) {
    return '자동 처리 중 내부 오류가 발생했습니다.';
  }

  if (rawReason.startsWith('작성자 판정 실패:')) {
    if (rawReason.includes('활동 통계 조회 실패:')) {
      return '작성자 활동 정보를 불러오지 못해 자동 처리를 중단했습니다.';
    }
    return '작성자 정보를 확인하지 못해 자동 처리를 중단했습니다.';
  }

  if (rawReason.startsWith('v2 core 작성자 필터 미통과:')) {
    return '일반 활동 계정으로 분류되어 자동 처리하지 않았습니다.';
  }

  if (rawReason.startsWith('개념글 판정 실패:')) {
    return '게시물 상태를 확인하지 못해 자동 처리를 중단했습니다.';
  }

  if (rawReason === '개념글은 자동 삭제/차단하지 않습니다.') {
    return '개념글은 자동 처리 대상이 아니어서 검토만 기록했습니다.';
  }

  if (rawReason.startsWith('최근 100개 판정 실패:')) {
    return '최근 게시물 범위를 확인하지 못해 자동 처리를 중단했습니다.';
  }

  if (rawReason === '최근 100개 regular row 밖 게시물입니다.') {
    return '최근 게시물 범위를 벗어나 자동 처리 대상에서 제외되었습니다.';
  }

  if (
    rawReason === 'CLI helper endpoint 형식이 올바르지 않습니다.'
    || rawReason === 'CLI helper endpoint는 http://localhost 또는 http://127.0.0.1 주소만 허용됩니다.'
    || rawReason === 'CLI helper endpoint는 localhost 계열 주소만 허용됩니다.'
    || rawReason.startsWith('CLI helper 연결 실패:')
  ) {
    return 'AI 판정 서버에 연결하지 못해 자동 처리를 중단했습니다.';
  }

  if (rawReason === 'CLI helper 응답 대기 시간이 초과되었습니다.') {
    return 'AI 판정 응답 시간이 초과되어 자동 처리를 중단했습니다.';
  }

  if (rawReason === 'CLI helper 응답 JSON 파싱 실패') {
    return 'AI 판정 결과를 해석하지 못해 자동 처리를 중단했습니다.';
  }

  if (
    rawReason === 'decision 값이 올바르지 않습니다.'
    || rawReason === 'confidence 값이 올바르지 않습니다.'
    || rawReason === 'policy_ids가 비어 있습니다.'
    || rawReason === 'policy_ids에 허용되지 않은 값이 포함되어 있습니다.'
    || rawReason === 'reason 값이 비어 있습니다.'
    || rawReason === 'policy_ids에 NONE과 다른 정책이 동시에 포함될 수 없습니다.'
    || rawReason === 'policy_ids가 ["NONE"]이면 decision은 deny여야 합니다.'
    || rawReason === 'P15 단독 allow는 자동 삭제/차단 대상으로 처리할 수 없습니다.'
    || rawReason === 'allow 결정에는 최소 1개 이상의 정책 ID가 필요합니다.'
  ) {
    return 'AI 판정 결과가 올바르지 않아 자동 처리를 중단했습니다.';
  }

  if (rawReason === 'CLI helper 판정 실패') {
    return 'AI 판정 결과를 해석하지 못해 자동 처리를 중단했습니다.';
  }

  if (rawReason.includes('후 처리 실패: 로그인 세션 실패:')) {
    return '로그인 상태를 확인하지 못해 자동 처리를 중단했습니다.';
  }

  if (rawReason.includes('후 처리 실패: 관리 권한이 없습니다.')) {
    return '관리자 권한을 확인하지 못해 자동 처리를 중단했습니다.';
  }

  if (rawReason.includes('후 처리 실패:')) {
    return '자동 삭제 시도 중 오류가 발생해 처리를 중단했습니다.';
  }

  return '자동 처리 중 내부 오류가 발생했습니다.';
}

function buildDebugReasonSection(record, formattedReason, showDebugReason) {
  if (!showDebugReason) {
    return '';
  }

  const rawReason = String(record?.reason || '').trim();
  if (!rawReason) {
    return '';
  }

  const normalizedFormattedReason = String(formattedReason || '').trim();
  if (rawReason === normalizedFormattedReason) {
    return '';
  }

  return `
    <details class="debug-reason-box">
      <summary>원문 사유 보기</summary>
      <pre class="debug-reason-text">${escapeHtml(rawReason)}</pre>
    </details>
  `;
}

function truncateText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
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
  renderNotFoundPage,
  renderTransparencyDetailPage,
  renderTransparencyListPage,
};

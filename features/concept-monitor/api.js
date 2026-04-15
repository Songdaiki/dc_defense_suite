import { withDcRequestLease } from '../../background/dc-session-broker.js';

const DEFAULT_CONFIG = {
  galleryId: 'thesingularity',
  galleryType: 'M',
  baseUrl: 'https://gall.dcinside.com',
};

const KCAPTCHA_REQUIRED_FIELD_NAMES = [
  'use_ips',
  'write_cnt',
  'comment_cnt',
  'recom_cnt',
  'use_write',
  'use_comment',
  'use_recom',
  'use_recom_r',
  'use_recom_n',
];

const KCAPTCHA_TOGGLE_FIELD_NAMES = new Set([
  'use_ips',
  'use_write',
  'use_comment',
  'use_recom',
  'use_recom_r',
  'use_recom_n',
]);

const KCAPTCHA_SECTION_WINDOW_CHARS = 12000;

function resolveConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
  };
}

async function dcFetch(url, options = {}) {
  return fetch(url, {
    credentials: 'include',
    headers: options.headers || {},
    ...options,
  });
}

async function dcFetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const response = await dcFetch(url, options);

      if (response.status === 429) {
        if (attempt === maxRetries - 1) {
          return response;
        }
        await delay((attempt + 1) * 2000);
        continue;
      }

      if (response.status === 403) {
        if (attempt === maxRetries - 1) {
          return response;
        }
        await delay(30000);
        continue;
      }

      return response;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }

      if (attempt === maxRetries - 1) {
        throw error;
      }

      await delay(1000);
    }
  }

  throw new Error('[ConceptMonitor API] 최대 재시도 횟수 초과');
}

async function fetchConceptListHTML(config = {}) {
  return fetchConceptListPageHTML(config, 1, 'conceptMonitor');
}

async function fetchConceptListPageHTML(config = {}, page = 1, leaseFeature = 'conceptPatrol') {
  return withDcRequestLease({ feature: leaseFeature, kind: 'fetchConceptListHTML' }, async () => {
    const resolved = resolveConfig(config);
    const normalizedPage = Math.max(1, Number(page) || 1);
    const url = new URL('/mgallery/board/lists/', resolved.baseUrl);
    url.searchParams.set('id', resolved.galleryId);
    url.searchParams.set('exception_mode', 'recommend');
    url.searchParams.set('page', String(normalizedPage));

    const response = await dcFetchWithRetry(url.toString());
    const html = await response.text();
    assertValidHtmlResponse(response, html, {
      label: `개념글 목록 페이지 ${normalizedPage}`,
      shapeCheck: looksLikeConceptListHtml,
    });

    return html;
  });
}

async function fetchBoardListHTML(config = {}) {
  return withDcRequestLease({ feature: 'conceptMonitor', kind: 'fetchBoardListHTML' }, async () => {
    const resolved = resolveConfig(config);
    const url = new URL('/mgallery/board/lists/', resolved.baseUrl);
    url.searchParams.set('id', resolved.galleryId);

    const response = await dcFetchWithRetry(url.toString());
    const html = await response.text();
    assertValidHtmlResponse(response, html, {
      label: '전체글 목록 페이지',
      shapeCheck: looksLikeBoardListHtml,
    });

    return html;
  });
}

async function fetchConceptPostViewHTML(config = {}, postNo, leaseFeature = 'conceptMonitor') {
  return withDcRequestLease({ feature: leaseFeature, kind: 'fetchConceptPostViewHTML' }, async () => {
    const resolved = resolveConfig(config);
    const url = buildPostViewUrl(resolved, postNo);
    const response = await dcFetchWithRetry(url);
    const html = await response.text();
    assertValidHtmlResponse(response, html, {
      label: '게시물 페이지',
      shapeCheck: looksLikeBoardViewHtml,
    });

    return html;
  });
}

async function releaseConceptPost(config = {}, postNo, leaseFeature = 'conceptMonitor') {
  return withDcRequestLease({ feature: leaseFeature, kind: 'releaseConceptPost' }, async () => {
    const resolved = resolveConfig(config);
    const ciToken = await getCiToken(resolved.baseUrl);

    if (!ciToken) {
      return {
        success: false,
        status: 0,
        rawText: '',
        rawSummary: 'ci_t 토큰(ci_c 쿠키)을 찾지 못했습니다.',
      };
    }

    const body = new URLSearchParams();
    body.set('ci_t', ciToken);
    body.set('id', resolved.galleryId);
    body.append('nos[]', String(postNo));
    body.set('_GALLTYPE_', resolved.galleryType);
    body.set('mode', 'REL');

    const response = await dcFetchWithRetry(
      `${resolved.baseUrl}/ajax/minor_manager_board_ajax/set_recommend`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': resolved.baseUrl,
          'Referer': buildPostViewUrl(resolved, postNo),
        },
        body: body.toString(),
      },
      1,
    );

    const rawText = await response.text();

    return {
      success: response.status === 200,
      status: response.status,
      rawText,
      rawSummary: summarizeResponseText(rawText),
    };
  });
}

async function updateRecommendCut(config = {}, recommendCount, leaseFeature = 'conceptRecommendCut') {
  return withDcRequestLease({ feature: leaseFeature, kind: 'updateRecommendCut' }, async () => {
    const resolved = resolveConfig(config);
    const ciToken = await getCiToken(resolved.baseUrl);

    if (!ciToken) {
      return {
        success: false,
        status: 0,
        result: '',
        rawText: '',
        rawSummary: 'ci_t 토큰(ci_c 쿠키)을 찾지 못했습니다.',
      };
    }

    const body = new URLSearchParams();
    body.set('ci_t', ciToken);
    body.set('gallery_id', resolved.galleryId);
    body.set('_GALLTYPE_', resolved.galleryType);
    body.set('decom_use', '0');
    body.set('recom_down_use', '0');
    body.set('recom_count', String(recommendCount));
    body.set('decom_count', '0');

    const response = await dcFetchWithRetry(
      `${resolved.baseUrl}/ajax/managements_ajax/update_recom_decom`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': resolved.baseUrl,
          'Referer': `${resolved.baseUrl}/mgallery/management/gallery?id=${encodeURIComponent(resolved.galleryId)}`,
        },
        body: body.toString(),
      },
      1,
    );

    const rawText = await response.text();
    const parsed = parseJsonResponse(rawText);
    const result = String(parsed?.result || '').trim();

    return {
      success: response.status === 200 && result === 'success',
      status: response.status,
      result,
      rawText,
      rawSummary: summarizeResponseText(rawText),
    };
  });
}

async function syncKcaptchaRecomCnt(config = {}, desiredRecomCnt, leaseFeature = 'conceptRecommendCut') {
  return withDcRequestLease({ feature: leaseFeature, kind: 'syncKcaptchaRecomCnt' }, async () => {
    const normalizedDesiredRecomCnt = normalizeKcaptchaCountValue(desiredRecomCnt, 'recom_cnt');
    const html = await fetchManagementGalleryHTML(config);
    const currentSettings = parseKcaptchaSettings(html);
    assertCompleteKcaptchaSettings(currentSettings);

    if (currentSettings.recom_cnt === normalizedDesiredRecomCnt) {
      return {
        success: true,
        skipped: true,
        status: 200,
        result: 'success',
        rawText: '',
        rawSummary: '이미 원하는 recom_cnt가 적용되어 있습니다.',
        currentSettings,
        appliedSettings: currentSettings,
      };
    }

    const nextSettings = {
      ...currentSettings,
      recom_cnt: normalizedDesiredRecomCnt,
    };

    const updateResult = await updateKcaptchaSettings(config, nextSettings);
    return {
      ...updateResult,
      skipped: false,
      currentSettings,
      appliedSettings: nextSettings,
    };
  });
}

async function getCiToken(baseUrl = DEFAULT_CONFIG.baseUrl) {
  try {
    const cookie = await chrome.cookies.get({
      url: baseUrl,
      name: 'ci_c',
    });
    return cookie ? cookie.value : null;
  } catch (error) {
    console.error('[ConceptMonitor API] ci_c 쿠키 조회 실패:', error.message);
    return null;
  }
}

function buildPostViewUrl(config, postNo) {
  const url = new URL('/mgallery/board/view/', config.baseUrl);
  url.searchParams.set('id', config.galleryId);
  url.searchParams.set('no', String(postNo));
  return url.toString();
}

function assertValidHtmlResponse(response, html, { label, shapeCheck }) {
  const htmlText = String(html || '');

  if (htmlText.includes('정상적인 접근이 아닙니다')) {
    throw new Error(`${label} 접근 차단 응답을 받았습니다`);
  }

  if (!htmlText.trim()) {
    throw new Error(`${label} 빈 응답을 받았습니다`);
  }

  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status} / raw: ${summarizeResponseText(htmlText)}`);
  }

  if (!looksLikeHtmlDocument(htmlText)) {
    throw new Error(`${label} 비정상 HTML 응답 / raw: ${summarizeResponseText(htmlText)}`);
  }

  if (typeof shapeCheck === 'function' && !shapeCheck(htmlText)) {
    throw new Error(`${label} 형태 검증 실패 / raw: ${summarizeResponseText(htmlText)}`);
  }
}

function looksLikeHtmlDocument(htmlText) {
  return /<html[\s>]/i.test(htmlText) && /<\/html>/i.test(htmlText);
}

function looksLikeConceptListHtml(htmlText) {
  const normalized = String(htmlText || '');
  return hasAnyMarker(normalized, [
    '/mgallery/board/lists/?id=',
    'class="gall_recommend"',
    'class="ub-content',
    'class="gall_listwrap',
  ]);
}

function looksLikeBoardListHtml(htmlText) {
  const normalized = String(htmlText || '');
  return hasAnyMarker(normalized, [
    '/mgallery/board/lists/?id=',
    'class="gall_recommend"',
    'class="ub-content',
    'class="gall_listwrap',
  ]);
}

function looksLikeBoardViewHtml(htmlText) {
  const normalized = String(htmlText || '');
  return hasAnyMarker(normalized, [
    '/mgallery/board/view/?id=',
    'class="btn_recommend_box',
    'id="recommend"',
    'class="view_content_wrap',
    'class="write_div',
  ]);
}

async function fetchManagementGalleryHTML(config = {}) {
  const resolved = resolveConfig(config);
  const url = new URL('/mgallery/management/gallery', resolved.baseUrl);
  url.searchParams.set('id', resolved.galleryId);

  const response = await dcFetchWithRetry(url.toString());
  const html = await response.text();
  assertValidHtmlResponse(response, html, {
    label: '관리 페이지',
    shapeCheck: looksLikeManagementGalleryHtml,
  });

  return html;
}

async function updateKcaptchaSettings(config = {}, settings = {}) {
  const resolved = resolveConfig(config);
  const ciToken = await getCiToken(resolved.baseUrl);
  if (!ciToken) {
    return {
      success: false,
      status: 0,
      result: '',
      rawText: '',
      rawSummary: 'ci_t 토큰(ci_c 쿠키)을 찾지 못했습니다.',
    };
  }

  const normalizedSettings = assertCompleteKcaptchaSettings(settings);
  const body = new URLSearchParams();
  body.set('ci_t', ciToken);
  body.set('gallery_id', resolved.galleryId);
  body.set('_GALLTYPE_', resolved.galleryType);
  body.set('use_ips', normalizedSettings.use_ips);
  body.set('write_cnt', normalizedSettings.write_cnt);
  body.set('comment_cnt', normalizedSettings.comment_cnt);
  body.set('recom_cnt', normalizedSettings.recom_cnt);
  body.set('use_write', normalizedSettings.use_write);
  body.set('use_comment', normalizedSettings.use_comment);
  body.set('use_recom', normalizedSettings.use_recom);
  body.set('use_recom_r', normalizedSettings.use_recom_r);
  body.set('use_recom_n', normalizedSettings.use_recom_n);

  const response = await dcFetchWithRetry(
    `${resolved.baseUrl}/ajax/managements_ajax/update_kcaptcha`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': resolved.baseUrl,
        'Referer': `${resolved.baseUrl}/mgallery/management/gallery?id=${encodeURIComponent(resolved.galleryId)}`,
      },
      body: body.toString(),
    },
    1,
  );

  const rawText = await response.text();
  const parsed = parseJsonResponse(rawText);
  const result = String(parsed?.result || '').trim();

  return {
    success: response.status === 200 && result === 'success',
    status: response.status,
    result,
    rawText,
    rawSummary: summarizeResponseText(rawText),
  };
}

function looksLikeManagementGalleryHtml(htmlText) {
  const normalized = String(htmlText || '');
  return normalized.includes('/mgallery/management/gallery?id=')
    && hasAnyMarker(normalized, [
      'update_recom_decom',
      'update_kcaptcha',
      '/ajax/managements_ajax/',
    ]);
}

function hasAnyMarker(text, markers) {
  return markers.some((marker) => String(text || '').includes(marker));
}

function parseKcaptchaSettings(html) {
  const sectionHtml = extractKcaptchaSectionHtml(html);
  if (!sectionHtml) {
    throw new Error('kcaptcha 설정 영역을 찾지 못했습니다.');
  }

  const rawSettings = {};
  for (const fieldName of KCAPTCHA_REQUIRED_FIELD_NAMES) {
    rawSettings[fieldName] = parseFieldValue(sectionHtml, fieldName);
  }

  return normalizeKcaptchaSettings(rawSettings);
}

function extractKcaptchaSectionHtml(htmlText) {
  const normalized = String(htmlText || '');
  if (!normalized) {
    return '';
  }

  const anchoredForm = extractNearestFormAroundAnchor(normalized, 'update_kcaptcha');
  if (isLikelyKcaptchaSectionHtml(anchoredForm)) {
    return anchoredForm;
  }

  const formMatches = normalized.match(/<form\b[\s\S]*?<\/form>/gi) || [];
  const bestForm = formMatches
    .map((sectionHtml) => ({
      sectionHtml,
      score: scoreKcaptchaSectionHtml(sectionHtml),
    }))
    .sort((left, right) => right.score - left.score)[0];

  if (bestForm && isLikelyKcaptchaSectionHtml(bestForm.sectionHtml)) {
    return bestForm.sectionHtml;
  }

  const anchorWindow = extractAnchorWindow(normalized, 'update_kcaptcha');
  if (isLikelyKcaptchaSectionHtml(anchorWindow)) {
    return anchorWindow;
  }

  return '';
}

function extractNearestFormAroundAnchor(htmlText, anchor) {
  const anchorIndex = String(htmlText || '').indexOf(anchor);
  if (anchorIndex < 0) {
    return '';
  }

  const formStart = htmlText.lastIndexOf('<form', anchorIndex);
  if (formStart < 0) {
    return '';
  }

  const formEnd = htmlText.indexOf('</form>', anchorIndex);
  if (formEnd < 0) {
    return '';
  }

  return htmlText.slice(formStart, formEnd + '</form>'.length);
}

function extractAnchorWindow(htmlText, anchor) {
  const anchorIndex = String(htmlText || '').indexOf(anchor);
  if (anchorIndex < 0) {
    return '';
  }

  const startIndex = Math.max(0, anchorIndex - KCAPTCHA_SECTION_WINDOW_CHARS);
  const endIndex = Math.min(htmlText.length, anchorIndex + KCAPTCHA_SECTION_WINDOW_CHARS);
  return htmlText.slice(startIndex, endIndex);
}

function scoreKcaptchaSectionHtml(sectionHtml) {
  const text = String(sectionHtml || '');
  if (!text) {
    return 0;
  }

  let score = 0;
  if (text.includes('update_kcaptcha')) {
    score += 4;
  }

  for (const fieldName of KCAPTCHA_REQUIRED_FIELD_NAMES) {
    if (hasNamedField(text, fieldName)) {
      score += 1;
    }
  }

  return score;
}

function isLikelyKcaptchaSectionHtml(sectionHtml) {
  const text = String(sectionHtml || '');
  if (!text) {
    return false;
  }

  const matchedFieldCount = KCAPTCHA_REQUIRED_FIELD_NAMES
    .filter((fieldName) => hasNamedField(text, fieldName))
    .length;

  return hasNamedField(text, 'recom_cnt')
    && (text.includes('update_kcaptcha') || matchedFieldCount >= 6);
}

function hasNamedField(sectionHtml, fieldName) {
  return findTagMatchesByName(sectionHtml, 'input', fieldName).length > 0
    || findTagMatchesByName(sectionHtml, 'select', fieldName).length > 0
    || findTagMatchesByName(sectionHtml, 'textarea', fieldName).length > 0;
}

function assertCompleteKcaptchaSettings(settings = {}) {
  const normalized = normalizeKcaptchaSettings(settings);
  for (const fieldName of KCAPTCHA_REQUIRED_FIELD_NAMES) {
    if (normalized[fieldName] === undefined || normalized[fieldName] === null || normalized[fieldName] === '') {
      throw new Error(`kcaptcha 필수 필드 누락: ${fieldName}`);
    }
  }
  return normalized;
}

function normalizeKcaptchaSettings(settings = {}) {
  return {
    use_ips: normalizeKcaptchaToggleValue(settings.use_ips, 'use_ips'),
    write_cnt: normalizeKcaptchaCountValue(settings.write_cnt, 'write_cnt'),
    comment_cnt: normalizeKcaptchaCountValue(settings.comment_cnt, 'comment_cnt'),
    recom_cnt: normalizeKcaptchaCountValue(settings.recom_cnt, 'recom_cnt'),
    use_write: normalizeKcaptchaToggleValue(settings.use_write, 'use_write'),
    use_comment: normalizeKcaptchaToggleValue(settings.use_comment, 'use_comment'),
    use_recom: normalizeKcaptchaToggleValue(settings.use_recom, 'use_recom'),
    use_recom_r: normalizeKcaptchaToggleValue(settings.use_recom_r, 'use_recom_r'),
    use_recom_n: normalizeKcaptchaToggleValue(settings.use_recom_n, 'use_recom_n'),
  };
}

function normalizeKcaptchaToggleValue(value, fieldName) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    throw new Error(`kcaptcha toggle 값 누락: ${fieldName}`);
  }

  if (['1', 'y', 'yes', 'true', 'on'].includes(normalized)) {
    return '1';
  }

  if (['0', 'n', 'no', 'false', 'off'].includes(normalized)) {
    return '0';
  }

  throw new Error(`kcaptcha toggle 값 해석 실패: ${fieldName}=${value}`);
}

function normalizeKcaptchaCountValue(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`kcaptcha 숫자 값 해석 실패: ${fieldName}=${value}`);
  }
  return String(Number(normalized));
}

function parseFieldValue(sectionHtml, fieldName) {
  const selectMatches = findTagMatchesByName(sectionHtml, 'select', fieldName);
  if (selectMatches.length > 0) {
    return parseSelectValue(selectMatches[0], fieldName);
  }

  const inputMatches = findTagMatchesByName(sectionHtml, 'input', fieldName);
  if (inputMatches.length > 0) {
    return parseInputValue(inputMatches, fieldName);
  }

  const textareaMatches = findTagMatchesByName(sectionHtml, 'textarea', fieldName);
  if (textareaMatches.length > 0) {
    return extractTextareaValue(textareaMatches[0]);
  }

  return undefined;
}

function parseSelectValue(selectHtml, fieldName) {
  const optionMatches = String(selectHtml || '').match(/<option\b[\s\S]*?<\/option>/gi) || [];
  if (optionMatches.length <= 0) {
    throw new Error(`kcaptcha select option 누락: ${fieldName}`);
  }

  const selectedOption = optionMatches.find((optionHtml) => hasBooleanAttribute(optionHtml, 'selected'));
  return extractAttributeValue(selectedOption || optionMatches[0], 'value');
}

function parseInputValue(inputMatches, fieldName) {
  const normalizedInputs = inputMatches.map((inputHtml) => ({
    html: inputHtml,
    type: String(extractAttributeValue(inputHtml, 'type') || 'text').trim().toLowerCase(),
  }));

  const radioInputs = normalizedInputs.filter((input) => input.type === 'radio');
  if (radioInputs.length > 0) {
    const checkedRadio = radioInputs.find((input) => hasBooleanAttribute(input.html, 'checked'));
    return extractAttributeValue((checkedRadio || radioInputs[0]).html, 'value');
  }

  const checkboxInputs = normalizedInputs.filter((input) => input.type === 'checkbox');
  if (checkboxInputs.length > 0) {
    const checkedInput = checkboxInputs.find((input) => hasBooleanAttribute(input.html, 'checked'));
    if (checkedInput) {
      return normalizeCheckboxSubmittedValue(extractAttributeValue(checkedInput.html, 'value'));
    }

    const hiddenInput = normalizedInputs.find((input) => input.type === 'hidden');
    if (hiddenInput) {
      return extractAttributeValue(hiddenInput.html, 'value');
    }

    if (KCAPTCHA_TOGGLE_FIELD_NAMES.has(fieldName)) {
      return '0';
    }
  }

  const preferredInput = normalizedInputs.find((input) => input.type === 'hidden')
    || normalizedInputs[0];
  return extractAttributeValue(preferredInput.html, 'value');
}

function normalizeCheckboxSubmittedValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : '1';
}

function extractTextareaValue(textareaHtml) {
  const match = String(textareaHtml || '').match(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/i);
  return decodeHtmlEntities(match ? match[1] : '');
}

function findTagMatchesByName(sectionHtml, tagName, fieldName) {
  const tagPattern = tagName === 'select' || tagName === 'textarea'
    ? new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, 'gi')
    : new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const matches = String(sectionHtml || '').match(tagPattern) || [];
  return matches.filter((tagHtml) => attributeEquals(tagHtml, 'name', fieldName));
}

function attributeEquals(tagHtml, attrName, expectedValue) {
  return extractAttributeValue(tagHtml, attrName) === expectedValue;
}

function extractAttributeValue(tagHtml, attrName) {
  const pattern = new RegExp(`\\b${escapeRegExp(attrName)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`, 'i');
  const match = String(tagHtml || '').match(pattern);
  if (!match) {
    return '';
  }

  return decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

function hasBooleanAttribute(tagHtml, attrName) {
  const pattern = new RegExp(`\\b${escapeRegExp(attrName)}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\\x60]+))?(?=\\s|>|$)`, 'i');
  return pattern.test(String(tagHtml || ''));
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/&#x27;/gi, '\'')
    .replace(/&apos;/gi, '\'')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexDigits) => String.fromCodePoint(Number.parseInt(hexDigits, 16)));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function summarizeResponseText(responseText) {
  const normalized = String(responseText || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return '<empty>';
  }

  try {
    return JSON.stringify(JSON.parse(normalized)).slice(0, 200);
  } catch {
    return normalized.slice(0, 200);
  }
}

function parseJsonResponse(responseText) {
  try {
    return JSON.parse(String(responseText || '').trim());
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  DEFAULT_CONFIG,
  delay,
  fetchBoardListHTML,
  fetchConceptListHTML,
  fetchConceptListPageHTML,
  fetchConceptPostViewHTML,
  releaseConceptPost,
  resolveConfig,
  syncKcaptchaRecomCnt,
  updateRecommendCut,
};

const DEFAULT_CONFIG = {
  agentBaseUrl: 'http://127.0.0.1:8765',
  authToken: '',
  profileId: '',
  requestTimeoutMs: 800,
  actionTimeoutMs: 3000,
};

function normalizeConfig(config = {}) {
  return {
    agentBaseUrl: normalizeBaseUrl(config.agentBaseUrl || DEFAULT_CONFIG.agentBaseUrl),
    authToken: String(config.authToken || '').trim(),
    profileId: String(config.profileId || '').trim(),
    requestTimeoutMs: normalizePositiveInteger(config.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs),
    actionTimeoutMs: normalizePositiveInteger(config.actionTimeoutMs, DEFAULT_CONFIG.actionTimeoutMs),
  };
}

async function getAgentHealth(config = {}, options = {}) {
  return agentRequest(config, '/v1/health', {
    method: 'GET',
    timeoutMs: options.timeoutMs,
  });
}

async function getVpnStatus(config = {}, options = {}) {
  return agentRequest(config, '/v1/vpn/status', {
    method: 'GET',
    timeoutMs: options.timeoutMs,
  });
}

async function getVpnEgress(config = {}, options = {}) {
  return agentRequest(config, '/v1/vpn/egress', {
    method: 'GET',
    timeoutMs: options.timeoutMs,
  });
}

async function connectVpn(config = {}, profileId = '', options = {}) {
  return agentRequest(config, '/v1/vpn/connect', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: {
      profileId: String(profileId || '').trim(),
    },
  });
}

async function disconnectVpn(config = {}, options = {}) {
  return agentRequest(config, '/v1/vpn/disconnect', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: {},
  });
}

async function agentRequest(config = {}, path = '/', options = {}) {
  const resolved = normalizeConfig(config);
  const baseUrlValidationMessage = getAgentBaseUrlValidationMessage(resolved.agentBaseUrl);
  if (baseUrlValidationMessage) {
    throw new Error(baseUrlValidationMessage);
  }
  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs,
    options.method === 'POST' ? resolved.actionTimeoutMs : resolved.requestTimeoutMs,
  );
  const targetUrl = buildTargetUrl(resolved.agentBaseUrl, path);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    Accept: 'application/json, text/plain, */*',
  };

  if (resolved.authToken) {
    headers.Authorization = `Bearer ${resolved.authToken}`;
    headers['X-DefenseSuite-Token'] = resolved.authToken;
  }

  const requestInit = {
    method: options.method || 'GET',
    headers,
    signal: controller.signal,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
    requestInit.body = JSON.stringify(options.body);
  }

  let response;
  let rawText = '';
  try {
    response = await fetch(targetUrl, requestInit);
    rawText = await response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error?.name === 'AbortError') {
      throw new Error(`local agent 요청 시간 초과 (${timeoutMs}ms)`);
    }
    throw new Error(`local agent 요청 실패 - ${String(error?.message || error || '알 수 없는 오류')}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const data = parseAgentResponseBody(rawText);
  if (!response.ok) {
    throw new Error(buildAgentFailureMessage(response.status, data, rawText));
  }

  return {
    statusCode: response.status,
    data,
    rawText,
    accepted: Boolean(data?.accepted ?? data?.success ?? true),
  };
}

function buildTargetUrl(baseUrl, path) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedPath = String(path || '/').startsWith('/')
    ? String(path || '/')
    : `/${String(path || '')}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

function parseAgentResponseBody(rawText = '') {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      message: trimmed,
    };
  }
}

function buildAgentFailureMessage(statusCode, data, rawText) {
  const message = String(
    data?.message
      || data?.error
      || data?.detail
      || rawText
      || `HTTP ${statusCode}`,
  ).replace(/\s+/g, ' ').trim();
  return message ? `local agent 응답 실패 (HTTP ${statusCode}) - ${message.slice(0, 200)}` : `local agent 응답 실패 (HTTP ${statusCode})`;
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return DEFAULT_CONFIG.agentBaseUrl;
  }

  return trimmed.replace(/\/+$/, '');
}

function getAgentBaseUrlValidationMessage(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return 'local agent 주소는 http://127.0.0.1:8765 형태로 입력하세요.';
  }

  if (parsedUrl.protocol !== 'http:') {
    return '현재 확장은 HTTP localhost local agent만 지원합니다. 예: http://127.0.0.1:8765';
  }

  const hostname = String(parsedUrl.hostname || '').trim().toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    return '현재 확장은 localhost / 127.0.0.1 / [::1] local agent만 지원합니다.';
  }

  if (parsedUrl.username || parsedUrl.password) {
    return 'local agent 주소에는 사용자 정보(username/password)를 넣지 마세요.';
  }

  if (parsedUrl.search || parsedUrl.hash) {
    return 'local agent 주소에는 query/hash 없이 http://127.0.0.1:8765 형태만 입력하세요.';
  }

  return '';
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(1, Number.parseInt(String(fallback ?? 1), 10) || 1);
  }

  return parsed;
}

export {
  DEFAULT_CONFIG,
  connectVpn,
  disconnectVpn,
  getAgentBaseUrlValidationMessage,
  getAgentHealth,
  getVpnEgress,
  getVpnStatus,
  normalizeConfig,
};

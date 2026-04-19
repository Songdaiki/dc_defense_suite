const CONNECTION_MODE = {
  PROFILE: 'profile',
  SOFTETHER_VPNGATE_RAW: 'softether_vpngate_raw',
};

const EMPTY_RELAY_SNAPSHOT = Object.freeze({
  id: '',
  fqdn: '',
  ip: '',
  sslPorts: [],
  udpPort: 0,
  hostUniqueKey: '',
});

const MIN_REQUEST_TIMEOUT_MS = 3000;
const MIN_ACTION_TIMEOUT_MS = 15000;

const DEFAULT_CONFIG = {
  agentBaseUrl: 'http://127.0.0.1:8765',
  authToken: '',
  connectionMode: CONNECTION_MODE.SOFTETHER_VPNGATE_RAW,
  profileId: '',
  selectedRelayId: '',
  selectedSslPort: 0,
  relaySnapshot: EMPTY_RELAY_SNAPSHOT,
  requestTimeoutMs: MIN_REQUEST_TIMEOUT_MS,
  actionTimeoutMs: MIN_ACTION_TIMEOUT_MS,
};

function normalizeConfig(config = {}) {
  const normalizedConnectionMode = normalizeConnectionMode(config.connectionMode ?? DEFAULT_CONFIG.connectionMode);
  const normalizedRelaySnapshot = normalizeRelaySnapshot(config.relaySnapshot, config.selectedRelayId);
  const normalizedSelectedSslPort = normalizePort(config.selectedSslPort, DEFAULT_CONFIG.selectedSslPort);
  const normalizedSelectedRelayId = String(
    config.selectedRelayId
    || normalizedRelaySnapshot.id
    || '',
  ).trim();

  return {
    agentBaseUrl: normalizeBaseUrl(config.agentBaseUrl || DEFAULT_CONFIG.agentBaseUrl),
    authToken: String(config.authToken || '').trim(),
    connectionMode: normalizedConnectionMode,
    profileId: String(config.profileId || '').trim(),
    selectedRelayId: normalizedSelectedRelayId,
    selectedSslPort: normalizedSelectedSslPort,
    relaySnapshot: {
      ...normalizedRelaySnapshot,
      id: normalizedRelaySnapshot.id || normalizedSelectedRelayId,
      sslPorts: buildRelaySslPortList(normalizedRelaySnapshot.sslPorts, normalizedSelectedSslPort),
    },
    requestTimeoutMs: Math.max(
      MIN_REQUEST_TIMEOUT_MS,
      normalizePositiveInteger(config.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs),
    ),
    actionTimeoutMs: Math.max(
      MIN_ACTION_TIMEOUT_MS,
      normalizePositiveInteger(config.actionTimeoutMs, DEFAULT_CONFIG.actionTimeoutMs),
    ),
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

async function getParallelProbeStatus(config = {}, options = {}) {
  return agentRequest(config, '/v1/vpn/parallel-probe/status', {
    method: 'GET',
    timeoutMs: options.timeoutMs,
  });
}

async function connectVpn(config = {}, options = {}) {
  const resolvedConfig = normalizeConfig(config);
  return agentRequest(resolvedConfig, '/v1/vpn/connect', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: buildConnectRequestBody(resolvedConfig),
  });
}

async function disconnectVpn(config = {}, options = {}) {
  return agentRequest(config, '/v1/vpn/disconnect', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: {},
  });
}

async function startParallelProbe(config = {}, options = {}) {
  const resolvedConfig = normalizeConfig(config);
  return agentRequest(resolvedConfig, '/v1/vpn/parallel-probe/start', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: options.body && typeof options.body === 'object' ? options.body : {},
  });
}

async function stopParallelProbe(config = {}, options = {}) {
  return agentRequest(config, '/v1/vpn/parallel-probe/stop', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: {},
  });
}

async function prepareRawRelayCatalog(config = {}, options = {}) {
  const resolvedConfig = normalizeConfig(config);
  return agentRequest(resolvedConfig, '/v1/vpn/catalog/prepare', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: options.body && typeof options.body === 'object' ? options.body : {},
  });
}

async function primeRawRelayCatalogNics(config = {}, options = {}) {
  const resolvedConfig = normalizeConfig(config);
  return agentRequest(resolvedConfig, '/v1/vpn/catalog/prime-nics', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: options.body && typeof options.body === 'object' ? options.body : {},
  });
}

async function activateCatalogRelay(config = {}, relay = {}, options = {}) {
  const resolvedConfig = normalizeConfig(config);
  return agentRequest(resolvedConfig, '/v1/vpn/catalog/activate', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: {
      slotId: String(relay?.slotId || '').trim(),
      lookupKey: String(relay?.lookupKey || '').trim(),
      relay: {
        id: String(relay?.id ?? '').trim(),
        fqdn: String(relay?.fqdn || '').trim(),
        ip: String(relay?.ip || '').trim(),
        selectedSslPort: normalizePort(relay?.selectedSslPort, 0),
        sslPorts: normalizePortList(relay?.sslPorts),
        udpPort: normalizePort(relay?.udpPort, 0),
        hostUniqueKey: normalizeHostUniqueKey(relay?.hostUniqueKey),
        accountName: String(relay?.accountName || '').trim(),
        nicName: String(relay?.nicName || '').trim(),
      },
    },
  });
}

function buildConnectRequestBody(config = {}) {
  const resolvedConfig = normalizeConfig(config);
  const effectiveProfileId = getEffectiveProfileId(resolvedConfig);

  if (resolvedConfig.connectionMode === CONNECTION_MODE.PROFILE) {
    return {
      mode: CONNECTION_MODE.PROFILE,
      profileId: effectiveProfileId,
    };
  }

  const relayId = resolvedConfig.selectedRelayId || resolvedConfig.relaySnapshot.id;
  const relay = {
    fqdn: resolvedConfig.relaySnapshot.fqdn,
    ip: resolvedConfig.relaySnapshot.ip,
    selectedSslPort: resolvedConfig.selectedSslPort,
    sslPorts: resolvedConfig.relaySnapshot.sslPorts,
    udpPort: resolvedConfig.relaySnapshot.udpPort,
    hostUniqueKey: resolvedConfig.relaySnapshot.hostUniqueKey,
  };

  if (relayId) {
    relay.id = serializeRelayId(relayId);
  }

  return {
    mode: CONNECTION_MODE.SOFTETHER_VPNGATE_RAW,
    profileId: effectiveProfileId,
    relay,
  };
}

function getEffectiveProfileId(config = {}) {
  const resolvedConfig = normalizeConfig(config);
  if (resolvedConfig.profileId) {
    return resolvedConfig.profileId;
  }

  if (resolvedConfig.connectionMode !== CONNECTION_MODE.SOFTETHER_VPNGATE_RAW) {
    return '';
  }

  const relayId = resolvedConfig.selectedRelayId || resolvedConfig.relaySnapshot.id;
  const selectedSslPort = resolvedConfig.selectedSslPort;
  if (relayId && selectedSslPort) {
    return `vpngate-${sanitizeToken(relayId)}-${selectedSslPort}`;
  }

  const relayHost = resolvedConfig.relaySnapshot.ip || resolvedConfig.relaySnapshot.fqdn;
  if (relayHost && selectedSslPort) {
    return `vpngate-${sanitizeToken(relayHost)}-${selectedSslPort}`;
  }

  return '';
}

function getConfigValidationMessage(config = {}) {
  const resolvedConfig = normalizeConfig(config);
  const baseUrlValidationMessage = getAgentBaseUrlValidationMessage(resolvedConfig.agentBaseUrl);
  if (baseUrlValidationMessage) {
    return baseUrlValidationMessage;
  }

  if (!resolvedConfig.agentBaseUrl) {
    return 'local agent 주소를 입력한 뒤 저장하세요.';
  }

  if (resolvedConfig.connectionMode === CONNECTION_MODE.PROFILE) {
    if (!resolvedConfig.profileId) {
      const rawRelayConfigured = Boolean(
        resolvedConfig.selectedRelayId
        || resolvedConfig.selectedSslPort
        || resolvedConfig.relaySnapshot.id
        || resolvedConfig.relaySnapshot.ip
        || resolvedConfig.relaySnapshot.fqdn,
      );
      if (rawRelayConfigured) {
        return '현재 연결 모드가 profile입니다. raw 목록 클릭 연결을 쓰려면 연결 모드를 SoftEther VPNGate raw로 바꾼 뒤 저장하세요.';
      }
      return 'profile 모드에서는 profile ID를 입력한 뒤 저장하세요.';
    }

    return '';
  }

  const relayHost = String(resolvedConfig.relaySnapshot.ip || resolvedConfig.relaySnapshot.fqdn || '').trim();
  if (!relayHost) {
    return 'raw 릴레이 IP 또는 FQDN을 입력한 뒤 저장하세요.';
  }

  if (!resolvedConfig.selectedSslPort) {
    return 'raw 릴레이 SSL 포트를 입력한 뒤 저장하세요.';
  }

  if (resolvedConfig.relaySnapshot.hostUniqueKey
    && /^[0-9A-F]{40}$/.test(resolvedConfig.relaySnapshot.hostUniqueKey) === false) {
    return 'HostUniqueKey는 40자리 hex 문자열만 입력하세요.';
  }

  return '';
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
    throw new Error(buildAgentFailureMessage(response.status, data, rawText, path));
  }

  return {
    statusCode: response.status,
    data,
    rawText,
    accepted: Boolean(data?.accepted ?? data?.success ?? true),
  };
}

function normalizeConnectionMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === CONNECTION_MODE.SOFTETHER_VPNGATE_RAW) {
    return CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
  }

  return CONNECTION_MODE.PROFILE;
}

function normalizeRelaySnapshot(snapshot = {}, fallbackRelayId = '') {
  const rawSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    id: String(rawSnapshot.id ?? rawSnapshot.ID ?? fallbackRelayId ?? '').trim(),
    fqdn: String(rawSnapshot.fqdn ?? rawSnapshot.Fqdn ?? '').trim(),
    ip: String(rawSnapshot.ip ?? rawSnapshot.IP ?? '').trim(),
    sslPorts: normalizePortList(rawSnapshot.sslPorts ?? rawSnapshot.SslPorts),
    udpPort: normalizePort(rawSnapshot.udpPort ?? rawSnapshot.UdpPort, 0),
    hostUniqueKey: normalizeHostUniqueKey(rawSnapshot.hostUniqueKey ?? rawSnapshot.HostUniqueKey),
  };
}

function normalizePortList(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[\s,]+/)
      .filter(Boolean);
  const normalized = [];
  const seen = new Set();
  for (const rawValue of rawValues) {
    const port = normalizePort(rawValue, 0);
    if (!port || seen.has(port)) {
      continue;
    }
    seen.add(port);
    normalized.push(port);
  }
  return normalized;
}

function buildRelaySslPortList(sslPorts = [], selectedSslPort = 0) {
  const normalized = normalizePortList(sslPorts);
  if (!selectedSslPort) {
    return normalized;
  }

  return [
    selectedSslPort,
    ...normalized.filter(port => port !== selectedSslPort),
  ];
}

function normalizeHostUniqueKey(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}

function normalizePort(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }

  return parsed;
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

function buildAgentFailureMessage(statusCode, data, rawText, path = '') {
  const message = String(
    data?.message
      || data?.error
      || data?.detail
      || rawText
      || `HTTP ${statusCode}`,
  ).replace(/\s+/g, ' ').trim();
  const normalizedPath = String(path || '').trim();
  if (
    statusCode === 404
    && ['/v1/vpn/catalog/prepare', '/v1/vpn/catalog/activate'].includes(normalizedPath)
    && /지원하지 않는 경로|NOT_FOUND/i.test(`${String(data?.error || '')} ${message}`)
  ) {
    return [
      'local agent 응답 실패 (HTTP 404) - 실행 중인 local agent가 예전 버전입니다.',
      '',
      'Windows에서 한 번에 다시 실행:',
      `powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess); if($p){taskkill /PID $p /F}; Set-Location 'C:\\Users\\eorb9\\projects\\dc_defense_suite_repo'; node projects\\self_hosted_vpn_agent\\server.mjs"`,
      '',
      '포트 충돌을 피해서 8766으로 실행:',
      `powershell -NoProfile -Command "Set-Location 'C:\\Users\\eorb9\\projects\\dc_defense_suite_repo'; $env:PORT='8766'; node projects\\self_hosted_vpn_agent\\server.mjs"`,
      '',
      '그다음 확장 설정의 local agent 주소를 http://127.0.0.1:8766 으로 바꾸세요.',
    ].join('\n');
  }
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

function sanitizeToken(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'relay';
}

function serializeRelayId(value) {
  const trimmed = String(value || '').trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  return trimmed;
}

export {
  CONNECTION_MODE,
  DEFAULT_CONFIG,
  EMPTY_RELAY_SNAPSHOT,
  activateCatalogRelay,
  connectVpn,
  disconnectVpn,
  getAgentBaseUrlValidationMessage,
  getAgentHealth,
  getParallelProbeStatus,
  getConfigValidationMessage,
  getEffectiveProfileId,
  primeRawRelayCatalogNics,
  prepareRawRelayCatalog,
  getVpnEgress,
  getVpnStatus,
  normalizeConfig,
  normalizeConnectionMode,
  startParallelProbe,
  stopParallelProbe,
};

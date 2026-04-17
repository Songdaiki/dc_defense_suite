import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4318;
const DEFAULT_WEBSHARE_API_KEY = 'urjvuojy8nwnqx0ydgogsvjljanjegec7re4ervg';
const PROXY_CACHE_TTL_MS = 10 * 60 * 1000;
const GALLERY_ID_REGEX = /^[a-z0-9_]+$/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'Accept-Encoding': 'identity',
};

const HOST = String(process.env.HOST || DEFAULT_HOST).trim() || DEFAULT_HOST;
const PORT = normalizePositiveInteger(process.env.PORT, DEFAULT_PORT, 1);
const WEBSHARE_API_KEY = String(process.env.WEBSHARE_API_KEY || DEFAULT_WEBSHARE_API_KEY || '').trim();

assertLoopbackHost(HOST);

const proxyCacheState = {
  proxies: [],
  fetchedAt: 0,
  lastProxyRefreshAt: '',
  proxyIndex: 0,
  loadingPromise: null,
};

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      writeJson(response, 204, { success: true });
      return;
    }

    if (request.method === 'GET' && request.url === '/health') {
      await handleHealth(response);
      return;
    }

    if (request.method === 'POST' && request.url === '/reflux-overlay/fetch-board-list') {
      await handleFetchBoardList(request, response);
      return;
    }

    writeJson(response, 404, {
      success: false,
      message: '지원하지 않는 endpoint입니다.',
    });
  } catch (error) {
    if (!response.headersSent) {
      writeJson(response, normalizeErrorStatusCode(error, 500), {
        success: false,
        message: String(error?.message || '알 수 없는 오류'),
      });
    }
  }
});

server.on('clientError', (error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  console.error('[RefluxOverlayProxyBridge] client error:', error.message);
});

server.listen(PORT, HOST, () => {
  console.log(`[RefluxOverlayProxyBridge] listening on http://${HOST}:${PORT}`);
});

for (const signalName of ['SIGINT', 'SIGTERM']) {
  process.on(signalName, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}

async function handleHealth(response) {
  requireWebshareApiKey();
  const { proxies, lastProxyRefreshAt } = await ensureProxyPool();

  writeJson(response, 200, {
    success: true,
    status: 'ok',
    proxyCount: proxies.length,
    lastProxyRefreshAt,
  });
}

async function handleFetchBoardList(request, response) {
  requireWebshareApiKey();

  const body = await readJsonBody(request);
  const galleryId = normalizeGalleryId(body?.galleryId);
  const page = parsePositiveIntegerOrZero(body?.page);
  const maxRetries = normalizePositiveInteger(body?.maxRetries, 1, 1);

  if (!galleryId || !GALLERY_ID_REGEX.test(galleryId)) {
    writeJson(response, 400, {
      success: false,
      message: 'galleryId 형식이 비정상입니다.',
    });
    return;
  }

  if (page <= 0) {
    writeJson(response, 400, {
      success: false,
      message: 'page 값이 비정상입니다.',
    });
    return;
  }

  const abortController = new AbortController();
  request.on('aborted', () => abortController.abort(createAbortError('클라이언트 요청이 중단되었습니다.')));
  response.on('close', () => {
    if (!response.writableEnded) {
      abortController.abort(createAbortError('클라이언트 연결이 종료되었습니다.'));
    }
  });

  const { proxies } = await ensureProxyPool();
  const attemptCount = Math.max(1, Math.min(maxRetries, proxies.length));
  const targetUrl = buildBoardListUrl(galleryId, page);
  let lastError = null;

  for (let attempt = 0; attempt < attemptCount; attempt += 1) {
    const proxy = getNextProxy(proxies);

    try {
      const { statusCode, body: html } = await requestBoardListViaProxy(targetUrl, proxy, {
        signal: abortController.signal,
      });

      if (!isLikelyBoardListHtml(html)) {
        const htmlError = new Error('목록 HTML 검증 실패');
        htmlError.statusCode = 502;
        throw htmlError;
      }

      writeJson(response, 200, {
        success: true,
        galleryId,
        page,
        statusCode,
        html,
      });
      return;
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      lastError = error;
    }
  }

  const failureMessage = String(lastError?.message || '모든 프록시 시도 실패');
  writeJson(response, normalizeErrorStatusCode(lastError, 502), {
    success: false,
    message: failureMessage.includes('목록 HTML 검증 실패')
      ? '목록 HTML 검증 실패'
      : '모든 프록시 시도 실패',
    lastError: failureMessage,
    attemptCount,
  });
}

async function ensureProxyPool() {
  const now = Date.now();
  if (
    proxyCacheState.proxies.length > 0
    && now - proxyCacheState.fetchedAt < PROXY_CACHE_TTL_MS
  ) {
    return {
      proxies: proxyCacheState.proxies,
      lastProxyRefreshAt: proxyCacheState.lastProxyRefreshAt,
    };
  }

  if (!proxyCacheState.loadingPromise) {
    proxyCacheState.loadingPromise = (async () => {
      const proxies = await fetchProxyListFromWebshare();
      proxyCacheState.proxies = proxies;
      proxyCacheState.fetchedAt = Date.now();
      proxyCacheState.lastProxyRefreshAt = new Date(proxyCacheState.fetchedAt).toISOString();
      if (proxyCacheState.proxyIndex >= proxies.length) {
        proxyCacheState.proxyIndex = 0;
      }
      return {
        proxies,
        lastProxyRefreshAt: proxyCacheState.lastProxyRefreshAt,
      };
    })().finally(() => {
      proxyCacheState.loadingPromise = null;
    });
  }

  return proxyCacheState.loadingPromise;
}

async function fetchProxyListFromWebshare() {
  const { statusCode, body } = await requestHttpsText(
    'https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100',
    {
      Authorization: `Token ${WEBSHARE_API_KEY}`,
      Accept: 'application/json',
    },
  );

  if (statusCode < 200 || statusCode >= 300) {
    const error = new Error(`Webshare proxy list 조회 실패 (HTTP ${statusCode})`);
    error.statusCode = 502;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    const error = new Error('Webshare proxy list JSON 파싱 실패');
    error.statusCode = 502;
    throw error;
  }

  const proxies = (Array.isArray(payload?.results) ? payload.results : [])
    .filter((entry) => (
      entry?.valid
      && String(entry?.proxy_address || '').trim()
      && Number(entry?.port) > 0
      && String(entry?.username || '').trim()
      && String(entry?.password || '').trim()
    ))
    .map((entry) => ({
      host: String(entry.proxy_address || '').trim(),
      port: normalizePositiveInteger(entry.port, 0, 1),
      username: String(entry.username || '').trim(),
      password: String(entry.password || '').trim(),
    }));

  if (proxies.length <= 0) {
    const error = new Error('사용 가능한 Webshare 프록시가 없습니다.');
    error.statusCode = 503;
    throw error;
  }

  return proxies;
}

function getNextProxy(proxies) {
  if (!Array.isArray(proxies) || proxies.length <= 0) {
    const error = new Error('사용 가능한 Webshare 프록시가 없습니다.');
    error.statusCode = 503;
    throw error;
  }

  const proxy = proxies[proxyCacheState.proxyIndex % proxies.length];
  proxyCacheState.proxyIndex = (proxyCacheState.proxyIndex + 1) % proxies.length;
  return proxy;
}

function buildBoardListUrl(galleryId, page) {
  const url = new URL('https://gall.dcinside.com/mgallery/board/lists/');
  url.searchParams.set('id', galleryId);
  url.searchParams.set('page', String(page));
  return url.toString();
}

function isLikelyBoardListHtml(html) {
  const text = String(html || '');
  return text.includes('gall_list') && text.includes('ub-content');
}

function requestHttpsText(urlString, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(urlString, {
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        ...headers,
      },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: Number(response.statusCode) || 0,
          body,
        });
      });
    });

    request.on('error', reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error('Webshare API 요청 타임아웃'));
    });
    request.end();
  });
}

function requestBoardListViaProxy(targetUrl, proxy, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxyAuth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
    const signal = options.signal;
    let settled = false;
    let connectRequest = null;
    let targetRequest = null;
    let tunnelSocket = null;

    const cleanup = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const onAbort = () => {
      const abortError = createAbortError();
      if (targetRequest) {
        targetRequest.destroy(abortError);
      }
      if (tunnelSocket) {
        tunnelSocket.destroy(abortError);
      }
      if (connectRequest) {
        connectRequest.destroy(abortError);
      }
    };

    const finishResolve = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    connectRequest = http.request({
      hostname: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: {
        Host: `${target.hostname}:${target.port || 443}`,
        'Proxy-Authorization': `Basic ${proxyAuth}`,
      },
    });

    connectRequest.once('connect', (response, socket, head) => {
      const statusCode = Number(response.statusCode) || 0;
      if (statusCode !== 200) {
        const error = new Error(`프록시 CONNECT 실패 (${statusCode})`);
        error.statusCode = 502;
        socket.destroy();
        finishReject(error);
        return;
      }

      tunnelSocket = tls.connect({
        socket,
        servername: target.hostname,
      });

      if (head?.length) {
        tunnelSocket.unshift(head);
      }

      targetRequest = https.request({
        protocol: 'https:',
        hostname: target.hostname,
        port: Number(target.port) || 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          ...DEFAULT_HEADERS,
          Host: target.host,
          Connection: 'close',
        },
        agent: false,
        createConnection: () => tunnelSocket,
      }, (targetResponse) => {
        let body = '';
        targetResponse.setEncoding('utf8');
        targetResponse.on('data', (chunk) => {
          body += chunk;
        });
        targetResponse.on('end', () => {
          const targetStatusCode = Number(targetResponse.statusCode) || 0;
          if (targetStatusCode >= 400) {
            const error = new Error(`프록시 응답 ${targetStatusCode}: ${body.slice(0, 200)}`);
            error.statusCode = 502;
            finishReject(error);
            return;
          }

          finishResolve({
            statusCode: targetStatusCode,
            body,
          });
        });
      });

      targetRequest.on('error', (error) => {
        finishReject(isAbortError(error) ? createAbortError() : error);
      });
      targetRequest.setTimeout(30000, () => {
        targetRequest.destroy(new Error('프록시 요청 타임아웃'));
      });
      tunnelSocket.on('error', (error) => {
        finishReject(isAbortError(error) ? createAbortError() : error);
      });
      tunnelSocket.setTimeout(30000, () => {
        tunnelSocket.destroy(new Error('프록시 요청 타임아웃'));
      });
      targetRequest.end();
    });

    if (signal?.aborted) {
      finishReject(createAbortError());
      return;
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    connectRequest.on('error', (error) => {
      finishReject(isAbortError(error) ? createAbortError() : error);
    });
    connectRequest.setTimeout(15000, () => {
      connectRequest.destroy(new Error('프록시 CONNECT 타임아웃'));
    });
    connectRequest.end();
  });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let rawBody = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      rawBody += chunk;
      if (rawBody.length > 1024 * 64) {
        reject(new Error('요청 body가 너무 큽니다.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!rawBody.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(new Error('JSON body 파싱 실패'));
      }
    });
    request.on('error', reject);
  });
}

function writeJson(response, statusCode, payload) {
  if (response.headersSent) {
    return;
  }

  if (statusCode === 204) {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Cache-Control': 'no-store',
    });
    response.end();
    return;
  }

  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function assertLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('bridge host는 127.0.0.1 / ::1 / localhost만 허용합니다.');
  }
}

function requireWebshareApiKey() {
  if (!WEBSHARE_API_KEY) {
    const error = new Error('WEBSHARE_API_KEY가 설정되지 않았습니다.');
    error.statusCode = 500;
    throw error;
  }
}

function normalizeGalleryId(value) {
  return String(value || '').trim();
}

function normalizePositiveInteger(value, fallback, minimum = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return Math.max(minimum, Number.parseInt(String(fallback ?? minimum), 10) || minimum);
  }

  return Math.max(minimum, parsed);
}

function parsePositiveIntegerOrZero(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return parsed;
}

function normalizeErrorStatusCode(error, fallback) {
  const statusCode = Number(error?.statusCode) || 0;
  if (statusCode >= 100 && statusCode <= 599) {
    return statusCode;
  }
  return fallback;
}

function createAbortError(message = '요청이 중단되었습니다.') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error) {
  return Boolean(error?.name === 'AbortError');
}

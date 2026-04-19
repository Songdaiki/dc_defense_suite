import process from 'node:process';
import { randomBytes } from 'node:crypto';

import { decodeVpnGateDatBuffer } from '../../features/vpngate-prefix/dat-decode.js';
import { SoftEtherCli, sanitizeManagedToken } from './lib/softether_cli.mjs';

const OFFICIAL_DAT_BASE_URL = 'http://xd.x1.client.api.vpngate2.jp/api/';
const OFFICIAL_DAT_FETCH_TIMEOUT_MS = 15000;
const DEFAULT_LIMIT = 200;
const DEFAULT_NIC_NAME = 'VPN2';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PREFERRED_COUNTRIES = ['KR', 'JP'];
const DEFAULT_PREFERRED_PORTS = [443, 995, 1698, 5555, 992, 1194];
const CONNECT_TIMEOUT_MS = 20000;
const CLEANUP_TIMEOUT_MS = 10000;
const WAIT_STEP_MS = 1000;
const SURVEY_ACCOUNT_PREFIX = 'SURVEY-';

function parseArgs(argv = []) {
  const options = {
    limit: DEFAULT_LIMIT,
    nicName: DEFAULT_NIC_NAME,
    nicNames: [],
    concurrency: DEFAULT_CONCURRENCY,
    preferredCountries: [...DEFAULT_PREFERRED_COUNTRIES],
    preferredPorts: [...DEFAULT_PREFERRED_PORTS],
  };

  for (const arg of argv) {
    if (arg.startsWith('--limit=')) {
      options.limit = Math.max(1, Number.parseInt(arg.slice('--limit='.length), 10) || DEFAULT_LIMIT);
      continue;
    }

    if (arg.startsWith('--nic=')) {
      options.nicName = String(arg.slice('--nic='.length) || DEFAULT_NIC_NAME).trim() || DEFAULT_NIC_NAME;
      continue;
    }

    if (arg.startsWith('--nics=')) {
      options.nicNames = String(arg.slice('--nics='.length) || '')
        .split(',')
        .map(value => String(value || '').trim())
        .filter(Boolean);
      continue;
    }

    if (arg.startsWith('--concurrency=')) {
      options.concurrency = Math.max(1, Number.parseInt(arg.slice('--concurrency='.length), 10) || DEFAULT_CONCURRENCY);
      continue;
    }

    if (arg.startsWith('--countries=')) {
      options.preferredCountries = String(arg.slice('--countries='.length))
        .split(',')
        .map(value => String(value || '').trim().toUpperCase())
        .filter(Boolean);
      continue;
    }

    if (arg.startsWith('--ports=')) {
      options.preferredPorts = String(arg.slice('--ports='.length))
        .split(',')
        .map(value => Number.parseInt(String(value || ''), 10))
        .filter(value => Number.isFinite(value) && value > 0 && value <= 65535);
    }
  }

  return options;
}

function buildRandomSessionId() {
  return BigInt(`0x${randomBytes(8).toString('hex')}`).toString(10);
}

async function fetchLatestHosts() {
  const sessionId = buildRandomSessionId();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OFFICIAL_DAT_FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${OFFICIAL_DAT_BASE_URL}?session_id=${sessionId}`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: '*/*' },
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`official DAT fetch timeout (${OFFICIAL_DAT_FETCH_TIMEOUT_MS}ms)`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`official DAT fetch 실패 (HTTP ${response.status})`);
  }

  const decoded = await decodeVpnGateDatBuffer(new Uint8Array(await response.arrayBuffer()));
  return decoded.feed.hosts || [];
}

function parseSslPorts(host = {}) {
  return String(host?.SslPorts || '')
    .split(/\s+/)
    .map(value => Number.parseInt(String(value || ''), 10))
    .filter(value => Number.isFinite(value) && value > 0 && value <= 65535);
}

function choosePreferredPort(ports = [], preferredPorts = []) {
  for (const preferredPort of preferredPorts) {
    if (ports.includes(preferredPort)) {
      return preferredPort;
    }
  }

  return ports[0] || 0;
}

function buildPortAttemptList(ports = [], preferredPorts = [], selectedSslPort = 0) {
  const normalizedPorts = Array.from(new Set(
    ports
      .map(port => Number.parseInt(String(port || ''), 10))
      .filter(port => Number.isFinite(port) && port > 0 && port <= 65535),
  ));
  const ordered = [];
  const seen = new Set();
  const pushPort = (port) => {
    const normalizedPort = Number.parseInt(String(port || ''), 10);
    if (!Number.isFinite(normalizedPort) || normalizedPort <= 0 || normalizedPort > 65535 || seen.has(normalizedPort)) {
      return;
    }
    seen.add(normalizedPort);
    ordered.push(normalizedPort);
  };

  pushPort(selectedSslPort);
  for (const preferredPort of preferredPorts) {
    if (normalizedPorts.includes(preferredPort)) {
      pushPort(preferredPort);
    }
  }
  for (const port of normalizedPorts) {
    pushPort(port);
  }

  return ordered;
}

function buildCandidate(host = {}, preferredCountries = [], preferredPorts = []) {
  const sslPorts = parseSslPorts(host);
  const selectedSslPort = choosePreferredPort(sslPorts, preferredPorts);
  if (!host?.IP || !selectedSslPort) {
    return null;
  }

  const portAttempts = buildPortAttemptList(sslPorts, preferredPorts, selectedSslPort);
  const countryShort = String(host.CountryShort || '').trim().toUpperCase();
  const preferredCountryIndex = preferredCountries.indexOf(countryShort);
  const preferredPortIndex = preferredPorts.indexOf(selectedSslPort);

  return {
    id: String(host.ID || `${host.IP}:${selectedSslPort}`),
    ip: String(host.IP || '').trim(),
    fqdn: String(host.Fqdn || '').trim(),
    hostName: String(host.HostName || '').trim(),
    hostUniqueKey: String(host.HostUniqueKey || '').trim(),
    countryShort,
    countryFull: String(host.CountryFull || '').trim(),
    score: Number(host.Score || 0),
    verifyDate: Number(host.VerifyDate || 0),
    selectedSslPort,
    sslPorts,
    portAttempts,
    preferredCountryRank: preferredCountryIndex === -1 ? 999 : preferredCountryIndex,
    preferredPortRank: preferredPortIndex === -1 ? 999 : preferredPortIndex,
  };
}

function selectCandidates(hosts = [], options = {}) {
  const candidates = [];

  for (const host of hosts) {
    const candidate = buildCandidate(host, options.preferredCountries, options.preferredPorts);
    if (!candidate) {
      continue;
    }
    candidates.push(candidate);
    if (candidates.length >= options.limit) {
      break;
    }
  }

  return candidates.slice(0, options.limit);
}

async function safeListAccounts(cli, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await cli.listAccounts();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(250 * attempt);
      }
    }
  }

  throw lastError || new Error('AccountList 실패');
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isSurveyAccountName(name = '') {
  return String(name || '').trim().toUpperCase().startsWith(SURVEY_ACCOUNT_PREFIX);
}

async function resolveUsableNicName(cli, preferredName) {
  const nicRows = await cli.listNics();
  const preferred = nicRows.find(row => row.name === preferredName && /enabled/i.test(row.status));
  if (preferred) {
    return preferred.name;
  }

  const vpn2 = nicRows.find(row => row.name === 'VPN2' && /enabled/i.test(row.status));
  if (vpn2) {
    return vpn2.name;
  }

  const vpn = nicRows.find(row => row.name === 'VPN' && /enabled/i.test(row.status));
  if (vpn) {
    return vpn.name;
  }

  throw new Error('사용 가능한 SoftEther NIC(VPN/VPN2)가 없습니다.');
}

async function resolveUsableNicNames(cli, options = {}) {
  const nicRows = await cli.listNics();
  const enabledNames = nicRows
    .filter(row => /enabled/i.test(row.status))
    .map(row => row.name);
  const enabledSet = new Set(enabledNames);
  const preferredPool = Array.isArray(options.nicNames) && options.nicNames.length > 0
    ? options.nicNames
    : [options.nicName, 'VPN2', 'VPN3', 'VPN4', 'VPN5', 'VPN6', 'VPN7', 'VPN8', 'VPN9', 'VPN10', 'VPN'];
  const selected = [];
  const seen = new Set();
  const targetCount = Math.max(1, Number.parseInt(String(options.concurrency || 1), 10) || 1);

  for (const rawName of preferredPool) {
    const nicName = String(rawName || '').trim();
    if (!nicName || seen.has(nicName) || !enabledSet.has(nicName)) {
      continue;
    }
    seen.add(nicName);
    selected.push(nicName);
    if (selected.length >= targetCount) {
      break;
    }
  }

  if (selected.length < targetCount) {
    for (const nicName of enabledNames) {
      if (seen.has(nicName)) {
        continue;
      }
      seen.add(nicName);
      selected.push(nicName);
      if (selected.length >= targetCount) {
        break;
      }
    }
  }

  if (selected.length <= 0) {
    throw new Error('사용 가능한 SoftEther NIC(VPN/VPN2...)가 없습니다.');
  }

  return selected;
}

async function cleanupSurveyAccounts(cli) {
  const rows = await safeListAccounts(cli);
  const surveyRows = rows.filter(row => isSurveyAccountName(row.name));
  for (const row of surveyRows) {
    try {
      await cli.disconnectAccount(row.name);
    } catch {
      // ignore
    }
    try {
      await cli.deleteAccount(row.name);
    } catch {
      // ignore
    }
  }
}

async function assertNoForeignConnectedAccounts(cli) {
  const rows = await safeListAccounts(cli);
  const foreignRows = rows.filter((row) => {
    if (isSurveyAccountName(row.name)) {
      return false;
    }
    return ['CONNECTED', 'CONNECTING'].includes(row.statusKind);
  });

  if (foreignRows.length <= 0) {
    return;
  }

  const detail = foreignRows
    .map(row => `${row.name}:${row.statusText || row.statusKind}`)
    .join(', ');
  throw new Error(`다른 SoftEther 연결이 이미 살아있어서 survey를 시작할 수 없습니다 (${detail})`);
}

async function waitForConnectOutcome(cli, accountName, timeoutMs = CONNECT_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastState = 'UNKNOWN';
  let lastError = '';

  while ((Date.now() - startedAt) < timeoutMs) {
    let rows = [];
    try {
      rows = await safeListAccounts(cli);
    } catch (error) {
      lastError = String(error?.message || error || 'AccountList 실패');
      await wait(WAIT_STEP_MS);
      continue;
    }
    const row = rows.find(item => item.name === accountName) || null;
    if (!row) {
      lastState = 'MISSING';
      await wait(WAIT_STEP_MS);
      continue;
    }

    lastState = row.statusText || row.statusKind || 'UNKNOWN';
    if (row.statusKind === 'CONNECTED') {
      return {
        ok: true,
        state: lastState,
        row,
      };
    }

    if (row.statusKind === 'DISCONNECTED') {
      return {
        ok: false,
        state: lastState,
        reason: 'disconnected-before-connect',
      };
    }

    await wait(WAIT_STEP_MS);
  }

  return {
    ok: false,
    state: lastState,
    reason: lastError ? `connect-timeout (${lastError})` : 'connect-timeout',
  };
}

async function cleanupAccount(cli, accountName) {
  try {
    await cli.disconnectAccount(accountName);
  } catch {
    // ignore
  }

  const startedAt = Date.now();
  while ((Date.now() - startedAt) < CLEANUP_TIMEOUT_MS) {
    let rows = [];
    try {
      rows = await safeListAccounts(cli);
    } catch {
      await wait(WAIT_STEP_MS);
      continue;
    }
    const row = rows.find(item => item.name === accountName) || null;
    if (!row || row.statusKind === 'DISCONNECTED') {
      break;
    }
    await wait(WAIT_STEP_MS);
  }

  try {
    await cli.deleteAccount(accountName);
  } catch {
    // ignore
  }
}

async function surveyCandidate(cli, nicName, candidate) {
  const accountName = `${SURVEY_ACCOUNT_PREFIX}${sanitizeManagedToken(candidate.ip)}-${sanitizeManagedToken(nicName)}-${randomBytes(3).toString('hex')}`.slice(0, 63);
  const startedAt = Date.now();
  const attemptResults = [];

  for (const port of candidate.portAttempts) {
    try {
      await cleanupAccount(cli, accountName);
      await cli.createAccount({
        name: accountName,
        serverHost: candidate.ip,
        serverPort: port,
        hubName: 'VPNGATE',
        username: 'VPN',
        nicName,
      });
      await cli.setAccountAnonymous(accountName);
      await cli.setAccountRetry(accountName, {
        numRetry: 0,
        retryInterval: 15,
      });
      await cli.disableServerCertCheck(accountName);
      await cli.setAccountDetails(accountName, {
        maxTcp: 1,
        additionalConnectionInterval: 1,
        connectionTtl: 0,
        halfDuplex: false,
        bridgeMode: false,
        monitorMode: false,
        noRoutingTracking: true,
        noQos: true,
      });
      await cli.connectAccount(accountName);

      const outcome = await waitForConnectOutcome(cli, accountName, CONNECT_TIMEOUT_MS);
      attemptResults.push({
        port,
        ok: outcome.ok,
        state: outcome.state,
        reason: outcome.reason || '',
      });

      if (outcome.ok) {
        return {
          ok: true,
          ip: candidate.ip,
          fqdn: candidate.fqdn || candidate.hostName || '',
          countryShort: candidate.countryShort,
          countryFull: candidate.countryFull,
          selectedSslPort: candidate.selectedSslPort,
          connectedPort: port,
          elapsedMs: Date.now() - startedAt,
          attempts: attemptResults,
        };
      }
    } catch (error) {
      attemptResults.push({
        port,
        ok: false,
        state: 'ERROR',
        reason: String(error?.message || error || 'unknown-error'),
      });
    } finally {
      await cleanupAccount(cli, accountName);
    }
  }

  return {
    ok: false,
    ip: candidate.ip,
    fqdn: candidate.fqdn || candidate.hostName || '',
    countryShort: candidate.countryShort,
    countryFull: candidate.countryFull,
    selectedSslPort: candidate.selectedSslPort,
    connectedPort: 0,
    elapsedMs: Date.now() - startedAt,
    attempts: attemptResults,
    failureReason: attemptResults.map((item) => `[${item.port}] ${item.reason || item.state}`).join(' / '),
  };
}

function buildSummary(results = [], totalHosts = 0, totalCandidates = 0, nicNames = []) {
  const summary = {
    totalHosts,
    totalCandidates,
    success: 0,
    fail: 0,
    nicNames,
    byCountry: {},
    failureReasons: {},
  };

  for (const result of results) {
    if (!result) {
      continue;
    }

    if (result.ok) {
      summary.success += 1;
    } else {
      summary.fail += 1;
    }

    const countryKey = String(result.countryShort || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
    if (!summary.byCountry[countryKey]) {
      summary.byCountry[countryKey] = { total: 0, success: 0, fail: 0 };
    }
    summary.byCountry[countryKey].total += 1;
    if (result.ok) {
      summary.byCountry[countryKey].success += 1;
    } else {
      summary.byCountry[countryKey].fail += 1;
    }

    if (!result.ok) {
      const reason = String(result.failureReason || 'unknown-failure').trim() || 'unknown-failure';
      summary.failureReasons[reason] = (summary.failureReasons[reason] || 0) + 1;
    }
  }

  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bootstrapCli = new SoftEtherCli();
  const nicNames = await resolveUsableNicNames(bootstrapCli, options);
  await assertNoForeignConnectedAccounts(bootstrapCli);
  await cleanupSurveyAccounts(bootstrapCli);

  const hosts = await fetchLatestHosts();
  const candidates = selectCandidates(hosts, options);
  console.log(`[survey] latest hosts=${hosts.length}, selected candidates=${candidates.length}, nicPool=${nicNames.join(',')}, concurrency=${nicNames.length}`);

  const results = new Array(candidates.length);
  let nextIndex = 0;
  const workerRuns = nicNames.map((nicName, workerIndex) => (async () => {
    const cli = new SoftEtherCli();
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= candidates.length) {
        return;
      }

      const candidate = candidates[currentIndex];
      console.log(`[survey] worker=${workerIndex + 1} nic=${nicName} candidate ${currentIndex + 1}/${candidates.length}: ${candidate.ip}:${candidate.selectedSslPort} ${candidate.countryShort} attempts=${candidate.portAttempts.join('/')}`);
      let result;
      try {
        result = await surveyCandidate(cli, nicName, candidate);
      } catch (error) {
        result = {
          ok: false,
          ip: candidate.ip,
          fqdn: candidate.fqdn || candidate.hostName || '',
          countryShort: candidate.countryShort,
          countryFull: candidate.countryFull,
          selectedSslPort: candidate.selectedSslPort,
          connectedPort: 0,
          elapsedMs: 0,
          attempts: [],
          failureReason: String(error?.message || error || 'surveyCandidate 실패'),
        };
      }
      results[currentIndex] = {
        type: 'result',
        index: currentIndex + 1,
        worker: workerIndex + 1,
        nicName,
        ...result,
      };
      console.log(`[survey-json] ${JSON.stringify(results[currentIndex])}`);
    }
  })());

  await Promise.all(workerRuns);
  await cleanupSurveyAccounts(bootstrapCli);

  const summary = buildSummary(results, hosts.length, candidates.length, nicNames);
  console.log(`[survey-json] ${JSON.stringify({ type: 'summary', ...summary })}`);
}

main().catch((error) => {
  console.error('[survey] fatal:', error?.message || error);
  process.exitCode = 1;
});

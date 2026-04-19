import process from 'node:process';
import { randomBytes } from 'node:crypto';

import { decodeVpnGateDatBuffer } from '../../features/vpngate-prefix/dat-decode.js';
import { SoftEtherCli, sanitizeManagedToken } from './lib/softether_cli.mjs';

const OFFICIAL_DAT_BASE_URL = 'http://xd.x1.client.api.vpngate2.jp/api/';
const DEFAULT_LIMIT = 200;
const DEFAULT_NIC_NAME = 'VPN2';
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
  const response = await fetch(`${OFFICIAL_DAT_BASE_URL}?session_id=${sessionId}`, {
    method: 'GET',
    cache: 'no-store',
    headers: { Accept: '*/*' },
  });

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
  const seen = new Set();

  for (const host of hosts) {
    const candidate = buildCandidate(host, options.preferredCountries, options.preferredPorts);
    if (!candidate) {
      continue;
    }

    const key = `${candidate.ip}:${candidate.selectedSslPort}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    candidates.push(candidate);
  }

  candidates.sort((left, right) => {
    if (left.preferredCountryRank !== right.preferredCountryRank) {
      return left.preferredCountryRank - right.preferredCountryRank;
    }

    if (left.preferredPortRank !== right.preferredPortRank) {
      return left.preferredPortRank - right.preferredPortRank;
    }

    if (left.verifyDate !== right.verifyDate) {
      return right.verifyDate - left.verifyDate;
    }

    return right.score - left.score;
  });

  return candidates.slice(0, options.limit);
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

async function cleanupSurveyAccounts(cli) {
  const rows = await cli.listAccounts();
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

async function waitForConnectOutcome(cli, accountName, timeoutMs = CONNECT_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastState = 'UNKNOWN';

  while ((Date.now() - startedAt) < timeoutMs) {
    const rows = await cli.listAccounts();
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
    reason: 'connect-timeout',
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
    const rows = await cli.listAccounts();
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
  const accountName = `${SURVEY_ACCOUNT_PREFIX}${sanitizeManagedToken(candidate.ip)}-${Date.now().toString(36)}`.slice(0, 63);
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
        noRoutingTracking: false,
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
        await cleanupAccount(cli, accountName);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cli = new SoftEtherCli();
  const nicName = await resolveUsableNicName(cli, options.nicName);
  await cleanupSurveyAccounts(cli);

  const hosts = await fetchLatestHosts();
  const candidates = selectCandidates(hosts, options);
  console.log(`[survey] latest hosts=${hosts.length}, selected candidates=${candidates.length}, nic=${nicName}`);

  const summary = {
    totalHosts: hosts.length,
    totalCandidates: candidates.length,
    success: 0,
    fail: 0,
  };

  for (const [index, candidate] of candidates.entries()) {
    console.log(`[survey] candidate ${index + 1}/${candidates.length}: ${candidate.ip}:${candidate.selectedSslPort} ${candidate.countryShort} attempts=${candidate.portAttempts.join('/')}`);
    const result = await surveyCandidate(cli, nicName, candidate);
    if (result.ok) {
      summary.success += 1;
      console.log(`[survey-json] ${JSON.stringify({ type: 'result', index: index + 1, ...result })}`);
      continue;
    }

    summary.fail += 1;
    console.log(`[survey-json] ${JSON.stringify({ type: 'result', index: index + 1, ...result })}`);
  }

  console.log(`[survey-json] ${JSON.stringify({ type: 'summary', ...summary })}`);
}

main().catch((error) => {
  console.error('[survey] fatal:', error?.message || error);
  process.exitCode = 1;
});

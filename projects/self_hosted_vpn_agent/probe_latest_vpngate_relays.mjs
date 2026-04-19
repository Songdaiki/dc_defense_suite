import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CONNECTION_MODE,
  connectVpn as connectVpnViaAgent,
  disconnectVpn as disconnectVpnViaAgent,
  getAgentHealth as getAgentHealthViaAgent,
  getVpnStatus as getVpnStatusViaAgent,
  normalizeConfig as normalizeAgentConfig,
} from '../../features/self-hosted-vpn/api.js';
import { decodeVpnGateDatBuffer } from '../../features/vpngate-prefix/dat-decode.js';
import { NetworkObserver } from './lib/network_state.mjs';
import { SoftEtherCli, sanitizeManagedToken } from './lib/softether_cli.mjs';

const OFFICIAL_DAT_BASE_URL = 'http://xd.x1.client.api.vpngate2.jp/api/';
const DEFAULT_AGENT_BASE_URL = 'http://127.0.0.1:8765';
const DEFAULT_LIMIT = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_AGENT_CONNECT_TIMEOUT_MS = 75000;
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 60000;
const DEFAULT_IP_TIMEOUT_MS = 20000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 15000;
const DEFAULT_WAIT_STEP_MS = 1000;
const DEFAULT_ROUND_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_NIC_NAME = 'VPN2';
const DEFAULT_PREFERRED_COUNTRIES = ['KR', 'JP'];
const DEFAULT_PREFERRED_PORTS = [443, 995, 1698, 5555, 992, 1194];
const PROBE_ACCOUNT_PREFIX = 'VPNLATEST-';

function parseArgs(argv = []) {
  const options = {
    limit: DEFAULT_LIMIT,
    nicName: DEFAULT_NIC_NAME,
    preferredCountries: [...DEFAULT_PREFERRED_COUNTRIES],
    preferredPorts: [...DEFAULT_PREFERRED_PORTS],
    keepSuccess: false,
    continuous: false,
    intervalMs: DEFAULT_ROUND_INTERVAL_MS,
    rounds: 1,
    viaAgent: false,
    agentBaseUrl: DEFAULT_AGENT_BASE_URL,
    authToken: '',
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
      continue;
    }

    if (arg === '--keep-success') {
      options.keepSuccess = true;
      continue;
    }

    if (arg === '--continuous') {
      options.continuous = true;
      options.rounds = 0;
      continue;
    }

    if (arg.startsWith('--interval-ms=')) {
      options.intervalMs = Math.max(
        DEFAULT_WAIT_STEP_MS,
        Number.parseInt(arg.slice('--interval-ms='.length), 10) || DEFAULT_ROUND_INTERVAL_MS,
      );
      continue;
    }

    if (arg.startsWith('--rounds=')) {
      options.rounds = Math.max(0, Number.parseInt(arg.slice('--rounds='.length), 10) || 0);
      continue;
    }

    if (arg === '--via-agent') {
      options.viaAgent = true;
      continue;
    }

    if (arg.startsWith('--agent-base-url=')) {
      options.agentBaseUrl = String(arg.slice('--agent-base-url='.length) || DEFAULT_AGENT_BASE_URL).trim() || DEFAULT_AGENT_BASE_URL;
      continue;
    }

    if (arg.startsWith('--auth-token=')) {
      options.authToken = String(arg.slice('--auth-token='.length) || '').trim();
    }
  }

  return options;
}

function buildRandomSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return BigInt(`0x${[...bytes].map(value => value.toString(16).padStart(2, '0')).join('')}`).toString(10);
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

async function resolveUsableNicName(cli, preferredNicName) {
  const nicRows = await cli.listNics();
  const preferred = nicRows.find(row => row.name === preferredNicName && /enabled/i.test(row.status));
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

function isProbeAccountName(name = '') {
  return String(name || '').trim().toUpperCase().startsWith(PROBE_ACCOUNT_PREFIX);
}

function isNotConnectedAccountStatusError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('error code: 37') || message.includes('not connected');
}

async function findAccountByName(cli, accountName) {
  const accounts = await cli.listAccounts();
  return accounts.find(row => row.name === accountName) || null;
}

async function waitForAccountState(cli, accountName, expectedKinds = [], timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS) {
  const expected = new Set(expectedKinds);
  const startedAt = Date.now();
  let lastStateText = '';

  while ((Date.now() - startedAt) < timeoutMs) {
    const account = await findAccountByName(cli, accountName);
    if (!account) {
      if (expected.has('MISSING')) {
        return {
          name: accountName,
          statusKind: 'MISSING',
          statusText: 'missing',
        };
      }

      lastStateText = 'MISSING';
      await wait(DEFAULT_WAIT_STEP_MS);
      continue;
    }

    lastStateText = account.statusText || account.statusKind || 'UNKNOWN';
    if (expected.has(account.statusKind)) {
      return account;
    }

    await wait(DEFAULT_WAIT_STEP_MS);
  }

  throw new Error(`계정 상태 timeout (${timeoutMs}ms, account=${accountName}, last=${lastStateText || '-'})`);
}

async function cleanupAccount(cli, observer, accountName, expectedPublicIp = '') {
  const existing = await findAccountByName(cli, accountName);
  if (!existing) {
    if (expectedPublicIp) {
      const current = await observer.getPublicIp({
        force: true,
        allowStale: false,
      });
      return {
        removed: true,
        currentIp: current.ip,
      };
    }

    return {
      removed: true,
      currentIp: '',
    };
  }

  try {
    await cli.disconnectAccount(accountName);
  } catch (error) {
    if (!isNotConnectedAccountStatusError(error)) {
      throw error;
    }
  }

  await waitForAccountState(cli, accountName, ['DISCONNECTED', 'MISSING'], DEFAULT_CLEANUP_TIMEOUT_MS);

  try {
    await cli.deleteAccount(accountName);
  } catch (error) {
    const account = await findAccountByName(cli, accountName);
    if (!account) {
      if (expectedPublicIp) {
        const current = await waitForIpRestore(observer, expectedPublicIp, DEFAULT_IP_TIMEOUT_MS);
        return {
          removed: true,
          currentIp: current.ip,
        };
      }

      return {
        removed: true,
        currentIp: '',
      };
    }

    throw error;
  }

  await waitForAccountState(cli, accountName, ['MISSING'], DEFAULT_CLEANUP_TIMEOUT_MS);

  if (!expectedPublicIp) {
    return {
      removed: true,
      currentIp: '',
    };
  }

  const current = await waitForIpRestore(observer, expectedPublicIp, DEFAULT_IP_TIMEOUT_MS);
  return {
    removed: true,
    currentIp: current.ip,
  };
}

async function cleanupProbeAccounts(cli, observer) {
  const accounts = await cli.listAccounts();
  const probeAccounts = accounts.filter(row => isProbeAccountName(row.name));

  for (const account of probeAccounts) {
    await cleanupAccount(cli, observer, account.name);
  }

  return probeAccounts.map(account => account.name);
}

async function assertNoForeignConnectedAccounts(cli) {
  const accounts = await cli.listAccounts();
  const foreignConnectedAccounts = accounts.filter((row) => {
    if (isProbeAccountName(row.name)) {
      return false;
    }

    return ['CONNECTED', 'CONNECTING'].includes(row.statusKind);
  });

  if (foreignConnectedAccounts.length === 0) {
    return;
  }

  const detail = foreignConnectedAccounts
    .map(row => `${row.name}:${row.statusText || row.statusKind}`)
    .join(', ');
  throw new Error(`다른 SoftEther 연결이 이미 살아있어서 probe를 시작할 수 없습니다 (${detail})`);
}

async function waitForConnected(cli, accountName, timeoutMs) {
  const startedAt = Date.now();
  let lastStateText = '';
  let lastStatusError = '';

  while ((Date.now() - startedAt) < timeoutMs) {
    const account = await findAccountByName(cli, accountName);
    if (!account) {
      lastStateText = 'MISSING';
      await wait(DEFAULT_WAIT_STEP_MS);
      continue;
    }

    lastStateText = account.statusText || account.statusKind || 'UNKNOWN';
    if (account.statusKind === 'CONNECTED') {
      try {
        return await cli.getAccountStatus(accountName);
      } catch (error) {
        if (!isNotConnectedAccountStatusError(error)) {
          throw error;
        }

        lastStatusError = String(error?.message || error || '').trim();
      }
    }

    await wait(DEFAULT_WAIT_STEP_MS);
  }

  const suffix = lastStatusError ? `, lastError=${lastStatusError}` : '';
  throw new Error(`연결 timeout (${timeoutMs}ms, last=${lastStateText || '-'}${suffix})`);
}

async function waitForIpChange(observer, beforeIp, timeoutMs) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const current = await observer.getPublicIp({
      force: true,
      allowStale: false,
    });
    if (current.ip && current.ip !== beforeIp) {
      return current;
    }
    await wait(DEFAULT_WAIT_STEP_MS);
  }

  throw new Error(`공인 IP 변경 timeout (${timeoutMs}ms, before=${beforeIp || '-'})`);
}

async function waitForIpRestore(observer, expectedIp, timeoutMs) {
  if (!expectedIp) {
    return observer.getPublicIp({
      force: true,
      allowStale: false,
    });
  }

  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const current = await observer.getPublicIp({
      force: true,
      allowStale: false,
    });
    if (current.ip === expectedIp) {
      return current;
    }
    await wait(DEFAULT_WAIT_STEP_MS);
  }

  throw new Error(`공인 IP 복구 timeout (${timeoutMs}ms, expected=${expectedIp})`);
}

async function probeCandidate(cli, observer, candidate, options = {}) {
  const nicName = await resolveUsableNicName(cli, options.nicName);
  const accountName = `${PROBE_ACCOUNT_PREFIX}${sanitizeManagedToken(candidate.ip)}-${candidate.selectedSslPort}`.slice(0, 63);
  const beforeIp = (await observer.getPublicIp({
    force: true,
    allowStale: false,
  })).ip;
  let result = {
    ok: false,
    accountName,
    beforeIp,
    afterIp: '',
    nicName,
    cleanupIp: '',
    error: '알 수 없는 오류',
  };

  await cleanupAccount(cli, observer, accountName, beforeIp);

  try {
    await cli.createAccount({
      name: accountName,
      serverHost: candidate.ip,
      serverPort: candidate.selectedSslPort,
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

    const accountStatus = await waitForConnected(cli, accountName, DEFAULT_CONNECT_TIMEOUT_MS);
    const afterIp = await waitForIpChange(observer, beforeIp, DEFAULT_IP_TIMEOUT_MS);

    result = {
      ok: true,
      accountName,
      beforeIp,
      afterIp: afterIp.ip,
      underlayProtocol: accountStatus.underlayProtocol,
      udpAccelerationActive: accountStatus.udpAccelerationActive,
      nicName,
      connectedAt: accountStatus.connectedAt,
      cleanupIp: '',
    };
  } catch (error) {
    result = {
      ok: false,
      accountName,
      beforeIp,
      afterIp: '',
      nicName,
      cleanupIp: '',
      error: String(error?.message || error || '알 수 없는 오류'),
    };
  } finally {
    if (!options.keepSuccess) {
      const cleanup = await cleanupAccount(cli, observer, accountName, beforeIp);
      await wait(DEFAULT_WAIT_STEP_MS);
      result.cleanupIp = cleanup.currentIp || '';
    }
  }

  return result;
}

function buildAgentProbeConfig(options = {}, candidate = {}) {
  return normalizeAgentConfig({
    agentBaseUrl: options.agentBaseUrl || DEFAULT_AGENT_BASE_URL,
    authToken: options.authToken || '',
    connectionMode: CONNECTION_MODE.SOFTETHER_VPNGATE_RAW,
    profileId: `probe-agent-${sanitizeManagedToken(candidate.ip)}-${candidate.selectedSslPort}`.slice(0, 63),
    selectedRelayId: candidate.id,
    selectedSslPort: candidate.selectedSslPort,
    relaySnapshot: {
      id: candidate.id,
      fqdn: candidate.fqdn,
      ip: candidate.ip,
      sslPorts: candidate.portAttempts,
      udpPort: 0,
      hostUniqueKey: candidate.hostUniqueKey,
    },
    requestTimeoutMs: DEFAULT_IP_TIMEOUT_MS,
    actionTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
  });
}

async function getAgentStatusSafe(agentConfig) {
  const response = await getVpnStatusViaAgent(agentConfig, {
    timeoutMs: agentConfig.requestTimeoutMs,
  });
  return response?.data || {};
}

async function waitForAgentConnected(agentConfig, timeoutMs, options = {}) {
  const startedAt = Date.now();
  const expectedOperationId = String(options.operationId || '').trim();
  const pollIntervalMs = Math.max(1, Number.parseInt(String(options.pollIntervalMs || DEFAULT_WAIT_STEP_MS), 10) || DEFAULT_WAIT_STEP_MS);
  const statusFetcher = typeof options.statusFetcher === 'function'
    ? options.statusFetcher
    : getAgentStatusSafe;
  let lastPhase = '';
  let lastError = '';
  let sawExpectedConnectOperation = false;

  while ((Date.now() - startedAt) < timeoutMs) {
    let status;
    try {
      status = await statusFetcher(agentConfig);
    } catch (error) {
      lastError = String(error?.message || error || '').trim();
      await wait(pollIntervalMs);
      continue;
    }

    lastPhase = String(status.phase || '').trim();
    lastError = String(status.lastErrorMessage || status.error || '').trim();
    const currentOperationId = String(status.operationId || '').trim();

    if (expectedOperationId && currentOperationId === expectedOperationId) {
      sawExpectedConnectOperation = true;
    }

    if (lastPhase === 'CONNECTED') {
      return status;
    }

    if (lastPhase === 'IDLE' && expectedOperationId) {
      const operationFinished = currentOperationId === '' || currentOperationId !== expectedOperationId;
      if (operationFinished || sawExpectedConnectOperation) {
        throw new Error(lastError || 'local agent가 연결 도중 IDLE로 복귀했습니다.');
      }
    }

    if (lastPhase === 'ERROR') {
      throw new Error(lastError || 'local agent phase ERROR');
    }

    await wait(pollIntervalMs);
  }

  throw new Error(`agent 연결 timeout (${timeoutMs}ms, lastPhase=${lastPhase || '-'}, lastError=${lastError || '-'})`);
}

async function waitForAgentIdle(agentConfig, timeoutMs) {
  const startedAt = Date.now();
  let lastPhase = '';
  let lastError = '';

  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      const status = await getAgentStatusSafe(agentConfig);
      lastPhase = String(status.phase || '').trim();
      lastError = String(status.lastErrorMessage || status.error || '').trim();

      if (lastPhase === 'IDLE') {
        return status;
      }
    } catch (error) {
      lastError = String(error?.message || error || '').trim();
    }

    await wait(DEFAULT_WAIT_STEP_MS);
  }

  throw new Error(`agent idle timeout (${timeoutMs}ms, lastPhase=${lastPhase || '-'}, lastError=${lastError || '-'})`);
}

async function ensureAgentReachable(agentConfig) {
  const response = await getAgentHealthViaAgent(agentConfig, {
    timeoutMs: agentConfig.requestTimeoutMs,
  });
  const data = response?.data || {};
  if (data.ok !== true) {
    throw new Error(String(data.message || 'local agent health 확인 실패'));
  }
}

async function safeAgentDisconnect(agentConfig) {
  try {
    await disconnectVpnViaAgent(agentConfig, {
      timeoutMs: agentConfig.actionTimeoutMs,
    });
  } catch {
    // ignore
  }
}

async function probeCandidateViaAgent(observer, candidate, options = {}) {
  const agentConfig = buildAgentProbeConfig(options, candidate);
  const beforeIp = (await observer.getPublicIp({
    force: true,
    allowStale: false,
  })).ip;
  let result = {
    ok: false,
    accountName: '',
    beforeIp,
    afterIp: '',
    nicName: '',
    cleanupIp: '',
    error: '알 수 없는 오류',
  };

  await ensureAgentReachable(agentConfig);
  await safeAgentDisconnect(agentConfig);
  try {
    await waitForAgentIdle(agentConfig, DEFAULT_AGENT_IDLE_TIMEOUT_MS);
  } catch {
    // 이전 라운드 정리가 늦는 경우 한 번 더 connect 시도 전 정리 기회를 준다.
  }

  try {
    const response = await connectVpnViaAgent(agentConfig, {
      timeoutMs: agentConfig.actionTimeoutMs,
    });
    if (response?.accepted === false) {
      throw new Error(String(response?.data?.message || 'local agent가 연결 요청을 거부했습니다.'));
    }

    const status = await waitForAgentConnected(agentConfig, DEFAULT_AGENT_CONNECT_TIMEOUT_MS, {
      operationId: String(response?.data?.operationId || '').trim(),
    });
    const afterIp = await waitForIpChange(observer, beforeIp, DEFAULT_IP_TIMEOUT_MS);

    result = {
      ok: true,
      accountName: String(status.activeAccountName || '').trim(),
      beforeIp,
      afterIp: afterIp.ip,
      nicName: String(status.activeAdapterName || '').trim(),
      cleanupIp: '',
      underlayProtocol: String(status.underlayProtocol || '').trim(),
      udpAccelerationActive: Boolean(status.udpAccelerationActive),
      connectedAt: String(status.connectedAt || '').trim(),
      phase: String(status.phase || '').trim(),
    };
  } catch (error) {
    result = {
      ok: false,
      accountName: '',
      beforeIp,
      afterIp: '',
      nicName: '',
      cleanupIp: '',
      error: String(error?.message || error || '알 수 없는 오류'),
    };
  } finally {
    if (!options.keepSuccess) {
      try {
        await safeAgentDisconnect(agentConfig);
        await waitForAgentIdle(agentConfig, DEFAULT_AGENT_IDLE_TIMEOUT_MS);
        const restored = await waitForIpRestore(observer, beforeIp, DEFAULT_IP_TIMEOUT_MS);
        result.cleanupIp = restored.ip;
      } catch (error) {
        const cleanupMessage = String(error?.message || error || 'agent cleanup 실패');
        const current = await observer.getPublicIp({
          force: true,
          allowStale: false,
        });
        result.cleanupIp = current.ip || '';
        if (result.ok) {
          result.ok = false;
          result.error = `cleanup 실패 - ${cleanupMessage}`;
        } else if (result.error) {
          result.error = `${result.error} / cleanup 실패 - ${cleanupMessage}`;
        } else {
          result.error = `cleanup 실패 - ${cleanupMessage}`;
        }
      }
    }
  }

  return result;
}

async function runProbeRound(cli, observer, options = {}, roundNumber = 1) {
  await assertNoForeignConnectedAccounts(cli);
  const removedProbeAccounts = await cleanupProbeAccounts(cli, observer);
  if (removedProbeAccounts.length > 0) {
    console.log(`[probe][round ${roundNumber}] stale cleanup: ${removedProbeAccounts.join(', ')}`);
  }

  const hosts = await fetchLatestHosts();
  const candidates = selectCandidates(hosts, options);

  console.log(`[probe][round ${roundNumber}] latest hosts=${hosts.length}, selected candidates=${candidates.length}`);
  for (const [index, candidate] of candidates.entries()) {
    console.log(`[probe][round ${roundNumber}] candidate ${index + 1}/${candidates.length}: ${candidate.ip}:${candidate.selectedSslPort} ${candidate.fqdn || candidate.hostName || '-'} ${candidate.countryShort} score=${candidate.score} attempts=${candidate.portAttempts.join('/')}`);
    const result = options.viaAgent
      ? await probeCandidateViaAgent(observer, candidate, options)
      : await probeCandidate(cli, observer, candidate, options);
    if (result.ok) {
      const cleanupText = options.keepSuccess ? 'kept' : `restored=${result.cleanupIp || result.beforeIp || '-'}`;
      console.log(`[probe][round ${roundNumber}] success: ${candidate.ip}:${candidate.selectedSslPort} before=${result.beforeIp} after=${result.afterIp} nic=${result.nicName} udpAccel=${result.udpAccelerationActive} cleanup=${cleanupText}`);
    } else {
      const cleanupText = options.keepSuccess ? 'kept' : `restored=${result.cleanupIp || result.beforeIp || '-'}`;
      console.log(`[probe][round ${roundNumber}] fail: ${candidate.ip}:${candidate.selectedSslPort} error=${result.error} cleanup=${cleanupText}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cli = new SoftEtherCli();
  const observer = new NetworkObserver();
  const totalRounds = options.continuous ? (options.rounds > 0 ? options.rounds : Number.POSITIVE_INFINITY) : 1;

  let roundNumber = 1;
  while (roundNumber <= totalRounds) {
    try {
      await runProbeRound(cli, observer, options, roundNumber);
    } catch (error) {
      console.error(`[probe][round ${roundNumber}] fatal: ${error?.message || error}`);
    }

    if (!options.continuous || roundNumber >= totalRounds) {
      break;
    }

    console.log(`[probe] next round in ${options.intervalMs}ms`);
    await wait(options.intervalMs);
    roundNumber += 1;
  }
}

export {
  buildPortAttemptList,
  buildCandidate,
  buildAgentProbeConfig,
  waitForAgentConnected,
};

function isMainModule() {
  const entry = String(process.argv[1] || '').trim();
  if (!entry) {
    return false;
  }

  return entry === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error('[probe] fatal:', error?.message || error);
    process.exitCode = 1;
  });
}

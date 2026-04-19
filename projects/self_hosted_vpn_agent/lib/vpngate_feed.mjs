import { randomBytes } from 'node:crypto';

import { decodeVpnGateDatBuffer } from '../../../features/vpngate-prefix/dat-decode.js';

const OFFICIAL_DAT_BASE_URL = 'http://xd.x1.client.api.vpngate2.jp/api/';
const OFFICIAL_DAT_FETCH_TIMEOUT_MS = 15000;
const DEFAULT_PREFERRED_COUNTRIES = ['KR', 'JP'];
const DEFAULT_PREFERRED_PORTS = [443, 995, 1698, 5555, 992, 1194];

function buildRandomSessionId() {
  return BigInt(`0x${randomBytes(8).toString('hex')}`).toString(10);
}

async function fetchOfficialVpnGateRelays(options = {}) {
  const hosts = await fetchOfficialVpnGateHosts();
  return selectRelayCandidates(hosts, {
    limit: Number.parseInt(String(options.limit || 3), 10) || 3,
    preferredCountries: normalizeCountryList(options.preferredCountries),
    preferredPorts: normalizePortList(options.preferredPorts, DEFAULT_PREFERRED_PORTS),
  });
}

async function fetchOfficialVpnGateRelayCatalog(options = {}) {
  const hosts = await fetchOfficialVpnGateHosts();
  return buildRelayCatalog(hosts, options);
}

async function fetchOfficialVpnGateHosts() {
  const sessionId = buildRandomSessionId();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OFFICIAL_DAT_FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${OFFICIAL_DAT_BASE_URL}?session_id=${sessionId}`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: '*/*',
      },
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
  return Array.isArray(decoded?.feed?.hosts) ? decoded.feed.hosts : [];
}

function buildRelayCatalog(hosts = [], options = {}) {
  const preferredCountries = normalizeCountryList(options.preferredCountries);
  const preferredPorts = normalizePortList(options.preferredPorts, DEFAULT_PREFERRED_PORTS);
  const limit = Math.max(1, Number.parseInt(String(options.limit || hosts.length || 1), 10) || hosts.length || 1);
  const candidates = [];
  const seen = new Set();

  for (const host of hosts) {
    const relay = buildCandidate(host, {
      preferredCountries,
      preferredPorts,
    });
    if (!relay) {
      continue;
    }

    const dedupeKey = `${relay.id || relay.ip || relay.fqdn}:${relay.selectedSslPort}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    candidates.push(relay);
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

  const relays = candidates.slice(0, limit);

  return {
    totalHosts: hosts.length,
    usableRelayCount: candidates.length,
    relays,
  };
}

function selectRelayCandidates(hosts = [], options = {}) {
  const candidates = [];
  const seen = new Set();

  for (const host of hosts) {
    const candidate = buildCandidate(host, options);
    if (!candidate) {
      continue;
    }

    const dedupeKey = `${candidate.ip}:${candidate.selectedSslPort}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
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

  return candidates.slice(0, Math.max(1, Number.parseInt(String(options.limit || 3), 10) || 3));
}

function buildCandidate(host = {}, options = {}) {
  const sslPorts = parseSslPorts(host);
  const preferredPorts = normalizePortList(options.preferredPorts, DEFAULT_PREFERRED_PORTS);
  const selectedSslPort = choosePreferredPort(sslPorts, preferredPorts);
  if (!host?.IP || !selectedSslPort) {
    return null;
  }

  const preferredCountries = normalizeCountryList(options.preferredCountries);
  const countryShort = String(host.CountryShort || '').trim().toUpperCase();
  const preferredCountryIndex = preferredCountries.indexOf(countryShort);
  const preferredPortIndex = preferredPorts.indexOf(selectedSslPort);

  return {
    id: String(host.ID || `${host.IP}:${selectedSslPort}`),
    ip: String(host.IP || '').trim(),
    fqdn: String(host.Fqdn || '').trim(),
    hostName: String(host.HostName || '').trim(),
    hostUniqueKey: String(host.HostUniqueKey || '').trim().toUpperCase(),
    udpPort: normalizePort(host.UdpPort, 0),
    countryShort,
    countryFull: String(host.CountryFull || '').trim(),
    score: Number(host.Score || 0),
    verifyDate: Number(host.VerifyDate || 0),
    selectedSslPort,
    sslPorts,
    preferredCountryRank: preferredCountryIndex === -1 ? 999 : preferredCountryIndex,
    preferredPortRank: preferredPortIndex === -1 ? 999 : preferredPortIndex,
  };
}

function parseSslPorts(host = {}) {
  return String(host?.SslPorts || '')
    .split(/\s+/)
    .map(value => normalizePort(value, 0))
    .filter(Boolean);
}

function choosePreferredPort(ports = [], preferredPorts = []) {
  for (const preferredPort of preferredPorts) {
    if (ports.includes(preferredPort)) {
      return preferredPort;
    }
  }

  return ports[0] || 0;
}

function normalizeCountryList(value) {
  const normalized = Array.isArray(value)
    ? value
    : DEFAULT_PREFERRED_COUNTRIES;

  return normalized
    .map(item => String(item || '').trim().toUpperCase())
    .filter(Boolean);
}

function normalizePortList(value, fallback = []) {
  const rawValues = Array.isArray(value)
    ? value
    : fallback;
  const ports = [];
  const seen = new Set();

  for (const rawValue of rawValues) {
    const port = normalizePort(rawValue, 0);
    if (!port || seen.has(port)) {
      continue;
    }
    seen.add(port);
    ports.push(port);
  }

  return ports;
}

function normalizePort(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }

  return parsed;
}

export {
  buildRelayCatalog,
  DEFAULT_PREFERRED_COUNTRIES,
  DEFAULT_PREFERRED_PORTS,
  fetchOfficialVpnGateRelayCatalog,
  fetchOfficialVpnGateRelays,
};

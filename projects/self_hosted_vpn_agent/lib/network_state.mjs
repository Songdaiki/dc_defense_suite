import { execFile } from 'node:child_process';
import https from 'node:https';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WINDOWS_COMMAND_TIMEOUT_MS = 10000;
const WINDOWS_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024 * 20;
const PUBLIC_IP_TIMEOUT_MS = 2000;
const LOCAL_SNAPSHOT_TTL_MS = 1500;
const PUBLIC_IP_TTL_MS = 5000;
const EMPTY_PUBLIC_IP = Object.freeze({
  provider: '',
  ip: '',
});

class NetworkObserver {
  constructor(options = {}) {
    this.localSnapshotTtlMs = normalizePositiveInteger(options.localSnapshotTtlMs, LOCAL_SNAPSHOT_TTL_MS);
    this.publicIpTtlMs = normalizePositiveInteger(options.publicIpTtlMs, PUBLIC_IP_TTL_MS);
    this.localSnapshotCache = null;
    this.localSnapshotPromise = null;
    this.publicIpCache = null;
    this.publicIpPromise = null;
  }

  async getLocalSnapshot(options = {}) {
    const force = options.force === true;
    if (!force && isFreshCache(this.localSnapshotCache, this.localSnapshotTtlMs)) {
      return this.localSnapshotCache.value;
    }

    if (this.localSnapshotPromise) {
      return this.localSnapshotPromise;
    }

    this.localSnapshotPromise = collectLocalSnapshot()
      .then((value) => {
        this.localSnapshotCache = {
          observedAtMs: Date.now(),
          value,
        };
        return value;
      })
      .finally(() => {
        this.localSnapshotPromise = null;
      });

    return this.localSnapshotPromise;
  }

  async getPublicIp(options = {}) {
    const force = options.force === true;
    const allowStale = options.allowStale !== false;
    const allowEmpty = options.allowEmpty === true;

    if (!force && isFreshCache(this.publicIpCache, this.publicIpTtlMs)) {
      return this.publicIpCache.value;
    }

    if (this.publicIpPromise) {
      if (allowStale && this.publicIpCache) {
        return this.publicIpCache.value;
      }

      if (allowEmpty) {
        return this.publicIpCache?.value || EMPTY_PUBLIC_IP;
      }

      return this.publicIpPromise;
    }

    this.publicIpPromise = detectPublicIp()
      .then((value) => {
        this.publicIpCache = {
          observedAtMs: Date.now(),
          value,
        };
        return value;
      })
      .finally(() => {
        this.publicIpPromise = null;
      });

    if (allowStale && this.publicIpCache) {
      return this.publicIpCache.value;
    }

    if (allowEmpty) {
      return this.publicIpCache?.value || EMPTY_PUBLIC_IP;
    }

    return this.publicIpPromise;
  }
}

function isFreshCache(cache, ttlMs) {
  return Boolean(cache && (Date.now() - cache.observedAtMs) < ttlMs);
}

async function runWindowsCommand(commandText) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', commandText], {
    encoding: 'utf8',
    timeout: WINDOWS_COMMAND_TIMEOUT_MS,
    maxBuffer: WINDOWS_COMMAND_MAX_BUFFER_BYTES,
  });

  return String(stdout || '');
}

async function collectLocalSnapshot() {
  const adapterScript = `
$ErrorActionPreference = 'Stop'
Get-NetAdapter |
Select-Object Name, InterfaceDescription, InterfaceIndex, Status, MacAddress, LinkSpeed |
ConvertTo-Json -Depth 4
`.trim();

  const ipConfigScript = `
$ErrorActionPreference = 'Stop'
Get-NetIPConfiguration |
Select-Object InterfaceAlias, InterfaceIndex, IPv4Address, IPv4DefaultGateway, DNSServer |
ConvertTo-Json -Depth 6
`.trim();

  const ipv4RouteScript = `
$ErrorActionPreference = 'Stop'
Get-NetRoute -AddressFamily IPv4 |
Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } |
Sort-Object RouteMetric, InterfaceMetric |
Select-Object ifIndex, InterfaceAlias, NextHop, RouteMetric, InterfaceMetric, DestinationPrefix |
ConvertTo-Json -Depth 4
`.trim();

  const ipv6RouteScript = `
$ErrorActionPreference = 'Stop'
Get-NetRoute -AddressFamily IPv6 |
Where-Object { $_.DestinationPrefix -eq '::/0' } |
Sort-Object RouteMetric, InterfaceMetric |
Select-Object ifIndex, InterfaceAlias, NextHop, RouteMetric, InterfaceMetric, DestinationPrefix |
ConvertTo-Json -Depth 4
`.trim();

  const [adaptersRaw, ipConfigsRaw, ipv4RoutesRaw, ipv6RoutesRaw] = await Promise.all([
    runWindowsCommand(adapterScript),
    runWindowsCommand(ipConfigScript),
    runWindowsCommand(ipv4RouteScript),
    runWindowsCommand(ipv6RouteScript),
  ]);

  const adapters = ensureArray(parseWindowsJson(adaptersRaw));
  const ipConfigs = ensureArray(parseWindowsJson(ipConfigsRaw));
  const ipv4Routes = ensureArray(parseWindowsJson(ipv4RoutesRaw));
  const ipv6Routes = ensureArray(parseWindowsJson(ipv6RoutesRaw));

  const primaryIpv4Route = normalizeRoute(ipv4Routes[0] || {});
  const primaryIpv6Route = normalizeRoute(ipv6Routes[0] || {});

  return {
    observedAt: new Date().toISOString(),
    adapters,
    ipConfigs,
    primaryIpv4Route,
    primaryIpv6Route,
    ipv4DefaultRouteKey: buildRouteKey(primaryIpv4Route),
    ipv6DefaultRouteKey: buildRouteKey(primaryIpv6Route),
    dnsSignature: buildDnsSignature(ipConfigs),
  };
}

function parseWindowsJson(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return [];
  }

  return JSON.parse(normalized);
}

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === 'object') {
    return [value];
  }

  return [];
}

function normalizeRoute(route = {}) {
  return {
    ifIndex: Number.parseInt(String(route.ifIndex || route.InterfaceIndex || 0), 10) || 0,
    interfaceAlias: String(route.InterfaceAlias || '').trim(),
    nextHop: String(route.NextHop || '').trim(),
    routeMetric: Number.parseInt(String(route.RouteMetric || 0), 10) || 0,
    interfaceMetric: Number.parseInt(String(route.InterfaceMetric || 0), 10) || 0,
    destinationPrefix: String(route.DestinationPrefix || '').trim(),
  };
}

function buildRouteKey(route = {}) {
  if (!route || typeof route !== 'object') {
    return '';
  }

  return JSON.stringify({
    ifIndex: Number(route.ifIndex || 0),
    interfaceAlias: String(route.interfaceAlias || ''),
    nextHop: String(route.nextHop || ''),
    routeMetric: Number(route.routeMetric || 0),
    interfaceMetric: Number(route.interfaceMetric || 0),
    destinationPrefix: String(route.destinationPrefix || ''),
  });
}

function buildDnsSignature(ipConfigs = []) {
  const normalized = ensureArray(ipConfigs).map((item) => {
    const dnsServers = ensureArray(item?.DNSServer?.ServerAddresses || item?.DNSServer || [])
      .map(address => String(address || '').trim())
      .filter(Boolean)
      .sort();

    return {
      interfaceAlias: String(item.InterfaceAlias || '').trim(),
      interfaceIndex: Number.parseInt(String(item.InterfaceIndex || 0), 10) || 0,
      dnsServers,
    };
  });

  normalized.sort((left, right) => {
    if (left.interfaceIndex !== right.interfaceIndex) {
      return left.interfaceIndex - right.interfaceIndex;
    }

    return left.interfaceAlias.localeCompare(right.interfaceAlias);
  });

  return JSON.stringify(normalized);
}

function buildBaseline(localSnapshot = {}, publicIp = {}) {
  return {
    observedAt: String(localSnapshot.observedAt || new Date().toISOString()),
    ipv4DefaultRouteKey: String(localSnapshot.ipv4DefaultRouteKey || ''),
    ipv6DefaultRouteKey: String(localSnapshot.ipv6DefaultRouteKey || ''),
    dnsSignature: String(localSnapshot.dnsSignature || ''),
    publicIp: String(publicIp.ip || '').trim(),
    publicIpProvider: String(publicIp.provider || '').trim(),
  };
}

function compareBaseline(baseline = {}, currentLocalSnapshot = {}, currentPublicIp = {}) {
  return {
    publicIpBefore: String(baseline.publicIp || '').trim(),
    publicIpAfter: String(currentPublicIp.ip || '').trim(),
    currentPublicIp: String(currentPublicIp.ip || '').trim(),
    publicIpProvider: String(currentPublicIp.provider || '').trim(),
    ipv4DefaultRouteChanged: String(baseline.ipv4DefaultRouteKey || '') !== String(currentLocalSnapshot.ipv4DefaultRouteKey || ''),
    ipv6DefaultRouteChanged: String(baseline.ipv6DefaultRouteKey || '') !== String(currentLocalSnapshot.ipv6DefaultRouteKey || ''),
    dnsChanged: String(baseline.dnsSignature || '') !== String(currentLocalSnapshot.dnsSignature || ''),
  };
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': 'dc-defense-suite/self-hosted-vpn-agent',
        Accept: 'application/json,text/plain,*/*',
      },
      timeout: PUBLIC_IP_TIMEOUT_MS,
    }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('public ip timeout'));
    });
    request.on('error', reject);
  });
}

async function detectPublicIp() {
  const providers = [
    { name: 'api64.ipify.org', url: 'https://api64.ipify.org?format=json', json: true, field: 'ip' },
    { name: 'api.ipify.org', url: 'https://api.ipify.org?format=json', json: true, field: 'ip' },
    { name: 'ifconfig.me', url: 'https://ifconfig.me/ip', json: false, field: '' },
  ];

  const attempts = providers.map(async (provider) => {
    const response = await fetchText(provider.url);
    if (response.statusCode >= 400) {
      throw new Error(`HTTP ${response.statusCode}`);
    }

    if (provider.json) {
      const parsed = JSON.parse(response.body);
      const ip = String(parsed[provider.field] || '').trim();
      if (!ip) {
        throw new Error('ip empty');
      }
      return {
        provider: provider.name,
        ip,
      };
    }

    const ip = String(response.body || '').trim();
    if (!ip) {
      throw new Error('ip empty');
    }

    return {
      provider: provider.name,
      ip,
    };
  });

  try {
    return await Promise.any(attempts);
  } catch {
    return {
      provider: '',
      ip: '',
    };
  }
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(1, Number.parseInt(String(fallback ?? 1), 10) || 1);
  }

  return parsed;
}

export {
  NetworkObserver,
  buildBaseline,
  buildDnsSignature,
  buildRouteKey,
  collectLocalSnapshot,
  compareBaseline,
  ensureArray,
  normalizeRoute,
};

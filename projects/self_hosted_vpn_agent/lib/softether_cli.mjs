import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 15000;
const COMMAND_MAX_BUFFER_BYTES = 1024 * 1024 * 8;
const MANAGED_ACCOUNT_PREFIX = 'DCDSVPNGATE-';
const RAW_CATALOG_ACCOUNT_PREFIX = 'DCDSVPNRAWCACHE-';
const SOFTETHER_MIN_REGULATED_NIC_INDEX = 1;
const SOFTETHER_MAX_REGULATED_NIC_INDEX = 127;
const DEFAULT_VPNCMD_PATH = resolveDefaultVpncmdPath();

function resolveDefaultVpncmdPath() {
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\SoftEther VPN Client\\vpncmd.exe';
  }

  return '/mnt/c/Program Files/SoftEther VPN Client/vpncmd.exe';
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeManagedToken(value, fallback = 'relay') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function buildSoftEtherNicName(index) {
  const normalizedIndex = Number.parseInt(String(index || 0), 10);
  if (normalizedIndex <= 1) {
    return 'VPN';
  }

  return `VPN${normalizedIndex}`;
}

function normalizeSoftEtherMaxNicIndex(value, fallback = SOFTETHER_MAX_REGULATED_NIC_INDEX) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const normalizedFallback = Number.parseInt(String(fallback ?? SOFTETHER_MAX_REGULATED_NIC_INDEX), 10);
  if (!Number.isFinite(parsed) || parsed < 2) {
    return Number.isFinite(normalizedFallback) && normalizedFallback >= 2
      ? normalizedFallback
      : SOFTETHER_MAX_REGULATED_NIC_INDEX;
  }

  return parsed;
}

function isSoftEtherNicName(value, options = {}) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized.startsWith('VPN')) {
    return false;
  }

  const suffix = normalized.slice(3);
  if (!suffix) {
    return true;
  }

  if (/^\d+$/.test(suffix) === false) {
    return false;
  }

  const parsed = Number.parseInt(suffix, 10);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  const maxNicIndex = normalizeSoftEtherMaxNicIndex(options.maxNicIndex, SOFTETHER_MAX_REGULATED_NIC_INDEX);
  return parsed >= 2 && parsed <= maxNicIndex && String(parsed) === suffix;
}

function normalizePreferredSoftEtherNicName(value, fallback = 'VPN2', options = {}) {
  const normalized = String(value || '').trim().toUpperCase();
  if (isSoftEtherNicName(normalized, options)) {
    return normalized;
  }

  return String(fallback || 'VPN2').trim().toUpperCase();
}

function buildSoftEtherNicCandidateList(preferredName = '', options = {}) {
  const candidates = [];
  const seen = new Set();
  const maxNicIndex = normalizeSoftEtherMaxNicIndex(options.maxNicIndex, SOFTETHER_MAX_REGULATED_NIC_INDEX);
  const pushCandidate = (candidate) => {
    const normalized = String(candidate || '').trim().toUpperCase();
    if (!isSoftEtherNicName(normalized, { maxNicIndex }) || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    candidates.push(normalized);
  };

  if (isSoftEtherNicName(preferredName, { maxNicIndex })) {
    pushCandidate(preferredName);
  }

  for (let index = 2; index <= maxNicIndex; index += 1) {
    pushCandidate(buildSoftEtherNicName(index));
  }

  pushCandidate(buildSoftEtherNicName(SOFTETHER_MIN_REGULATED_NIC_INDEX));
  return candidates;
}

function buildManagedAccountName(relay = {}, selectedSslPort = 0) {
  const relayToken = relay.id || relay.ip || relay.fqdn || 'relay';
  const portToken = Number.parseInt(String(selectedSslPort || relay.selectedSslPort || 0), 10) || 0;
  const timeToken = Date.now().toString(36);
  return `${MANAGED_ACCOUNT_PREFIX}${sanitizeManagedToken(relayToken)}-${portToken || 'port'}-${timeToken}`.slice(0, 63);
}

function isManagedAccountName(value) {
  return String(value || '').trim().toUpperCase().startsWith(MANAGED_ACCOUNT_PREFIX);
}

function buildRawCatalogAccountName(relay = {}, selectedSslPort = 0) {
  const relayToken = relay.id || relay.ip || relay.fqdn || 'relay';
  const portToken = Number.parseInt(String(selectedSslPort || relay.selectedSslPort || 0), 10) || 0;
  return `${RAW_CATALOG_ACCOUNT_PREFIX}${sanitizeManagedToken(relayToken)}-${portToken || 'port'}`.slice(0, 63);
}

function isRawCatalogAccountName(value) {
  return String(value || '').trim().toUpperCase().startsWith(RAW_CATALOG_ACCOUNT_PREFIX);
}

function quoteVpncmdToken(value) {
  const stringValue = String(value ?? '');
  if (!stringValue) {
    return '""';
  }

  return `"${stringValue.replace(/"/g, '""')}"`;
}

function extractCsvText(stdout = '') {
  const lines = String(stdout || '')
    .replace(/\r/g, '')
    .split('\n');

  const startIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }

    if (trimmed.startsWith('Connected to VPN Client')) {
      return false;
    }

    if (trimmed.startsWith('VPN Client>')) {
      return false;
    }

    return trimmed.includes(',');
  });

  if (startIndex === -1) {
    return '';
  }

  return lines.slice(startIndex).join('\n').trim();
}

function parseCsvLine(line = '') {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (inQuotes) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      continue;
    }

    if (character === ',') {
      cells.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  cells.push(current);
  return cells;
}

function parseCsvTable(stdout = '') {
  const csvText = extractCsvText(stdout);
  if (!csvText) {
    return [];
  }

  const lines = csvText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return [];
  }

  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    header.forEach((columnName, columnIndex) => {
      row[columnName] = values[columnIndex] ?? '';
    });
    return row;
  });
}

function parseKeyValueTable(stdout = '') {
  const rows = parseCsvTable(stdout);
  const result = {};
  rows.forEach((row) => {
    const key = String(row.Item || '').trim();
    const value = String(row.Value || '').trim();
    if (!key) {
      return;
    }
    result[key] = value;
  });
  return result;
}

function classifyAccountListStatus(statusText = '') {
  const normalized = String(statusText || '').trim().toLowerCase();

  if (!normalized) {
    return 'UNKNOWN';
  }

  if (normalized.includes('disconnect') || normalized.includes('offline') || normalized.includes('not connected')) {
    return 'DISCONNECTED';
  }

  if (normalized.includes('retry') || normalized.includes('connecting') || normalized.includes('trying')) {
    return 'CONNECTING';
  }

  if (normalized.includes('connected')) {
    return 'CONNECTED';
  }

  return 'UNKNOWN';
}

function classifySessionStatus(sessionStatus = '') {
  const normalized = String(sessionStatus || '').trim().toLowerCase();
  if (!normalized) {
    return 'UNKNOWN';
  }

  if (normalized.includes('error') || normalized.includes('fail')) {
    return 'ERROR';
  }

  if (normalized.includes('established') || normalized.includes('completed')) {
    return 'CONNECTED';
  }

  if (normalized.includes('connect') || normalized.includes('retry')) {
    return 'CONNECTING';
  }

  return 'UNKNOWN';
}

function normalizePortText(value = '') {
  const match = String(value || '').match(/(\d{1,5})/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function parseAccountListServerEndpoint(value = '') {
  const trimmed = String(value || '').trim();
  const withoutSuffix = trimmed.replace(/\s+\(.*\)\s*$/, '').trim();
  if (!withoutSuffix) {
    return {
      endpointText: '',
      host: '',
      port: 0,
    };
  }

  const ipv6Match = withoutSuffix.match(/^\[([^\]]+)\]:(\d{1,5})$/);
  if (ipv6Match) {
    return {
      endpointText: withoutSuffix,
      host: ipv6Match[1],
      port: Number.parseInt(ipv6Match[2], 10) || 0,
    };
  }

  const lastColonIndex = withoutSuffix.lastIndexOf(':');
  if (lastColonIndex > 0 && /^\d{1,5}$/.test(withoutSuffix.slice(lastColonIndex + 1))) {
    return {
      endpointText: withoutSuffix,
      host: withoutSuffix.slice(0, lastColonIndex),
      port: Number.parseInt(withoutSuffix.slice(lastColonIndex + 1), 10) || 0,
    };
  }

  return {
    endpointText: withoutSuffix,
    host: withoutSuffix,
    port: 0,
  };
}

function extractUnderlayProtocol(statusMap = {}) {
  return String(
    statusMap['Physical Underlay Protocol']
    || '',
  ).trim();
}

function buildVpncmdFailureMessage(error, commandText) {
  const stdout = String(error?.stdout || '').trim();
  const stderr = String(error?.stderr || '').trim();
  const pieces = [stderr, stdout]
    .map(text => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const summary = pieces[0] || String(error?.message || 'vpncmd 실행 실패');
  return `vpncmd 실패 (${commandText}) - ${summary.slice(0, 240)}`;
}

function normalizeVpncmdCommand(command) {
  if (Array.isArray(command)) {
    return command
      .map(token => String(token ?? '').trim())
      .filter(Boolean);
  }

  const normalized = String(command || '').trim();
  return normalized ? [normalized] : [];
}

function stringifyVpncmdCommand(command = []) {
  const tokens = normalizeVpncmdCommand(command);
  return tokens.map((token) => (
    /\s/.test(token) ? `"${token}"` : token
  )).join(' ');
}

class SoftEtherCli {
  constructor(options = {}) {
    this.vpncmdPath = String(options.vpncmdPath || DEFAULT_VPNCMD_PATH).trim() || DEFAULT_VPNCMD_PATH;
    this.timeoutMs = normalizePositiveInteger(options.timeoutMs, COMMAND_TIMEOUT_MS);
    this.serializeCommands = options.serializeCommands !== false;
    this.queue = Promise.resolve();
  }

  async isAvailable() {
    return pathExists(this.vpncmdPath);
  }

  async run(command, options = {}) {
    const task = async () => {
      const commandTokens = normalizeVpncmdCommand(command);
      if (commandTokens.length === 0) {
        throw new Error('vpncmd 실행 실패 - 빈 명령');
      }

      const args = ['localhost', '/CLIENT'];
      if (options.csv === true) {
        args.push('/CSV');
      }
      args.push('/CMD', ...commandTokens);

      const commandText = stringifyVpncmdCommand(commandTokens);

      try {
        const result = await execFileAsync(this.vpncmdPath, args, {
          encoding: 'utf8',
          timeout: normalizePositiveInteger(options.timeoutMs, this.timeoutMs),
          maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        });

        return {
          stdout: String(result.stdout || ''),
          stderr: String(result.stderr || ''),
        };
      } catch (error) {
        throw new Error(buildVpncmdFailureMessage(error, commandText));
      }
    };

    if (!this.serializeCommands) {
      return task();
    }

    const previous = this.queue;
    let release = () => {};
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.queue = current;

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.queue === current) {
        this.queue = Promise.resolve();
      }
    }
  }

  async probeClient() {
    await this.run(['AccountList'], { csv: true });
    return true;
  }

  async listAccounts() {
    const { stdout } = await this.run(['AccountList'], { csv: true });
    return parseCsvTable(stdout).map((row) => ({
      ...parseAccountListServerEndpoint(row['VPN Server Hostname']),
      name: String(row['VPN Connection Setting Name'] || '').trim(),
      statusText: String(row.Status || '').trim(),
      statusKind: classifyAccountListStatus(row.Status),
      serverHost: String(row['VPN Server Hostname'] || '').trim(),
      virtualHub: String(row['Virtual Hub'] || '').trim(),
      nicName: String(row['Virtual Network Adapter Name'] || '').trim(),
    }));
  }

  async listNics() {
    const { stdout } = await this.run(['NicList'], { csv: true });
    return parseCsvTable(stdout).map((row) => ({
      name: String(row['Virtual Network Adapter Name'] || '').trim(),
      status: String(row.Status || '').trim(),
      macAddress: String(row['MAC Address'] || '').trim(),
      version: String(row.Version || '').trim(),
    }));
  }

  async getAccount(name) {
    const command = ['AccountGet', name];
    const { stdout } = await this.run(command, { csv: true });
    const data = parseKeyValueTable(stdout);
    return {
      name: String(data['VPN Connection Setting Name'] || name || '').trim(),
      serverHost: String(data['Destination VPN Server Host Name'] || '').trim(),
      serverPort: normalizePortText(data['Destination VPN Server Port Number']),
      virtualHub: String(data['Destination VPN Server Virtual Hub Name'] || '').trim(),
      nicName: String(data['Device Name Used for Connection'] || '').trim(),
      authType: String(data['Authentication Type'] || '').trim(),
      username: String(data['User Name'] || '').trim(),
      verifyServerCert: String(data['Verify Server Certificate'] || '').trim(),
      raw: data,
    };
  }

  async getAccountStatus(name) {
    const command = ['AccountStatusGet', name];
    const { stdout } = await this.run(command, { csv: true });
    const data = parseKeyValueTable(stdout);
    return {
      name: String(data['VPN Connection Setting Name'] || name || '').trim(),
      sessionStatus: String(data['Session Status'] || '').trim(),
      sessionStatusKind: classifySessionStatus(data['Session Status']),
      serverName: String(data['Server Name'] || '').trim(),
      portNumber: normalizePortText(data['Port Number']),
      serverProductName: String(data['Server Product Name'] || '').trim(),
      serverVersion: String(data['Server Version'] || '').trim(),
      serverBuild: String(data['Server Build'] || '').trim(),
      connectedAt: String(
        data['Current Session has been Established since']
        || data['First Session has been Established since']
        || data['Connection Started at']
        || '',
      ).trim(),
      underlayProtocol: extractUnderlayProtocol(data),
      udpAccelerationSupported: /yes/i.test(String(data['UDP Acceleration is Supported'] || '')),
      udpAccelerationActive: /yes/i.test(String(data['UDP Acceleration is Active'] || '')),
      raw: data,
    };
  }

  async createNic(nicName) {
    await this.run(['NicCreate', nicName]);
  }

  async createAccount(options = {}) {
    await this.run([
      'AccountCreate',
      options.name,
      `/SERVER:${options.serverHost}:${options.serverPort}`,
      `/HUB:${options.hubName}`,
      `/USERNAME:${options.username}`,
      `/NICNAME:${options.nicName}`,
    ]);
  }

  async setAccountAnonymous(name) {
    await this.run(['AccountAnonymousSet', name]);
  }

  async setAccountRetry(name, options = {}) {
    const numRetry = normalizeNonNegativeInteger(options.numRetry, 0);
    const retryInterval = normalizePositiveInteger(options.retryInterval, 15);
    await this.run(['AccountRetrySet', name, `/NUM:${numRetry}`, `/INTERVAL:${retryInterval}`]);
  }

  async disableServerCertCheck(name) {
    await this.run(['AccountServerCertDisable', name]);
  }

  async setAccountDetails(name, options = {}) {
    const maxTcp = normalizePositiveInteger(options.maxTcp, 1);
    const interval = normalizePositiveInteger(options.additionalConnectionInterval, 1);
    const ttl = normalizeNonNegativeInteger(options.connectionTtl, 0);
    const halfDuplex = options.halfDuplex === true ? 'yes' : 'no';
    const bridgeMode = options.bridgeMode === true ? 'yes' : 'no';
    const monitorMode = options.monitorMode === true ? 'yes' : 'no';
    const noTrack = options.noRoutingTracking === true ? 'yes' : 'no';
    const noQos = options.noQos === false ? 'no' : 'yes';
    await this.run([
      'AccountDetailSet',
      name,
      `/MAXTCP:${maxTcp}`,
      `/INTERVAL:${interval}`,
      `/TTL:${ttl}`,
      `/HALF:${halfDuplex}`,
      `/BRIDGE:${bridgeMode}`,
      `/MONITOR:${monitorMode}`,
      `/NOTRACK:${noTrack}`,
      `/NOQOS:${noQos}`,
    ]);
  }

  async connectAccount(name) {
    await this.run(['AccountConnect', name]);
  }

  async disconnectAccount(name) {
    await this.run(['AccountDisconnect', name]);
  }

  async deleteAccount(name) {
    await this.run(['AccountDelete', name]);
  }
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(1, Number.parseInt(String(fallback ?? 1), 10) || 1);
  }

  return parsed;
}

function normalizeNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, Number.parseInt(String(fallback ?? 0), 10) || 0);
  }

  return parsed;
}

export {
  DEFAULT_VPNCMD_PATH,
  MANAGED_ACCOUNT_PREFIX,
  RAW_CATALOG_ACCOUNT_PREFIX,
  buildRawCatalogAccountName,
  buildSoftEtherNicCandidateList,
  buildSoftEtherNicName,
  isSoftEtherNicName,
  isRawCatalogAccountName,
  normalizeSoftEtherMaxNicIndex,
  normalizePreferredSoftEtherNicName,
  SoftEtherCli,
  buildManagedAccountName,
  classifyAccountListStatus,
  classifySessionStatus,
  extractCsvText,
  isManagedAccountName,
  parseCsvLine,
  parseCsvTable,
  parseKeyValueTable,
  parseAccountListServerEndpoint,
  pathExists,
  quoteVpncmdToken,
  sanitizeManagedToken,
};

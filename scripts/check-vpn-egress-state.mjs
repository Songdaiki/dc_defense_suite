#!/usr/bin/env node
/**
 * VPN 출구 상태 관찰기
 *
 * 목적:
 *   - 사용자가 VPN 연결을 수동으로 올리기 전/후 상태를 저장한다.
 *   - 공인 IP, 기본 라우트, 네트워크 어댑터 변화만 비교해서
 *     "정말 출구가 바뀌었는지" 확인한다.
 *
 * 중요한 점:
 *   - 이 스크립트는 VPN 연결을 만들지 않는다.
 *   - 이미 사용자가 직접 연결한 상태를 관찰하고 비교만 한다.
 *
 * 예시:
 *   1) 연결 전 저장
 *      node scripts/check-vpn-egress-state.mjs --capture --label before
 *
 *   2) 사용자가 직접 VPN 연결
 *
 *   3) 연결 후 저장
 *      node scripts/check-vpn-egress-state.mjs --capture --label after
 *
 *   4) 비교
 *      node scripts/check-vpn-egress-state.mjs \
 *        --compare \
 *        --before data/vpn-egress-before.json \
 *        --after data/vpn-egress-after.json
 */

import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'data');

function printUsage() {
  console.log(`
사용법:
  node scripts/check-vpn-egress-state.mjs [옵션]

옵션:
  --capture                현재 네트워크 상태를 저장
  --compare                before / after JSON 두 개를 비교
  --watch                  기준 상태를 만든 뒤 변화가 생길 때까지 감시
  --label <name>           capture 출력 파일명에 붙일 라벨. 예: before, after
  --output <path>          capture 결과 저장 경로
  --before <path>          compare 입력 before JSON
  --after <path>           compare 입력 after JSON
  --interval <seconds>     watch 감시 주기. 기본값: 5
  --timeout <seconds>      watch 최대 대기 시간. 기본값: 300
  --help                   도움말

예시:
  node scripts/check-vpn-egress-state.mjs --capture --label before
  node scripts/check-vpn-egress-state.mjs --capture --label after
  node scripts/check-vpn-egress-state.mjs --compare --before data/vpn-egress-before.json --after data/vpn-egress-after.json
  node scripts/check-vpn-egress-state.mjs --watch --before data/vpn-egress-before.json --output data/vpn-egress-after.json --interval 3 --timeout 180
`.trim());
}

function parseArgs(argv) {
  const args = {
    capture: false,
    compare: false,
    watch: false,
    label: '',
    output: '',
    before: '',
    after: '',
    interval: '5',
    timeout: '300',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--capture':
        args.capture = true;
        break;
      case '--compare':
        args.compare = true;
        break;
      case '--watch':
        args.watch = true;
        break;
      case '--label':
        args.label = String(argv[++i] || '').trim();
        break;
      case '--output':
        args.output = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--before':
        args.before = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--after':
        args.after = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--interval':
        args.interval = String(argv[++i] || '').trim();
        break;
      case '--timeout':
        args.timeout = String(argv[++i] || '').trim();
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`알 수 없는 옵션: ${token}`);
    }
  }

  return args;
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildDefaultOutputPath(label = '') {
  const suffix = label ? `-${label}` : '';
  return path.join(DEFAULT_OUTPUT_DIR, `vpn-egress${suffix}.json`);
}

async function runWindowsCommand(file, commandText) {
  const { stdout, stderr } = await execFileAsync(file, ['-NoProfile', '-Command', commandText], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });

  return {
    stdout: stdout || '',
    stderr: stderr || '',
  };
}

async function runCmd(commandText) {
  const { stdout, stderr } = await execFileAsync('cmd.exe', ['/c', commandText], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });

  return {
    stdout: stdout || '',
    stderr: stderr || '',
  };
}

function fetchJson(urlString) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlString, {
      headers: {
        'User-Agent': 'dc-defense-suite/vpn-egress-check',
        'Accept': 'application/json,text/plain,*/*',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode || 0,
            body,
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
  });
}

async function detectPublicIp() {
  const providers = [
    { name: 'api64.ipify.org', url: 'https://api64.ipify.org?format=json', json: true, field: 'ip' },
    { name: 'api.ipify.org', url: 'https://api.ipify.org?format=json', json: true, field: 'ip' },
    { name: 'ifconfig.me', url: 'https://ifconfig.me/ip', json: false, field: '' },
  ];

  for (const provider of providers) {
    try {
      const response = await fetchJson(provider.url);
      if (response.statusCode >= 400) {
        continue;
      }

      if (provider.json) {
        const parsed = JSON.parse(response.body);
        const ip = String(parsed[provider.field] || '').trim();
        if (ip) {
          return { provider: provider.name, ip };
        }
      } else {
        const ip = response.body.trim();
        if (ip) {
          return { provider: provider.name, ip };
        }
      }
    } catch {
      // try next provider
    }
  }

  return {
    provider: '',
    ip: '',
  };
}

async function collectWindowsNetworkState() {
  const adapterScript = `
$ErrorActionPreference = 'Stop'
Get-NetAdapter |
Select-Object Name, InterfaceDescription, InterfaceIndex, Status, MacAddress, LinkSpeed |
ConvertTo-Json -Depth 4
`.trim();

  const ipConfigScript = `
$ErrorActionPreference = 'Stop'
Get-NetIPConfiguration |
Select-Object InterfaceAlias, InterfaceIndex, IPv4Address, IPv4DefaultGateway, DNSServer, NetAdapter |
ConvertTo-Json -Depth 6
`.trim();

  const ipv4DefaultRouteScript = `
$ErrorActionPreference = 'Stop'
Get-NetRoute -AddressFamily IPv4 |
Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } |
Sort-Object RouteMetric, InterfaceMetric |
Select-Object ifIndex, InterfaceAlias, NextHop, RouteMetric, InterfaceMetric, DestinationPrefix |
ConvertTo-Json -Depth 4
`.trim();

  const ipv6DefaultRouteScript = `
$ErrorActionPreference = 'Stop'
Get-NetRoute -AddressFamily IPv6 |
Where-Object { $_.DestinationPrefix -eq '::/0' } |
Sort-Object RouteMetric, InterfaceMetric |
Select-Object ifIndex, InterfaceAlias, NextHop, RouteMetric, InterfaceMetric, DestinationPrefix |
ConvertTo-Json -Depth 4
`.trim();

  const [adapters, ipConfigs, ipv4Routes, ipv6Routes, routePrint] = await Promise.all([
    runWindowsCommand('powershell.exe', adapterScript),
    runWindowsCommand('powershell.exe', ipConfigScript),
    runWindowsCommand('powershell.exe', ipv4DefaultRouteScript),
    runWindowsCommand('powershell.exe', ipv6DefaultRouteScript),
    runCmd('route print'),
  ]);

  return {
    adaptersRaw: adapters.stdout,
    ipConfigsRaw: ipConfigs.stdout,
    ipv4DefaultRoutesRaw: ipv4Routes.stdout,
    ipv6DefaultRoutesRaw: ipv6Routes.stdout,
    routePrintRaw: routePrint.stdout,
  };
}

function safeJsonParse(text, fallback) {
  if (!text || !text.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function pickLikelyVpnAdapters(adapters) {
  const keywords = [
    'vpn',
    'softether',
    'tap',
    'tun',
    'wireguard',
    'openvpn',
    'l2tp',
    'pptp',
    'ikev2',
    'tailscale',
  ];

  return adapters.filter((adapter) => {
    const haystack = `${adapter.Name || ''} ${adapter.InterfaceDescription || ''}`.toLowerCase();
    return keywords.some(keyword => haystack.includes(keyword));
  });
}

async function collectSnapshot(label = '') {
  const publicIp = await detectPublicIp();
  const windowsState = await collectWindowsNetworkState();

  const adapters = normalizeArray(safeJsonParse(windowsState.adaptersRaw, []));
  const ipConfigs = normalizeArray(safeJsonParse(windowsState.ipConfigsRaw, []));
  const ipv4DefaultRoutes = normalizeArray(safeJsonParse(windowsState.ipv4DefaultRoutesRaw, []));
  const ipv6DefaultRoutes = normalizeArray(safeJsonParse(windowsState.ipv6DefaultRoutesRaw, []));
  const likelyVpnAdapters = pickLikelyVpnAdapters(adapters);

  return {
    collectedAt: new Date().toISOString(),
    label,
    publicIp,
    network: {
      adapters,
      ipConfigs,
      ipv4DefaultRoutes,
      ipv6DefaultRoutes,
      likelyVpnAdapters,
      routePrintRaw: windowsState.routePrintRaw,
    },
  };
}

async function writeSnapshot(snapshot, outputPath) {
  await ensureParentDir(outputPath);
  await fs.writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

function printSnapshotSummary(snapshot, outputPath) {
  console.log('VPN 출구 상태 저장 완료');
  if (outputPath) {
    console.log(`- output: ${outputPath}`);
  }
  console.log(`- public_ip: ${snapshot.publicIp.ip || '-'}`);
  console.log(`- provider: ${snapshot.publicIp.provider || '-'}`);
  console.log(`- ipv4_default_routes: ${snapshot.network.ipv4DefaultRoutes.length}`);
  console.log(`- likely_vpn_adapters: ${snapshot.network.likelyVpnAdapters.map(item => item.Name).join(', ') || '-'}`);
}

async function captureState(args) {
  const outputPath = args.output || buildDefaultOutputPath(args.label);
  const snapshot = await collectSnapshot(args.label || '');
  await writeSnapshot(snapshot, outputPath);
  printSnapshotSummary(snapshot, outputPath);
}

function mapByKey(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return map;
}

function summarizeRoute(route) {
  return {
    ifIndex: route.ifIndex ?? route.InterfaceIndex ?? null,
    alias: route.InterfaceAlias || '',
    nextHop: route.NextHop || '',
    routeMetric: route.RouteMetric ?? null,
    interfaceMetric: route.InterfaceMetric ?? null,
    destinationPrefix: route.DestinationPrefix || '',
  };
}

function compareStates(before, after) {
  const beforeAdapters = normalizeArray(before.network?.adapters);
  const afterAdapters = normalizeArray(after.network?.adapters);
  const beforeRoutes = normalizeArray(before.network?.ipv4DefaultRoutes).map(summarizeRoute);
  const afterRoutes = normalizeArray(after.network?.ipv4DefaultRoutes).map(summarizeRoute);

  const beforeAdapterMap = mapByKey(beforeAdapters, item => `${item.InterfaceIndex}:${item.Name}`);
  const afterAdapterMap = mapByKey(afterAdapters, item => `${item.InterfaceIndex}:${item.Name}`);

  const adapterStatusChanges = [];
  for (const [key, beforeAdapter] of beforeAdapterMap.entries()) {
    const afterAdapter = afterAdapterMap.get(key);
    if (!afterAdapter) {
      continue;
    }

    if ((beforeAdapter.Status || '') !== (afterAdapter.Status || '')) {
      adapterStatusChanges.push({
        name: beforeAdapter.Name,
        interfaceIndex: beforeAdapter.InterfaceIndex,
        beforeStatus: beforeAdapter.Status || '',
        afterStatus: afterAdapter.Status || '',
      });
    }
  }

  const beforeRouteText = JSON.stringify(beforeRoutes);
  const afterRouteText = JSON.stringify(afterRoutes);

  return {
    beforePublicIp: before.publicIp?.ip || '',
    afterPublicIp: after.publicIp?.ip || '',
    publicIpChanged: (before.publicIp?.ip || '') !== (after.publicIp?.ip || ''),
    beforeIpv4DefaultRoutes: beforeRoutes,
    afterIpv4DefaultRoutes: afterRoutes,
    ipv4DefaultRouteChanged: beforeRouteText !== afterRouteText,
    adapterStatusChanges,
    beforeLikelyVpnAdapters: normalizeArray(before.network?.likelyVpnAdapters).map(item => item.Name),
    afterLikelyVpnAdapters: normalizeArray(after.network?.likelyVpnAdapters).map(item => item.Name),
  };
}

function printDiffSummary(diff) {
  console.log('VPN 출구 상태 비교');
  console.log(`- before_public_ip: ${diff.beforePublicIp || '-'}`);
  console.log(`- after_public_ip: ${diff.afterPublicIp || '-'}`);
  console.log(`- public_ip_changed: ${diff.publicIpChanged ? 'YES' : 'NO'}`);
  console.log(`- ipv4_default_route_changed: ${diff.ipv4DefaultRouteChanged ? 'YES' : 'NO'}`);
  console.log(`- before_likely_vpn_adapters: ${diff.beforeLikelyVpnAdapters.join(', ') || '-'}`);
  console.log(`- after_likely_vpn_adapters: ${diff.afterLikelyVpnAdapters.join(', ') || '-'}`);

  if (diff.adapterStatusChanges.length > 0) {
    console.log('- adapter_status_changes:');
    for (const item of diff.adapterStatusChanges) {
      console.log(`  - ${item.name} (#${item.interfaceIndex}): ${item.beforeStatus} -> ${item.afterStatus}`);
    }
  } else {
    console.log('- adapter_status_changes: -');
  }

  if (diff.publicIpChanged) {
    console.log('- 판정: 외부에서 보이는 공인 IP가 바뀌었습니다.');
  } else if (diff.ipv4DefaultRouteChanged) {
    console.log('- 판정: 공인 IP는 같지만 기본 라우트는 바뀌었습니다. split tunnel 이거나 출구 확인이 더 필요합니다.');
  } else {
    console.log('- 판정: 공인 IP와 기본 라우트 모두 큰 변화가 없습니다.');
  }
}

async function compareSnapshots(args) {
  if (!args.before || !args.after) {
    throw new Error('--compare 모드에서는 --before 와 --after 가 둘 다 필요합니다.');
  }

  const before = JSON.parse(await fs.readFile(args.before, 'utf8'));
  const after = JSON.parse(await fs.readFile(args.after, 'utf8'));
  const diff = compareStates(before, after);
  printDiffSummary(diff);
}

function parsePositiveNumber(rawValue, flagName, defaultValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flagName} 값이 올바르지 않습니다: ${rawValue}`);
  }
  return value || defaultValue;
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function loadOrCreateBaseline(args) {
  const baselinePath = args.before || buildDefaultOutputPath(args.label ? `${args.label}-before` : 'watch-before');

  if (await pathExists(baselinePath)) {
    const snapshot = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
    console.log('감시 기준 상태를 기존 파일에서 불러왔습니다.');
    console.log(`- baseline: ${baselinePath}`);
    console.log(`- baseline_public_ip: ${snapshot.publicIp?.ip || '-'}`);
    return { baselinePath, snapshot };
  }

  const snapshot = await collectSnapshot(args.label || 'watch-before');
  await writeSnapshot(snapshot, baselinePath);
  console.log('감시 기준 상태를 새로 저장했습니다.');
  printSnapshotSummary(snapshot, baselinePath);
  return { baselinePath, snapshot };
}

async function watchForChanges(args) {
  const intervalSeconds = parsePositiveNumber(args.interval, '--interval', 5);
  const timeoutSeconds = parsePositiveNumber(args.timeout, '--timeout', 300);
  const outputPath = args.output || buildDefaultOutputPath(args.label ? `${args.label}-after` : 'watch-after');
  const { baselinePath, snapshot: baseline } = await loadOrCreateBaseline(args);

  console.log('VPN 출구 변화 감시 시작');
  console.log(`- baseline: ${baselinePath}`);
  console.log(`- output_on_change: ${outputPath}`);
  console.log(`- interval_seconds: ${intervalSeconds}`);
  console.log(`- timeout_seconds: ${timeoutSeconds}`);
  console.log('- 안내: 지금 공식 클라이언트에서 서버 하나에 수동 연결하면 됩니다.');

  const startedAt = Date.now();
  let attempt = 0;

  while ((Date.now() - startedAt) < timeoutSeconds * 1000) {
    await sleep(intervalSeconds * 1000);
    attempt += 1;

    const current = await collectSnapshot(`${args.label || 'watch'}-attempt-${attempt}`);
    const diff = compareStates(baseline, current);

    console.log(`[${new Date().toISOString()}] check #${attempt}`);
    console.log(`- current_public_ip: ${current.publicIp.ip || '-'}`);
    console.log(`- public_ip_changed: ${diff.publicIpChanged ? 'YES' : 'NO'}`);
    console.log(`- ipv4_default_route_changed: ${diff.ipv4DefaultRouteChanged ? 'YES' : 'NO'}`);
    console.log(`- adapter_status_change_count: ${diff.adapterStatusChanges.length}`);

    if (diff.publicIpChanged || diff.ipv4DefaultRouteChanged) {
      await writeSnapshot(current, outputPath);
      console.log('변화를 감지했습니다. 현재 상태를 저장합니다.');
      printSnapshotSummary(current, outputPath);
      printDiffSummary(diff);
      return;
    }
  }

  console.log('시간 안에 공인 IP 또는 기본 라우트 변화가 감지되지 않았습니다.');
  process.exitCode = 2;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.capture && !args.compare && !args.watch)) {
    printUsage();
    return;
  }

  const enabledModes = [args.capture, args.compare, args.watch].filter(Boolean).length;
  if (enabledModes > 1) {
    throw new Error('--capture, --compare, --watch 중 하나만 사용할 수 있습니다.');
  }

  if (args.capture) {
    await captureState(args);
    return;
  }

  if (args.compare) {
    await compareSnapshots(args);
    return;
  }

  if (args.watch) {
    await watchForChanges(args);
  }
}

main().catch((error) => {
  console.error(`실패: ${error.message}`);
  process.exitCode = 1;
});

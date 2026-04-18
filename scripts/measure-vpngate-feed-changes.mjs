#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * VPNGate 목록 변화량 측정기
 *
 * 목적:
 *   1. 일정 시간 동안 일정 간격으로 공식 DAT feed를 다시 받는다.
 *   2. 매 회차 raw DAT / decoded JSON / unique IP 목록을 저장한다.
 *   3. 이전 성공 스냅샷과 비교해 "사라진 IP / 새로 생긴 IP"를 계산한다.
 *
 * 기본값:
 *   - 총 30분
 *   - 5분 간격
 *   - 즉시 1회 받고, 이후 간격마다 다시 받음
 *   - 30분 / 5분이면 총 7개 스냅샷(t=0, 5, 10, 15, 20, 25, 30)이 생긴다.
 *
 * 예시:
 *   1) 기본값 그대로
 *      node scripts/measure-vpngate-feed-changes.mjs
 *
 *   2) 결과 폴더 직접 지정
 *      node scripts/measure-vpngate-feed-changes.mjs \
 *        --output-dir data/vpngate-change-test
 *
 *   3) 빠른 로컬 테스트용
 *      node scripts/measure-vpngate-feed-changes.mjs \
 *        --duration-minutes 0.02 \
 *        --interval-minutes 0.01
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFile = promisify(execFileCallback);

const PROJECT_ROOT = path.resolve(process.cwd());
const DECODER_SCRIPT = path.resolve(PROJECT_ROOT, 'scripts', 'decode-vpngate-official-dat.mjs');
const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_INTERVAL_MINUTES = 5;

function printUsage() {
  console.log(`
사용법:
  node scripts/measure-vpngate-feed-changes.mjs [옵션]

옵션:
  --duration-minutes <number>   총 진행 시간(분), 기본값 30
  --interval-minutes <number>   새로고침 간격(분), 기본값 5
  --output-dir <path>           결과 저장 폴더
  --country-short <code>        특정 국가만 대상으로 변화량 계산 (예: KR)
  --help                        도움말

예시:
  node scripts/measure-vpngate-feed-changes.mjs
  node scripts/measure-vpngate-feed-changes.mjs --output-dir data/vpngate-change-test
  node scripts/measure-vpngate-feed-changes.mjs --duration-minutes 0.02 --interval-minutes 0.01
`.trim());
}

function parsePositiveNumber(rawValue, optionName) {
  const value = Number.parseFloat(String(rawValue ?? '').trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${optionName} 값이 올바르지 않습니다: ${rawValue}`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    durationMinutes: DEFAULT_DURATION_MINUTES,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    outputDir: '',
    countryShort: '',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--duration-minutes':
        args.durationMinutes = parsePositiveNumber(argv[++index], '--duration-minutes');
        break;
      case '--interval-minutes':
        args.intervalMinutes = parsePositiveNumber(argv[++index], '--interval-minutes');
        break;
      case '--output-dir':
        args.outputDir = path.resolve(PROJECT_ROOT, argv[++index]);
        break;
      case '--country-short':
        args.countryShort = String(argv[++index] || '').trim().toUpperCase();
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`알 수 없는 옵션: ${token}`);
    }
  }

  if (args.intervalMinutes > args.durationMinutes) {
    throw new Error('interval이 duration보다 클 수는 없습니다.');
  }

  return args;
}

function nowStampForFile(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function nowStampForDisplay(date = new Date()) {
  return date.toISOString();
}

function buildDefaultOutputDir() {
  return path.resolve(PROJECT_ROOT, 'data', `vpngate-change-test-${nowStampForFile()}`);
}

function sortStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function diffSets(previousSet, currentSet) {
  const appeared = [];
  const disappeared = [];
  const kept = [];

  for (const value of currentSet) {
    if (!previousSet.has(value)) {
      appeared.push(value);
    } else {
      kept.push(value);
    }
  }

  for (const value of previousSet) {
    if (!currentSet.has(value)) {
      disappeared.push(value);
    }
  }

  return {
    appeared: sortStrings(appeared),
    disappeared: sortStrings(disappeared),
    kept: sortStrings(kept),
  };
}

function countByCountry(hosts) {
  const counter = new Map();
  for (const host of hosts) {
    const code = String(host.CountryShort || '').trim() || 'UNKNOWN';
    counter.set(code, (counter.get(code) || 0) + 1);
  }
  return Object.fromEntries(
    [...counter.entries()].sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    }),
  );
}

function buildIpStats(hosts) {
  const ipList = hosts
    .map(host => String(host.IP || '').trim())
    .filter(Boolean);

  const uniqueIpSet = new Set(ipList);

  return {
    hostCount: hosts.length,
    ipList,
    uniqueIpSet,
    uniqueIpList: sortStrings(uniqueIpSet),
    duplicateIpCount: ipList.length - uniqueIpSet.size,
  };
}

function sanitizeHostList(decodedJson, countryShort) {
  const allHosts = Array.isArray(decodedJson?.feed?.hosts) ? decodedJson.feed.hosts : [];
  const filteredHosts = countryShort
    ? allHosts.filter(host => String(host.CountryShort || '').trim().toUpperCase() === countryShort)
    : allHosts;
  const krHosts = allHosts.filter(host => String(host.CountryShort || '').trim().toUpperCase() === 'KR');
  const selectedStats = buildIpStats(filteredHosts);
  const krStats = buildIpStats(krHosts);

  return {
    allHosts,
    filteredHosts,
    ipList: selectedStats.ipList,
    uniqueIpSet: selectedStats.uniqueIpSet,
    uniqueIpList: selectedStats.uniqueIpList,
    duplicateIpCount: selectedStats.duplicateIpCount,
    countryCounts: countByCountry(filteredHosts),
    allCountryCounts: countByCountry(allHosts),
    krHosts,
    krIpList: krStats.ipList,
    krUniqueIpSet: krStats.uniqueIpSet,
    krUniqueIpList: krStats.uniqueIpList,
    krDuplicateIpCount: krStats.duplicateIpCount,
  };
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
}

async function runDecoder({ jsonPath, rawPath }) {
  const args = [
    DECODER_SCRIPT,
    '--fetch',
    '--output',
    jsonPath,
    '--save-raw',
    rawPath,
  ];

  return execFile(process.execPath, args, {
    cwd: PROJECT_ROOT,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function buildSnapshotBaseName(index, totalSamples, capturedAt) {
  const order = String(index + 1).padStart(String(totalSamples).length, '0');
  return `snapshot-${order}-${nowStampForFile(capturedAt)}`;
}

function buildDiffBaseName(previousIndex, currentIndex, totalSamples) {
  const pad = String(totalSamples).length;
  const left = String(previousIndex + 1).padStart(pad, '0');
  const right = String(currentIndex + 1).padStart(pad, '0');
  return `diff-${left}-to-${right}`;
}

function createRunSummary({ args, sampleCount, outputDir }) {
  return {
    meta: {
      name: 'VPNGate Feed Change Measurement',
      generatedAt: new Date().toISOString(),
      durationMinutes: args.durationMinutes,
      intervalMinutes: args.intervalMinutes,
      sampleCount,
      outputDir,
      compareKey: 'IP',
      countryShortFilter: args.countryShort || '',
      note: args.countryShort
        ? `필터링된 ${args.countryShort} 목록 기준으로 변화량을 계산합니다.`
        : '전체 목록 기준으로 변화량을 계산합니다.',
    },
    samples: [],
    diffs: [],
    aggregates: {},
  };
}

function updateAggregates(summary) {
  const successfulSamples = summary.samples.filter(sample => sample.success);
  const allSeen = new Set();
  const allSeenKr = new Set();

  for (const sample of successfulSamples) {
    for (const ip of sample.uniqueIps) {
      allSeen.add(ip);
    }
    for (const ip of sample.krUniqueIps || []) {
      allSeenKr.add(ip);
    }
  }

  const firstSuccess = successfulSamples[0] || null;
  const lastSuccess = successfulSamples.at(-1) || null;

  let firstToLast = null;
  if (firstSuccess && lastSuccess) {
    const diff = diffSets(new Set(firstSuccess.uniqueIps), new Set(lastSuccess.uniqueIps));
    firstToLast = {
      firstSampleIndex: firstSuccess.index,
      lastSampleIndex: lastSuccess.index,
      appearedCount: diff.appeared.length,
      disappearedCount: diff.disappeared.length,
      keptCount: diff.kept.length,
      appearedIps: diff.appeared,
      disappearedIps: diff.disappeared,
    };
  }

  let firstToLastKr = null;
  if (firstSuccess && lastSuccess) {
    const krDiff = diffSets(
      new Set(firstSuccess.krUniqueIps || []),
      new Set(lastSuccess.krUniqueIps || []),
    );
    firstToLastKr = {
      firstSampleIndex: firstSuccess.index,
      lastSampleIndex: lastSuccess.index,
      appearedCount: krDiff.appeared.length,
      disappearedCount: krDiff.disappeared.length,
      keptCount: krDiff.kept.length,
      appearedIps: krDiff.appeared,
      disappearedIps: krDiff.disappeared,
    };
  }

  summary.aggregates = {
    successfulSampleCount: successfulSamples.length,
    failedSampleCount: summary.samples.length - successfulSamples.length,
    allSeenUniqueIpCount: allSeen.size,
    allSeenKrUniqueIpCount: allSeenKr.size,
    firstToLast,
    firstToLastKr,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const outputDir = args.outputDir || buildDefaultOutputDir();
  const durationMs = Math.round(args.durationMinutes * 60 * 1000);
  const intervalMs = Math.round(args.intervalMinutes * 60 * 1000);
  const sampleCount = Math.floor(durationMs / intervalMs) + 1;
  const summaryPath = path.join(outputDir, 'summary.json');

  await fs.mkdir(outputDir, { recursive: true });

  const summary = createRunSummary({ args, sampleCount, outputDir });
  await writeJson(summaryPath, summary);

  console.log(`VPNGate 변화량 측정을 시작합니다.`);
  console.log(`- output_dir: ${outputDir}`);
  console.log(`- duration_minutes: ${args.durationMinutes}`);
  console.log(`- interval_minutes: ${args.intervalMinutes}`);
  console.log(`- sample_count: ${sampleCount}`);
  if (args.countryShort) {
    console.log(`- country_filter: ${args.countryShort}`);
  }

  let previousSuccessfulSample = null;

  for (let index = 0; index < sampleCount; index += 1) {
    const capturedAt = new Date();
    const baseName = buildSnapshotBaseName(index, sampleCount, capturedAt);
    const snapshotJsonPath = path.join(outputDir, `${baseName}.json`);
    const rawDatPath = path.join(outputDir, `${baseName}.dat`);
    const uniqueIpsPath = path.join(outputDir, `${baseName}-ips.txt`);
    const krUniqueIpsPath = path.join(outputDir, `${baseName}-kr-ips.txt`);
    const snapshotMetaPath = path.join(outputDir, `${baseName}-meta.json`);

    const sampleRecord = {
      index,
      order: index + 1,
      capturedAt: nowStampForDisplay(capturedAt),
      success: false,
      snapshotJsonPath,
      rawDatPath,
      uniqueIpsPath,
      krUniqueIpsPath,
      snapshotMetaPath,
    };

    console.log(`[${index + 1}/${sampleCount}] 목록 새로고침 중...`);

    try {
      const execResult = await runDecoder({
        jsonPath: snapshotJsonPath,
        rawPath: rawDatPath,
      });

      const decoded = JSON.parse(await fs.readFile(snapshotJsonPath, 'utf8'));
      const sanitized = sanitizeHostList(decoded, args.countryShort);

      await writeText(uniqueIpsPath, `${sanitized.uniqueIpList.join('\n')}\n`);
      await writeText(krUniqueIpsPath, `${sanitized.krUniqueIpList.join('\n')}\n`);

      sampleRecord.success = true;
      sampleRecord.decoderStdout = execResult.stdout.trim();
      sampleRecord.decoderStderr = execResult.stderr.trim();
      sampleRecord.totalHostCount = sanitized.filteredHosts.length;
      sampleRecord.uniqueIpCount = sanitized.uniqueIpList.length;
      sampleRecord.duplicateIpCount = sanitized.duplicateIpCount;
      sampleRecord.uniqueIps = sanitized.uniqueIpList;
      sampleRecord.countryCounts = sanitized.countryCounts;
      sampleRecord.allCountryCounts = sanitized.allCountryCounts;
      sampleRecord.krHostCount = sanitized.krHosts.length;
      sampleRecord.krUniqueIpCount = sanitized.krUniqueIpList.length;
      sampleRecord.krDuplicateIpCount = sanitized.krDuplicateIpCount;
      sampleRecord.krUniqueIps = sanitized.krUniqueIpList;

      await writeJson(snapshotMetaPath, sampleRecord);

      console.log(
        `[${index + 1}/${sampleCount}] 완료: hosts=${sampleRecord.totalHostCount}, unique_ips=${sampleRecord.uniqueIpCount}, duplicates=${sampleRecord.duplicateIpCount}, KR_hosts=${sampleRecord.krHostCount}, KR_unique_ips=${sampleRecord.krUniqueIpCount}`,
      );

      if (previousSuccessfulSample) {
        const diff = diffSets(
          new Set(previousSuccessfulSample.uniqueIps),
          new Set(sampleRecord.uniqueIps),
        );
        const krDiff = diffSets(
          new Set(previousSuccessfulSample.krUniqueIps || []),
          new Set(sampleRecord.krUniqueIps || []),
        );

        const diffRecord = {
          fromSampleIndex: previousSuccessfulSample.index,
          toSampleIndex: sampleRecord.index,
          fromCapturedAt: previousSuccessfulSample.capturedAt,
          toCapturedAt: sampleRecord.capturedAt,
          appearedCount: diff.appeared.length,
          disappearedCount: diff.disappeared.length,
          keptCount: diff.kept.length,
          appearedIps: diff.appeared,
          disappearedIps: diff.disappeared,
          krAppearedCount: krDiff.appeared.length,
          krDisappearedCount: krDiff.disappeared.length,
          krKeptCount: krDiff.kept.length,
          krAppearedIps: krDiff.appeared,
          krDisappearedIps: krDiff.disappeared,
        };

        const diffBaseName = buildDiffBaseName(
          previousSuccessfulSample.index,
          sampleRecord.index,
          sampleCount,
        );
        const diffPath = path.join(outputDir, `${diffBaseName}.json`);
        diffRecord.diffPath = diffPath;
        await writeJson(diffPath, diffRecord);
        summary.diffs.push(diffRecord);

        console.log(
          `[${index + 1}/${sampleCount}] 변화량: 새로 생김=${diffRecord.appearedCount}, 사라짐=${diffRecord.disappearedCount}, 유지=${diffRecord.keptCount}, KR_새로생김=${diffRecord.krAppearedCount}, KR_사라짐=${diffRecord.krDisappearedCount}, KR_유지=${diffRecord.krKeptCount}`,
        );
      }

      previousSuccessfulSample = sampleRecord;
    } catch (error) {
      sampleRecord.error = error.message;
      await writeJson(snapshotMetaPath, sampleRecord);
      console.error(`[${index + 1}/${sampleCount}] 실패: ${error.message}`);
    }

    summary.samples.push(sampleRecord);
    updateAggregates(summary);
    await writeJson(summaryPath, summary);

    if (index < sampleCount - 1) {
      console.log(`[${index + 1}/${sampleCount}] 다음 새로고침까지 ${args.intervalMinutes}분 대기합니다.`);
      await delay(intervalMs);
    }
  }

  updateAggregates(summary);
  await writeJson(summaryPath, summary);

  console.log(`측정이 끝났습니다.`);
  console.log(`- summary: ${summaryPath}`);
  console.log(`- successful_samples: ${summary.aggregates.successfulSampleCount}`);
  console.log(`- all_seen_unique_ip_count: ${summary.aggregates.allSeenUniqueIpCount}`);
  console.log(`- all_seen_kr_unique_ip_count: ${summary.aggregates.allSeenKrUniqueIpCount}`);

  if (summary.aggregates.firstToLast) {
    console.log(`- first_to_last_appeared: ${summary.aggregates.firstToLast.appearedCount}`);
    console.log(`- first_to_last_disappeared: ${summary.aggregates.firstToLast.disappearedCount}`);
  }
  if (summary.aggregates.firstToLastKr) {
    console.log(`- first_to_last_kr_appeared: ${summary.aggregates.firstToLastKr.appearedCount}`);
    console.log(`- first_to_last_kr_disappeared: ${summary.aggregates.firstToLastKr.disappearedCount}`);
  }
}

main().catch((error) => {
  console.error(`실패: ${error.message}`);
  process.exitCode = 1;
});

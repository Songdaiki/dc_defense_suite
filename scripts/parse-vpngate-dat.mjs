#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * VPNGate DAT 파서
 *
 * 목적:
 *   1. 원본 DAT 파일을 읽어서 헤더(signature / timestamp / SOAP_URL)를 파싱한다.
 *   2. payload 위치, 크기, SHA-256 같은 메타를 계산한다.
 *   3. fallback 없이 raw DAT payload 자체만 추출한다.
 *
 * 중요한 점:
 *   - raw DAT endpoint(`xd.x1.client.api.vpngate2.jp/api/?session_id=...`) 자체는
 *     실제 클라이언트가 쓰는 경로로 그대로 사용한다.
 *   - 이 스크립트는 이제 공식 CSV / HTML / 다른 우회 경로를 전혀 쓰지 않는다.
 *   - 따라서 "서버/IP 개수" 같은 값은 더 이상 출력하지 않는다.
 *   - 이유는 간단하다.
 *     raw DAT를 직접 풀지 못한 상태에서 개수를 말하면, 그건 결국 다른 소스를
 *     섞은 결과가 되기 때문이다.
 *
 * 예시:
 *   1) 이미 받은 raw DAT를 읽어서 JSON/payload 파일 생성
 *      node scripts/parse-vpngate-dat.mjs \
 *        --input /tmp/vpngate_sample.dat \
 *        --output data/vpngate-dat-parsed.json \
 *        --payload-output data/vpngate-payload.bin
 *
 *   2) raw DAT까지 직접 받아오고 싶을 때
 *      node scripts/parse-vpngate-dat.mjs --fetch
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_DAT_BASE_URL = 'http://xd.x1.client.api.vpngate2.jp/api/';
const DEFAULT_OUTPUT_PATH = path.resolve(process.cwd(), 'data', 'vpngate-dat-parsed.json');

function printUsage() {
  console.log(`
사용법:
  node scripts/parse-vpngate-dat.mjs [옵션]

옵션:
  --input <path>         로컬 DAT 파일 경로
  --fetch                DAT endpoint에서 raw DAT를 직접 받음
  --session-id <value>   raw DAT endpoint에 붙일 session_id 직접 지정
  --dat-url <url>        DAT fetch URL 직접 지정
  --output <path>        JSON 출력 파일 경로
  --save-raw <path>      fetch한 raw DAT를 저장할 경로
  --payload-output <path> DAT 내부 payload만 따로 저장할 경로
  --help                 도움말

예시:
  node scripts/parse-vpngate-dat.mjs --input /tmp/vpngate_sample.dat
  node scripts/parse-vpngate-dat.mjs --fetch --payload-output data/vpngate-payload.bin
  node scripts/parse-vpngate-dat.mjs --fetch --session-id 1 --save-raw data/vpngate.dat
`.trim());
}

function parseArgs(argv) {
  const args = {
    fetch: false,
    sessionId: '',
    datUrl: '',
    output: DEFAULT_OUTPUT_PATH,
    saveRaw: '',
    payloadOutput: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--input':
        args.input = argv[++i];
        break;
      case '--fetch':
        args.fetch = true;
        break;
      case '--dat-url':
        args.datUrl = argv[++i];
        break;
      case '--session-id':
        args.sessionId = String(argv[++i] || '').trim();
        break;
      case '--output':
        args.output = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--save-raw':
        args.saveRaw = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--payload-output':
        args.payloadOutput = path.resolve(process.cwd(), argv[++i]);
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

function randomSessionId() {
  return BigInt(`0x${crypto.randomBytes(8).toString('hex')}`).toString(10);
}

function buildDefaultDatUrl(sessionId = '') {
  return `${DEFAULT_DAT_BASE_URL}?session_id=${sessionId || randomSessionId()}`;
}

function ensureParentDir(filePath) {
  if (!filePath) return Promise.resolve();
  return fs.mkdir(path.dirname(filePath), { recursive: true });
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function bytesPreviewHex(buffer, size = 32) {
  return buffer.subarray(0, Math.min(size, buffer.length)).toString('hex');
}

function requestBuffer(urlString, customHeaders = null) {
  const client = urlString.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(urlString, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
        'Connection': 'close',
        ...(customHeaders || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if ((res.statusCode || 0) >= 400) {
          reject(new Error(`요청 실패 (${res.statusCode}): ${urlString}`));
          return;
        }
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body,
        });
      });
    });

    req.on('error', reject);
  });
}

function parseDatHeader(buffer) {
  const headerScanLimit = Math.min(buffer.length, 1024);
  const headerAscii = buffer.subarray(0, headerScanLimit).toString('utf8').replace(/\u0000+$/g, '');
  const normalizedHeader = headerAscii.replace(/\r\n/g, '\n');

  const signatureMatch = normalizedHeader.match(/^\[VPNGate Data File\]/);
  if (!signatureMatch) {
    throw new Error('VPNGate DAT 시그니처가 아닙니다. ([VPNGate Data File] 없음)');
  }

  const timestampMatch = normalizedHeader.match(/^\[VPNGate Data File\]\n([^\n]+)\n/m);
  const soapUrlMatch = normalizedHeader.match(/<SOAP_URL>([^<]+)<\/SOAP_URL>/i);

  const soapEndIndex = soapUrlMatch ? normalizedHeader.indexOf(soapUrlMatch[0]) + soapUrlMatch[0].length : 0x80;
  const headerBytes = Buffer.from(normalizedHeader.slice(0, Math.max(soapEndIndex, 0)), 'utf8');
  let payloadOffset = headerBytes.length;

  while (payloadOffset < buffer.length && buffer[payloadOffset] === 0x00) {
    payloadOffset += 1;
  }

  if (payloadOffset < 0xF0 && buffer.length > 0xF0 && buffer[0xF0] !== 0x00) {
    payloadOffset = 0xF0;
  }

  const payload = buffer.subarray(payloadOffset);

  return {
    signature: '[VPNGate Data File]',
    timestampRaw: timestampMatch ? timestampMatch[1].trim() : '',
    soapUrl: soapUrlMatch ? soapUrlMatch[1].trim() : '',
    headerPreview: normalizedHeader.slice(0, Math.max(soapEndIndex + 1, 0)).trim(),
    headerScanLimit,
    payloadOffset,
    payloadSize: payload.length,
    payloadSha256: sha256Hex(payload),
    payloadPreviewHex: bytesPreviewHex(payload),
  };
}
function buildResult({ datSource, datHeader, datBuffer, payloadOutput }) {
  return {
    parser: {
      name: 'VPNGate DAT Parser',
      version: 2,
      generatedAt: new Date().toISOString(),
      mode: 'strict-dat-only',
      note: 'raw DAT만 사용합니다. iphone CSV fallback / HTML fallback / 서버 수 추정은 모두 제거했습니다.',
    },
    dat: {
      source: datSource,
      fileSize: datBuffer.length,
      sha256: sha256Hex(datBuffer),
      ...datHeader,
    },
    payload: {
      outputPath: payloadOutput || '',
      offset: datHeader.payloadOffset,
      size: datHeader.payloadSize,
      sha256: datHeader.payloadSha256,
      previewHex: datHeader.payloadPreviewHex,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.input && !args.fetch && !args.datUrl) {
    args.fetch = true;
  }

  let datSource = '';
  let datBuffer;

  if (args.input) {
    const inputPath = path.resolve(process.cwd(), args.input);
    datBuffer = await fs.readFile(inputPath);
    datSource = inputPath;
  } else {
    const datUrl = args.datUrl || buildDefaultDatUrl(args.sessionId);
    const datResponse = await requestBuffer(datUrl, {
      'Accept-Language': 'ja',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Connection': 'Keep-Alive',
      'User-Agent': 'Mozilla/5.0 (Windows NT 6.3; WOW64; rv:29.0) Gecko/20100101 Firefox/29.0',
      'X-Transaction': '69531375B74E26140097B3270D669B277D923A8AB7D5D7597A9CF8EB8506B59F4C359F70A091F925ACDAE26C',
    });
    datBuffer = datResponse.body;
    datSource = datUrl;

    if (args.saveRaw) {
      await ensureParentDir(args.saveRaw);
      await fs.writeFile(args.saveRaw, datBuffer);
    }
  }

  const datHeader = parseDatHeader(datBuffer);
  const payloadBuffer = datBuffer.subarray(datHeader.payloadOffset);

  if (args.payloadOutput) {
    await ensureParentDir(args.payloadOutput);
    await fs.writeFile(args.payloadOutput, payloadBuffer);
  }

  const result = buildResult({
    datSource,
    datHeader,
    datBuffer,
    payloadOutput: args.payloadOutput,
  });

  await ensureParentDir(args.output);
  await fs.writeFile(args.output, JSON.stringify(result, null, 2), 'utf8');

  console.log(`DAT source: ${result.dat.source}`);
  console.log(`DAT timestamp: ${result.dat.timestampRaw || '(없음)'}`);
  console.log(`SOAP_URL: ${result.dat.soapUrl || '(없음)'}`);
  console.log(`Payload offset/size: ${result.dat.payloadOffset} / ${result.dat.payloadSize}`);
  console.log(`Payload SHA-256: ${result.dat.payloadSha256}`);
  console.log(`목록 해석 방식: ${result.parser.mode}`);
  console.log(`출력 JSON: ${args.output}`);
  if (args.payloadOutput) {
    console.log(`출력 payload: ${args.payloadOutput}`);
  }
}

main().catch((error) => {
  console.error(`실패: ${error.message || error}`);
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * VPNGate 공식 DAT 복원기
 *
 * 목적:
 *   1. 공식 DAT 본문 또는 raw payload를 읽는다.
 *   2. payload 앞 20바이트를 SHA-1 한 값을 RC4 키로 사용해 복호한다.
 *   3. SoftEther PACK 포맷을 파싱해서 실제 서버 목록을 JSON으로 복원한다.
 *
 * 핵심 포인트:
 *   - 공식 클라이언트 feed는 공개 CSV가 아니라 DAT payload다.
 *   - raw payload는 그냥 RC4가 아니라 "SHA1(header20) -> RC4" 순서로 풀린다.
 *   - 복호 후에는 outer pack -> inner pack 2단계 구조로 서버 200개가 나온다.
 *
 * 예시:
 *   1) 이미 추출한 DAT body를 복원
 *      node scripts/decode-vpngate-official-dat.mjs \
 *        --input /tmp/vpngate_response_body.bin \
 *        --output data/vpngate-official-feed.json
 *
 *   2) raw payload만 있는 경우
 *      node scripts/decode-vpngate-official-dat.mjs \
 *        --payload-input /tmp/vpngate_response_payload.bin
 *
 *   3) 공식 endpoint에서 직접 받아서 복원
 *      node scripts/decode-vpngate-official-dat.mjs --fetch
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

const DEFAULT_DAT_BASE_URL = 'http://xd.x1.client.api.vpngate2.jp/api/';
const DEFAULT_OUTPUT_PATH = path.resolve(process.cwd(), 'data', 'vpngate-official-feed.json');

const VALUE_INT = 0;
const VALUE_DATA = 1;
const VALUE_STR = 2;
const VALUE_UNISTR = 3;
const VALUE_INT64 = 4;

const DATE_FIELD_NAMES = new Set(['CreateDate', 'VerifyDate']);

function printUsage() {
  console.log(`
사용법:
  node scripts/decode-vpngate-official-dat.mjs [옵션]

옵션:
  --input <path>           DAT 본문(헤더 포함) 파일 경로
  --payload-input <path>   DAT 내부 raw payload만 따로 있는 파일 경로
  --fetch                  공식 endpoint에서 raw DAT를 직접 받음
  --session-id <value>     fetch 시 사용할 session_id
  --dat-url <url>          fetch URL 직접 지정
  --output <path>          JSON 출력 파일 경로
  --save-raw <path>        fetch한 DAT body 저장 경로
  --save-payload <path>    복호 전 raw payload 저장 경로
  --save-outer <path>      RC4 복호 후 outer pack 바이트 저장 경로
  --save-inner <path>      실제 서버 목록 inner pack 바이트 저장 경로
  --help                   도움말

예시:
  node scripts/decode-vpngate-official-dat.mjs --input /tmp/vpngate_response_body.bin
  node scripts/decode-vpngate-official-dat.mjs --payload-input /tmp/vpngate_response_payload.bin
  node scripts/decode-vpngate-official-dat.mjs --fetch --output data/vpngate-official-feed.json
`.trim());
}

function parseArgs(argv) {
  const args = {
    fetch: false,
    sessionId: '',
    datUrl: '',
    output: DEFAULT_OUTPUT_PATH,
    saveRaw: '',
    savePayload: '',
    saveOuter: '',
    saveInner: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--input':
        args.input = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--payload-input':
        args.payloadInput = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--fetch':
        args.fetch = true;
        break;
      case '--session-id':
        args.sessionId = String(argv[++i] || '').trim();
        break;
      case '--dat-url':
        args.datUrl = String(argv[++i] || '').trim();
        break;
      case '--output':
        args.output = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--save-raw':
        args.saveRaw = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--save-payload':
        args.savePayload = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--save-outer':
        args.saveOuter = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--save-inner':
        args.saveInner = path.resolve(process.cwd(), argv[++i]);
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

async function ensureParentDir(filePath) {
  if (!filePath) {
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest();
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function bytesPreviewHex(buffer, size = 32) {
  return buffer.subarray(0, Math.min(size, buffer.length)).toString('hex');
}

function stripTrailingNulls(text) {
  return text.replace(/\u0000+$/g, '');
}

function decodeAsciiIfPrintable(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return '';
  }

  const text = stripTrailingNulls(buffer.toString('utf8'));
  if (!text) {
    return '';
  }

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isSafe =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0x7e);
    if (!isSafe) {
      return '';
    }
  }

  return text;
}

function requestBuffer(urlString, customHeaders = null) {
  const client = urlString.startsWith('https:') ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.get(urlString, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 6.3; WOW64; rv:29.0) Gecko/20100101 Firefox/29.0',
        'Accept': '*/*',
        'Accept-Language': 'ja',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Connection': 'Keep-Alive',
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

  if (!normalizedHeader.startsWith('[VPNGate Data File]')) {
    throw new Error('VPNGate DAT 시그니처가 아닙니다. ([VPNGate Data File] 없음)');
  }

  const timestampMatch = normalizedHeader.match(/^\[VPNGate Data File\]\n([^\n]+)\n/m);
  const soapUrlMatch = normalizedHeader.match(/<SOAP_URL>([^<]+)<\/SOAP_URL>/i);

  const soapEndIndex = soapUrlMatch
    ? normalizedHeader.indexOf(soapUrlMatch[0]) + soapUrlMatch[0].length
    : 0x80;

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
    headerScanLimit,
    payloadOffset,
    payloadSize: payload.length,
    payloadSha256: sha256Hex(payload),
    payloadPreviewHex: bytesPreviewHex(payload),
    payload,
  };
}

function rc4Crypt(keyBuffer, inputBuffer) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    s[i] = i;
  }

  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + keyBuffer[i % keyBuffer.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }

  const out = Buffer.allocUnsafe(inputBuffer.length);
  let i = 0;
  j = 0;

  for (let offset = 0; offset < inputBuffer.length; offset += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;

    const k = s[(s[i] + s[j]) & 0xff];
    out[offset] = inputBuffer[offset] ^ k;
  }

  return out;
}

function readUInt32BE(buffer, offset) {
  if (offset + 4 > buffer.length) {
    throw new Error(`u32 읽기 실패: offset=${offset}`);
  }
  return {
    value: buffer.readUInt32BE(offset),
    nextOffset: offset + 4,
  };
}

function readBigUInt64BEAsNumber(buffer, offset) {
  if (offset + 8 > buffer.length) {
    throw new Error(`u64 읽기 실패: offset=${offset}`);
  }
  const value = Number(buffer.readBigUInt64BE(offset));
  return {
    value,
    nextOffset: offset + 8,
  };
}

function readPackString(buffer, offset) {
  const { value: rawLength, nextOffset: lengthOffset } = readUInt32BE(buffer, offset);
  if (rawLength === 0) {
    throw new Error(`PACK 문자열 길이가 0입니다. offset=${offset}`);
  }

  const bodyLength = rawLength - 1;
  const endOffset = lengthOffset + bodyLength;
  if (endOffset > buffer.length) {
    throw new Error(`PACK 문자열 본문이 잘렸습니다. offset=${offset}`);
  }

  return {
    value: buffer.subarray(lengthOffset, endOffset).toString('utf8'),
    nextOffset: endOffset,
  };
}

function readPackValue(buffer, offset, type) {
  if (type === VALUE_INT) {
    return readUInt32BE(buffer, offset);
  }

  if (type === VALUE_INT64) {
    return readBigUInt64BEAsNumber(buffer, offset);
  }

  if (type === VALUE_DATA) {
    const { value: size, nextOffset: sizeOffset } = readUInt32BE(buffer, offset);
    const endOffset = sizeOffset + size;
    if (endOffset > buffer.length) {
      throw new Error(`DATA value가 잘렸습니다. offset=${offset}`);
    }

    return {
      value: buffer.subarray(sizeOffset, endOffset),
      nextOffset: endOffset,
    };
  }

  if (type === VALUE_STR) {
    const { value: size, nextOffset: sizeOffset } = readUInt32BE(buffer, offset);
    const endOffset = sizeOffset + size;
    if (endOffset > buffer.length) {
      throw new Error(`STR value가 잘렸습니다. offset=${offset}`);
    }

    return {
      value: buffer.subarray(sizeOffset, endOffset).toString('utf8'),
      nextOffset: endOffset,
    };
  }

  if (type === VALUE_UNISTR) {
    const { value: size, nextOffset: sizeOffset } = readUInt32BE(buffer, offset);
    const endOffset = sizeOffset + size;
    if (endOffset > buffer.length) {
      throw new Error(`UNISTR value가 잘렸습니다. offset=${offset}`);
    }

    return {
      value: stripTrailingNulls(buffer.subarray(sizeOffset, endOffset).toString('utf8')),
      nextOffset: endOffset,
    };
  }

  throw new Error(`알 수 없는 PACK type: ${type}`);
}

function parsePack(buffer) {
  let offset = 0;
  const { value: elementCount, nextOffset } = readUInt32BE(buffer, offset);
  offset = nextOffset;

  const elements = [];
  for (let i = 0; i < elementCount; i += 1) {
    const nameResult = readPackString(buffer, offset);
    offset = nameResult.nextOffset;

    const typeResult = readUInt32BE(buffer, offset);
    offset = typeResult.nextOffset;

    const countResult = readUInt32BE(buffer, offset);
    offset = countResult.nextOffset;

    const values = [];
    for (let j = 0; j < countResult.value; j += 1) {
      const valueResult = readPackValue(buffer, offset, typeResult.value);
      values.push(valueResult.value);
      offset = valueResult.nextOffset;
    }

    elements.push({
      name: nameResult.value,
      type: typeResult.value,
      values,
    });
  }

  return {
    elementCount,
    elements,
    consumedBytes: offset,
  };
}

function packElementsToMap(elements) {
  const map = new Map();
  for (const element of elements) {
    map.set(element.name, element);
  }
  return map;
}

function tryParseNestedPack(buffer) {
  try {
    const parsed = parsePack(buffer);
    if (parsed.consumedBytes !== buffer.length) {
      return null;
    }

    const result = {};
    for (const element of parsed.elements) {
      result[element.name] = element.values.length === 1 ? element.values[0] : element.values;
    }

    return result;
  } catch {
    return null;
  }
}

function decodeOuterMetadata(outerMap, dataBuffer, datHeader) {
  const soapUrlBuffer = outerMap.get('soap_url')?.values?.[0] || Buffer.alloc(0);
  const timestampBuffer = outerMap.get('timestamp')?.values?.[0] || Buffer.alloc(0);
  const signBuffer = outerMap.get('sign')?.values?.[0] || Buffer.alloc(0);
  const compressed = outerMap.get('compressed')?.values?.[0] || 0;
  const dataSize = outerMap.get('data_size')?.values?.[0] || 0;

  let timestampMs = 0;
  if (Buffer.isBuffer(timestampBuffer) && timestampBuffer.length === 8) {
    timestampMs = Number(timestampBuffer.readBigUInt64BE(0));
  }

  return {
    compressed: compressed !== 0,
    dataSize,
    dataSha256: sha256Hex(dataBuffer),
    soapUrl: decodeAsciiIfPrintable(soapUrlBuffer) || datHeader?.soapUrl || '',
    soapUrlHex: soapUrlBuffer.toString('hex'),
    timestampHex: timestampBuffer.toString('hex'),
    timestampMs,
    timestampIso: timestampMs > 0 ? new Date(timestampMs).toISOString() : '',
    signHex: signBuffer.toString('hex'),
    signSize: signBuffer.length,
  };
}

function maybeInflate(buffer, expectedSize) {
  const attempts = [
    { name: 'inflate', fn: data => zlib.inflateSync(data) },
    { name: 'inflateRaw', fn: data => zlib.inflateRawSync(data) },
    { name: 'gunzip', fn: data => zlib.gunzipSync(data) },
  ];

  for (const attempt of attempts) {
    try {
      const out = attempt.fn(buffer);
      if (!expectedSize || out.length === expectedSize) {
        return {
          bytes: out,
          method: attempt.name,
        };
      }
    } catch {
      // ignore
    }
  }

  throw new Error('compressed=1 인데 지원 가능한 압축 해제를 실패했습니다.');
}

function decodeInnerFeed(innerElements) {
  const innerMap = packElementsToMap(innerElements);
  const numHosts = innerMap.get('NumHosts')?.values?.[0] || 0;
  if (!numHosts) {
    throw new Error('inner pack에 NumHosts가 없습니다.');
  }

  const globals = {};
  const dynList = {};
  const hostFieldNames = [];

  for (const element of innerElements) {
    if (element.name === 'NumHosts') {
      globals.NumHosts = numHosts;
      continue;
    }

    if (element.values.length === 1) {
      const rawValue = element.values[0];
      if (Buffer.isBuffer(rawValue)) {
        const nestedPack = tryParseNestedPack(rawValue);
        if (nestedPack) {
          dynList[element.name] = nestedPack;
        } else {
          globals[element.name] = decodeAsciiIfPrintable(rawValue) || rawValue.toString('hex');
        }
      } else {
        globals[element.name] = rawValue;
      }
      continue;
    }

    if (element.values.length === numHosts) {
      hostFieldNames.push(element.name);
      continue;
    }

    globals[element.name] = element.values;
  }

  const hosts = [];
  for (let index = 0; index < numHosts; index += 1) {
    const host = {};
    for (const fieldName of hostFieldNames) {
      const element = innerMap.get(fieldName);
      const value = element.values[index];
      host[fieldName] = value;

      if (DATE_FIELD_NAMES.has(fieldName) && typeof value === 'number' && value > 0) {
        host[`${fieldName}Iso`] = new Date(value).toISOString();
      }
    }
    hosts.push(host);
  }

  return {
    numHosts,
    globals,
    dynList,
    hostFieldNames,
    hosts,
  };
}

function buildResult({
  source,
  datBuffer,
  datHeader,
  payload,
  rc4Key,
  outerPack,
  outerMetadata,
  innerBytes,
  feed,
}) {
  return {
    parser: {
      name: 'VPNGate Official DAT Decoder',
      version: 1,
      generatedAt: new Date().toISOString(),
      note: '공식 DAT의 header20 -> SHA1 -> RC4 -> PACK 복원을 수행합니다.',
    },
    source,
    dat: datBuffer ? {
      fileSize: datBuffer.length,
      sha256: sha256Hex(datBuffer),
      signature: datHeader?.signature || '',
      headerTimestampRaw: datHeader?.timestampRaw || '',
      headerSoapUrl: datHeader?.soapUrl || '',
      payloadOffset: datHeader?.payloadOffset || 0,
      payloadSize: datHeader?.payloadSize || 0,
    } : null,
    payload: {
      size: payload.length,
      sha256: sha256Hex(payload),
      header20Hex: payload.subarray(0, 20).toString('hex'),
      rc4KeySha1Hex: rc4Key.toString('hex'),
      previewHex: bytesPreviewHex(payload),
    },
    outer: {
      elementCount: outerPack.elementCount,
      consumedBytes: outerPack.consumedBytes,
      ...outerMetadata,
    },
    feed: {
      numHosts: feed.numHosts,
      globals: feed.globals,
      dynList: feed.dynList,
      hostFieldNames: feed.hostFieldNames,
      hosts: feed.hosts,
      innerSha256: sha256Hex(innerBytes),
      innerSize: innerBytes.length,
    },
  };
}

async function loadSource(args) {
  if (args.payloadInput) {
    const payload = await fs.readFile(args.payloadInput);
    return {
      kind: 'payload',
      sourceLabel: args.payloadInput,
      datBuffer: null,
      datHeader: null,
      payload,
    };
  }

  let datBuffer;
  let sourceLabel = '';
  let responseHeaders = null;
  let datUrl = '';

  if (args.input) {
    datBuffer = await fs.readFile(args.input);
    sourceLabel = args.input;
  } else {
    datUrl = args.datUrl || buildDefaultDatUrl(args.sessionId);
    const response = await requestBuffer(datUrl, {
      'X-Transaction': '69531375B74E26140097B3270D669B277D923A8AB7D5D7597A9CF8EB8506B59F4C359F70A091F925ACDAE26C',
    });
    datBuffer = response.body;
    sourceLabel = datUrl;
    responseHeaders = response.headers;

    if (args.saveRaw) {
      await ensureParentDir(args.saveRaw);
      await fs.writeFile(args.saveRaw, datBuffer);
    }
  }

  const datHeader = parseDatHeader(datBuffer);
  if (args.savePayload) {
    await ensureParentDir(args.savePayload);
    await fs.writeFile(args.savePayload, datHeader.payload);
  }

  return {
    kind: 'dat',
    sourceLabel,
    datUrl,
    responseHeaders,
    datBuffer,
    datHeader,
    payload: datHeader.payload,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.input && !args.payloadInput && !args.fetch && !args.datUrl) {
    args.fetch = true;
  }

  const sourceData = await loadSource(args);
  const payload = sourceData.payload;

  if (payload.length < 21) {
    throw new Error(`payload 길이가 너무 짧습니다: ${payload.length}`);
  }

  const payloadHeader20 = payload.subarray(0, 20);
  const rc4Key = sha1(payloadHeader20);
  const outerBytes = rc4Crypt(rc4Key, payload.subarray(20));

  if (args.saveOuter) {
    await ensureParentDir(args.saveOuter);
    await fs.writeFile(args.saveOuter, outerBytes);
  }

  const outerPack = parsePack(outerBytes);
  if (outerPack.consumedBytes !== outerBytes.length) {
    throw new Error(`outer pack 길이 불일치: consumed=${outerPack.consumedBytes}, total=${outerBytes.length}`);
  }

  const outerMap = packElementsToMap(outerPack.elements);
  const rawData = outerMap.get('data')?.values?.[0];
  if (!Buffer.isBuffer(rawData)) {
    throw new Error('outer pack에 data(DATA)가 없습니다.');
  }

  const outerMetadata = decodeOuterMetadata(outerMap, rawData, sourceData.datHeader);
  const innerBytes = outerMetadata.compressed
    ? maybeInflate(rawData, outerMetadata.dataSize).bytes
    : rawData;

  if (args.saveInner) {
    await ensureParentDir(args.saveInner);
    await fs.writeFile(args.saveInner, innerBytes);
  }

  if (outerMetadata.dataSize && innerBytes.length !== outerMetadata.dataSize) {
    throw new Error(`inner data_size 불일치: expected=${outerMetadata.dataSize}, actual=${innerBytes.length}`);
  }

  const innerPack = parsePack(innerBytes);
  if (innerPack.consumedBytes !== innerBytes.length) {
    throw new Error(`inner pack 길이 불일치: consumed=${innerPack.consumedBytes}, total=${innerBytes.length}`);
  }

  const feed = decodeInnerFeed(innerPack.elements);

  const result = buildResult({
    source: {
      kind: sourceData.kind,
      label: sourceData.sourceLabel,
      datUrl: sourceData.datUrl || '',
      responseContentType: sourceData.responseHeaders?.['content-type'] || '',
    },
    datBuffer: sourceData.datBuffer,
    datHeader: sourceData.datHeader,
    payload,
    rc4Key,
    outerPack,
    outerMetadata,
    innerBytes,
    feed,
  });

  await ensureParentDir(args.output);
  await fs.writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`);

  const firstHost = result.feed.hosts[0] || null;
  console.log(`공식 VPNGate DAT 복원 완료`);
  console.log(`- source: ${result.source.label}`);
  console.log(`- hosts: ${result.feed.numHosts}`);
  console.log(`- request_ip: ${result.feed.globals.DatRequestIp || ''}`);
  console.log(`- rc4_key_sha1: ${result.payload.rc4KeySha1Hex}`);
  console.log(`- output: ${args.output}`);
  if (firstHost) {
    console.log(`- first_host: ${firstHost.Name} / ${firstHost.IP} / ${firstHost.CountryShort}`);
  }
}

main().catch((error) => {
  console.error(`실패: ${error.message}`);
  process.exitCode = 1;
});

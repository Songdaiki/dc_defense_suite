const VALUE_INT = 0;
const VALUE_DATA = 1;
const VALUE_STR = 2;
const VALUE_UNISTR = 3;
const VALUE_INT64 = 4;

const DATE_FIELD_NAMES = new Set(['CreateDate', 'VerifyDate']);

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  throw new Error('Uint8Array 또는 ArrayBuffer가 필요합니다.');
}

function decodeUtf8(bytes) {
  return textDecoder.decode(bytes);
}

function encodeUtf8(text) {
  return textEncoder.encode(text);
}

function stripTrailingNulls(text) {
  return String(text || '').replace(/\u0000+$/g, '');
}

function bytesToHex(bytes) {
  return [...toUint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function decodeAsciiIfPrintable(bytes) {
  const normalizedBytes = toUint8Array(bytes);
  const text = stripTrailingNulls(decodeUtf8(normalizedBytes));
  if (!text) {
    return '';
  }

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const isSafe =
      code === 0x09
      || code === 0x0a
      || code === 0x0d
      || (code >= 0x20 && code <= 0x7e);
    if (!isSafe) {
      return '';
    }
  }

  return text;
}

function getDataView(bytes) {
  const normalizedBytes = toUint8Array(bytes);
  return new DataView(
    normalizedBytes.buffer,
    normalizedBytes.byteOffset,
    normalizedBytes.byteLength,
  );
}

function readUInt32BE(bytes, offset) {
  const normalizedBytes = toUint8Array(bytes);
  if (offset + 4 > normalizedBytes.length) {
    throw new Error(`u32 읽기 실패: offset=${offset}`);
  }

  return {
    value: getDataView(normalizedBytes).getUint32(offset, false),
    nextOffset: offset + 4,
  };
}

function readBigUInt64BEAsNumber(bytes, offset) {
  const normalizedBytes = toUint8Array(bytes);
  if (offset + 8 > normalizedBytes.length) {
    throw new Error(`u64 읽기 실패: offset=${offset}`);
  }

  return {
    value: Number(getDataView(normalizedBytes).getBigUint64(offset, false)),
    nextOffset: offset + 8,
  };
}

function readPackString(bytes, offset) {
  const { value: rawLength, nextOffset: lengthOffset } = readUInt32BE(bytes, offset);
  if (rawLength === 0) {
    throw new Error(`PACK 문자열 길이가 0입니다. offset=${offset}`);
  }

  const bodyLength = rawLength - 1;
  const endOffset = lengthOffset + bodyLength;
  const normalizedBytes = toUint8Array(bytes);
  if (endOffset > normalizedBytes.length) {
    throw new Error(`PACK 문자열 본문이 잘렸습니다. offset=${offset}`);
  }

  return {
    value: decodeUtf8(normalizedBytes.subarray(lengthOffset, endOffset)),
    nextOffset: endOffset,
  };
}

function readPackValue(bytes, offset, type) {
  const normalizedBytes = toUint8Array(bytes);

  if (type === VALUE_INT) {
    return readUInt32BE(normalizedBytes, offset);
  }

  if (type === VALUE_INT64) {
    return readBigUInt64BEAsNumber(normalizedBytes, offset);
  }

  if (type === VALUE_DATA) {
    const { value: size, nextOffset: sizeOffset } = readUInt32BE(normalizedBytes, offset);
    const endOffset = sizeOffset + size;
    if (endOffset > normalizedBytes.length) {
      throw new Error(`DATA value가 잘렸습니다. offset=${offset}`);
    }

    return {
      value: normalizedBytes.slice(sizeOffset, endOffset),
      nextOffset: endOffset,
    };
  }

  if (type === VALUE_STR) {
    const { value: size, nextOffset: sizeOffset } = readUInt32BE(normalizedBytes, offset);
    const endOffset = sizeOffset + size;
    if (endOffset > normalizedBytes.length) {
      throw new Error(`STR value가 잘렸습니다. offset=${offset}`);
    }

    return {
      value: decodeUtf8(normalizedBytes.subarray(sizeOffset, endOffset)),
      nextOffset: endOffset,
    };
  }

  if (type === VALUE_UNISTR) {
    const { value: size, nextOffset: sizeOffset } = readUInt32BE(normalizedBytes, offset);
    const endOffset = sizeOffset + size;
    if (endOffset > normalizedBytes.length) {
      throw new Error(`UNISTR value가 잘렸습니다. offset=${offset}`);
    }

    return {
      value: stripTrailingNulls(decodeUtf8(normalizedBytes.subarray(sizeOffset, endOffset))),
      nextOffset: endOffset,
    };
  }

  throw new Error(`알 수 없는 PACK type: ${type}`);
}

function parsePack(bytes) {
  const normalizedBytes = toUint8Array(bytes);
  let offset = 0;
  const { value: elementCount, nextOffset } = readUInt32BE(normalizedBytes, offset);
  offset = nextOffset;

  const elements = [];
  for (let index = 0; index < elementCount; index += 1) {
    const nameResult = readPackString(normalizedBytes, offset);
    offset = nameResult.nextOffset;

    const typeResult = readUInt32BE(normalizedBytes, offset);
    offset = typeResult.nextOffset;

    const countResult = readUInt32BE(normalizedBytes, offset);
    offset = countResult.nextOffset;

    const values = [];
    for (let valueIndex = 0; valueIndex < countResult.value; valueIndex += 1) {
      const valueResult = readPackValue(normalizedBytes, offset, typeResult.value);
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

function tryParseNestedPack(bytes) {
  try {
    const parsed = parsePack(bytes);
    if (parsed.consumedBytes !== toUint8Array(bytes).length) {
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

async function sha1Bytes(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('SHA-1 계산용 WebCrypto를 사용할 수 없습니다.');
  }

  const normalizedBytes = toUint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-1',
    normalizedBytes.buffer.slice(
      normalizedBytes.byteOffset,
      normalizedBytes.byteOffset + normalizedBytes.byteLength,
    ),
  );
  return new Uint8Array(digest);
}

function rc4Crypt(keyBytes, inputBytes) {
  const normalizedKeyBytes = toUint8Array(keyBytes);
  const normalizedInputBytes = toUint8Array(inputBytes);
  const s = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) {
    s[index] = index;
  }

  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + s[index] + normalizedKeyBytes[index % normalizedKeyBytes.length]) & 0xff;
    const temp = s[index];
    s[index] = s[j];
    s[j] = temp;
  }

  const output = new Uint8Array(normalizedInputBytes.length);
  let i = 0;
  j = 0;

  for (let offset = 0; offset < normalizedInputBytes.length; offset += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const temp = s[i];
    s[i] = s[j];
    s[j] = temp;

    const k = s[(s[i] + s[j]) & 0xff];
    output[offset] = normalizedInputBytes[offset] ^ k;
  }

  return output;
}

function parseVpnGateDatHeader(bufferLike) {
  const datBytes = toUint8Array(bufferLike);
  const headerScanLimit = Math.min(datBytes.length, 1024);
  const headerAscii = decodeUtf8(datBytes.subarray(0, headerScanLimit)).replace(/\u0000+$/g, '');
  const normalizedHeader = headerAscii.replace(/\r\n/g, '\n');

  if (!normalizedHeader.startsWith('[VPNGate Data File]')) {
    throw new Error('VPNGate DAT 시그니처가 아닙니다. ([VPNGate Data File] 없음)');
  }

  const timestampMatch = normalizedHeader.match(/^\[VPNGate Data File\]\n([^\n]+)\n/m);
  const soapUrlMatch = normalizedHeader.match(/<SOAP_URL>([^<]+)<\/SOAP_URL>/i);
  const soapEndIndex = soapUrlMatch
    ? normalizedHeader.indexOf(soapUrlMatch[0]) + soapUrlMatch[0].length
    : 0x80;

  const headerBytes = encodeUtf8(normalizedHeader.slice(0, Math.max(soapEndIndex, 0)));
  let payloadOffset = headerBytes.length;

  while (payloadOffset < datBytes.length && datBytes[payloadOffset] === 0x00) {
    payloadOffset += 1;
  }

  if (payloadOffset < 0xF0 && datBytes.length > 0xF0 && datBytes[0xF0] !== 0x00) {
    payloadOffset = 0xF0;
  }

  return {
    signature: '[VPNGate Data File]',
    timestampRaw: timestampMatch ? timestampMatch[1].trim() : '',
    soapUrl: soapUrlMatch ? soapUrlMatch[1].trim() : '',
    payloadOffset,
    payload: datBytes.slice(payloadOffset),
  };
}

async function decompressBytes(bytes, format) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('DecompressionStream을 사용할 수 없습니다.');
  }

  const stream = new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  await writer.write(toUint8Array(bytes));
  await writer.close();

  const response = new Response(stream.readable);
  return new Uint8Array(await response.arrayBuffer());
}

async function maybeInflate(bytes, expectedSize = 0) {
  const formats = ['deflate', 'deflate-raw', 'gzip'];
  for (const format of formats) {
    try {
      const output = await decompressBytes(bytes, format);
      if (!expectedSize || output.length === expectedSize) {
        return {
          bytes: output,
          method: format,
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
      if (rawValue instanceof Uint8Array) {
        const nestedPack = tryParseNestedPack(rawValue);
        if (nestedPack) {
          dynList[element.name] = nestedPack;
        } else {
          globals[element.name] = decodeAsciiIfPrintable(rawValue) || bytesToHex(rawValue);
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
      const value = element?.values?.[index];
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

async function decodeVpnGateDatBuffer(bufferLike) {
  const datBytes = toUint8Array(bufferLike);
  const datHeader = parseVpnGateDatHeader(datBytes);
  const payload = datHeader.payload;
  if (payload.length < 21) {
    throw new Error(`payload 길이가 너무 짧습니다: ${payload.length}`);
  }

  const rc4Key = await sha1Bytes(payload.subarray(0, 20));
  const outerBytes = rc4Crypt(rc4Key, payload.subarray(20));
  const outerPack = parsePack(outerBytes);
  if (outerPack.consumedBytes !== outerBytes.length) {
    throw new Error(`outer pack 길이 불일치: consumed=${outerPack.consumedBytes}, total=${outerBytes.length}`);
  }

  const outerMap = packElementsToMap(outerPack.elements);
  const rawData = outerMap.get('data')?.values?.[0];
  if (!(rawData instanceof Uint8Array)) {
    throw new Error('outer pack에 data(DATA)가 없습니다.');
  }

  const compressed = Boolean(outerMap.get('compressed')?.values?.[0] || 0);
  const dataSize = Number(outerMap.get('data_size')?.values?.[0] || 0);
  const innerBytes = compressed
    ? (await maybeInflate(rawData, dataSize)).bytes
    : rawData;

  if (dataSize && innerBytes.length !== dataSize) {
    throw new Error(`inner data_size 불일치: expected=${dataSize}, actual=${innerBytes.length}`);
  }

  const innerPack = parsePack(innerBytes);
  if (innerPack.consumedBytes !== innerBytes.length) {
    throw new Error(`inner pack 길이 불일치: consumed=${innerPack.consumedBytes}, total=${innerBytes.length}`);
  }

  return {
    datHeader,
    payload,
    rc4Key,
    outerPack,
    innerBytes,
    feed: decodeInnerFeed(innerPack.elements),
  };
}

export {
  decodeVpnGateDatBuffer,
  parsePack,
  parseVpnGateDatHeader,
};

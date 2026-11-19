import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

export interface ApkMetadata {
  extractedName: string;
  packageName: string;
  versionName: string;
  iconDataUrl: string;
  iconSource: 'manifest' | 'heuristic' | 'fallback';
}

interface ZipEntryMeta {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface ParsedManifest {
  packageName: string;
  versionName: string;
  labelText: string | null;
  labelResId: number | null;
  iconResId: number | null;
  roundIconResId: number | null;
}

interface StringPoolResult {
  strings: string[];
  chunkEnd: number;
}

const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_TYPE = 0x0002;
const RES_XML_TYPE = 0x0003;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;

const ATTR_LABEL = 0x01010001;
const ATTR_ICON = 0x01010002;
const ATTR_ROUND_ICON = 0x0101052c;
const ATTR_VERSION_NAME = 0x0101021c;
const ATTR_DRAWABLE = 0x01010199;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;

/**
 * Low-memory random-access ZIP Central Directory reader.
 * Parses 200MB+ APKs in milliseconds using < 5MB RAM by never loading
 * classes.dex, native .so libraries, or large assets into memory.
 */
function readZipCentralDirectory(fd: number, fileSize: number): Map<string, ZipEntryMeta> {
  const entries = new Map<string, ZipEntryMeta>();
  if (fileSize < 22) return entries;

  const tailLen = Math.min(fileSize, 65557);
  const tailStart = fileSize - tailLen;
  const tailBuf = Buffer.allocUnsafe(tailLen);
  fs.readSync(fd, tailBuf, 0, tailLen, tailStart);

  // Locate End of Central Directory (PK\x05\x06) scanning backwards
  let eocdPos = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (
      tailBuf[i] === 0x50 &&
      tailBuf[i + 1] === 0x4b &&
      tailBuf[i + 2] === 0x05 &&
      tailBuf[i + 3] === 0x06
    ) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) return entries;

  let cdSize = tailBuf.readUInt32LE(eocdPos + 12);
  let cdOffset = tailBuf.readUInt32LE(eocdPos + 16);

  // Handle ZIP64 EOCD if present
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const locPos = eocdPos - 20;
    if (
      locPos >= 0 &&
      tailBuf[locPos] === 0x50 &&
      tailBuf[locPos + 1] === 0x4b &&
      tailBuf[locPos + 2] === 0x06 &&
      tailBuf[locPos + 3] === 0x07
    ) {
      const zip64EocdOffset = Number(tailBuf.readBigUInt64LE(locPos + 8));
      if (zip64EocdOffset >= 0 && zip64EocdOffset + 56 <= fileSize) {
        const z64Buf = Buffer.allocUnsafe(56);
        fs.readSync(fd, z64Buf, 0, 56, zip64EocdOffset);
        if (z64Buf.readUInt32LE(0) === 0x06064b50) {
          cdSize = Number(z64Buf.readBigUInt64LE(40));
          cdOffset = Number(z64Buf.readBigUInt64LE(48));
        }
      }
    }
  }

  if (cdSize <= 0 || cdSize > 32 * 1024 * 1024 || cdOffset < 0 || cdOffset + cdSize > fileSize) {
    return entries;
  }

  const cdBuf = Buffer.allocUnsafe(cdSize);
  fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

  let pos = 0;
  while (pos + 46 <= cdBuf.length) {
    if (
      cdBuf[pos] !== 0x50 ||
      cdBuf[pos + 1] !== 0x4b ||
      cdBuf[pos + 2] !== 0x01 ||
      cdBuf[pos + 3] !== 0x02
    ) {
      break;
    }

    const compressionMethod = cdBuf.readUInt16LE(pos + 10);
    let compressedSize = cdBuf.readUInt32LE(pos + 20);
    let uncompressedSize = cdBuf.readUInt32LE(pos + 24);
    const nameLen = cdBuf.readUInt16LE(pos + 28);
    const extraLen = cdBuf.readUInt16LE(pos + 30);
    const commentLen = cdBuf.readUInt16LE(pos + 32);
    let localHeaderOffset = cdBuf.readUInt32LE(pos + 42);

    const nameStart = pos + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > cdBuf.length) break;

    const name = cdBuf.subarray(nameStart, nameEnd).toString('utf8');

    // Parse ZIP64 extra field if needed
    if (
      (uncompressedSize === 0xffffffff ||
        compressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff) &&
      extraLen >= 4
    ) {
      let exPos = nameEnd;
      const exEnd = Math.min(nameEnd + extraLen, cdBuf.length);
      while (exPos + 4 <= exEnd) {
        const headerId = cdBuf.readUInt16LE(exPos);
        const dataSize = cdBuf.readUInt16LE(exPos + 2);
        exPos += 4;
        if (headerId === 0x0001 && exPos + dataSize <= exEnd) {
          let cursor = exPos;
          if (uncompressedSize === 0xffffffff && cursor + 8 <= exPos + dataSize) {
            uncompressedSize = Number(cdBuf.readBigUInt64LE(cursor));
            cursor += 8;
          }
          if (compressedSize === 0xffffffff && cursor + 8 <= exPos + dataSize) {
            compressedSize = Number(cdBuf.readBigUInt64LE(cursor));
            cursor += 8;
          }
          if (localHeaderOffset === 0xffffffff && cursor + 8 <= exPos + dataSize) {
            localHeaderOffset = Number(cdBuf.readBigUInt64LE(cursor));
          }
          break;
        }
        exPos += dataSize;
      }
    }

    if (!name.endsWith('/')) {
      entries.set(name, {
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }

    pos = nameEnd + extraLen + commentLen;
  }

  return entries;
}

function readZipEntryBuffer(
  fd: number,
  fileSize: number,
  entry: ZipEntryMeta,
  maxBytes: number
): Buffer | null {
  if (entry.compressedSize <= 0 || entry.compressedSize > maxBytes) return null;
  if (entry.uncompressedSize > maxBytes) return null;
  if (entry.localHeaderOffset < 0 || entry.localHeaderOffset + 30 > fileSize) return null;

  const localHeader = Buffer.allocUnsafe(30);
  fs.readSync(fd, localHeader, 0, 30, entry.localHeaderOffset);
  if (
    localHeader[0] !== 0x50 ||
    localHeader[1] !== 0x4b ||
    localHeader[2] !== 0x03 ||
    localHeader[3] !== 0x04
  ) {
    return null;
  }

  const localNameLen = localHeader.readUInt16LE(26);
  const localExtraLen = localHeader.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + 30 + localNameLen + localExtraLen;
  if (dataOffset + entry.compressedSize > fileSize) return null;

  const rawBuf = Buffer.allocUnsafe(entry.compressedSize);
  fs.readSync(fd, rawBuf, 0, entry.compressedSize, dataOffset);

  if (entry.compressionMethod === 0) {
    return rawBuf;
  }
  if (entry.compressionMethod === 8) {
    try {
      return zlib.inflateRawSync(rawBuf, { maxOutputLength: maxBytes });
    } catch {
      return null;
    }
  }
  return null;
}

function readStringPool(buf: Buffer, offset: number): StringPoolResult | null {
  if (offset + 28 > buf.length) return null;
  const type = buf.readUInt16LE(offset);
  if (type !== RES_STRING_POOL_TYPE) return null;

  const chunkSize = buf.readUInt32LE(offset + 4);
  const stringCount = buf.readUInt32LE(offset + 8);
  const flags = buf.readUInt32LE(offset + 16);
  const stringsStart = buf.readUInt32LE(offset + 20);
  const isUtf8 = (flags & (1 << 8)) !== 0;

  const headerSize = buf.readUInt16LE(offset + 2);
  const offsetsBase = offset + headerSize;
  const dataBase = offset + stringsStart;
  const chunkEnd = Math.min(offset + chunkSize, buf.length);
  const strings: string[] = [];

  for (let i = 0; i < stringCount; i++) {
    const idxPos = offsetsBase + i * 4;
    if (idxPos + 4 > chunkEnd) {
      strings.push('');
      continue;
    }
    const relOffset = buf.readUInt32LE(idxPos);
    let pos = dataBase + relOffset;
    if (pos >= chunkEnd) {
      strings.push('');
      continue;
    }

    try {
      if (isUtf8) {
        const charLen1 = buf[pos++];
        if ((charLen1 & 0x80) !== 0) pos++;
        let byteLen = buf[pos++];
        if ((byteLen & 0x80) !== 0 && pos < chunkEnd) {
          byteLen = ((byteLen & 0x7f) << 8) | buf[pos++];
        }
        const safeEnd = Math.min(pos + byteLen, chunkEnd);
        strings.push(buf.subarray(pos, safeEnd).toString('utf8'));
      } else {
        if (pos + 2 > chunkEnd) {
          strings.push('');
          continue;
        }
        let charLen = buf.readUInt16LE(pos);
        pos += 2;
        if ((charLen & 0x8000) !== 0 && pos + 2 <= chunkEnd) {
          charLen = ((charLen & 0x7fff) << 16) | buf.readUInt16LE(pos);
          pos += 2;
        }
        const byteLen = charLen * 2;
        const safeEnd = Math.min(pos + byteLen, chunkEnd);
        strings.push(buf.subarray(pos, safeEnd).toString('utf16le'));
      }
    } catch {
      strings.push('');
    }
  }

  return { strings, chunkEnd };
}

function parseBinaryXmlForManifest(buf: Buffer): ParsedManifest {
  const result: ParsedManifest = {
    packageName: '',
    versionName: '',
    labelText: null,
    labelResId: null,
    iconResId: null,
    roundIconResId: null,
  };

  if (buf.length < 8 || buf.readUInt16LE(0) !== RES_XML_TYPE) {
    return result;
  }

  let offset = buf.readUInt16LE(2);
  let strings: string[] = [];
  let resourceIds: number[] = [];

  while (offset + 8 <= buf.length) {
    const chunkType = buf.readUInt16LE(offset);
    const headerSize = buf.readUInt16LE(offset + 2);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkSize < 8 || offset + chunkSize > buf.length) break;

    if (chunkType === RES_STRING_POOL_TYPE) {
      const pool = readStringPool(buf, offset);
      if (pool) strings = pool.strings;
    } else if (chunkType === RES_XML_RESOURCE_MAP_TYPE) {
      const count = Math.floor((chunkSize - headerSize) / 4);
      resourceIds = [];
      for (let i = 0; i < count; i++) {
        resourceIds.push(buf.readUInt32LE(offset + headerSize + i * 4));
      }
    } else if (chunkType === RES_XML_START_ELEMENT_TYPE) {
      const extOffset = offset + headerSize;
      if (extOffset + 20 <= offset + chunkSize) {
        const nameIdx = buf.readInt32LE(extOffset + 4);
        const attrStart = buf.readUInt16LE(extOffset + 8);
        const attrSize = buf.readUInt16LE(extOffset + 10);
        const attrCount = buf.readUInt16LE(extOffset + 12);
        const tagName = nameIdx >= 0 && nameIdx < strings.length ? strings[nameIdx] : '';

        if (tagName === 'manifest' || tagName === 'application') {
          const attrsBase = extOffset + attrStart;
          for (let i = 0; i < attrCount; i++) {
            const aOff = attrsBase + i * attrSize;
            if (aOff + 20 > offset + chunkSize) break;
            const attrNameIdx = buf.readInt32LE(aOff + 4);
            const rawValueIdx = buf.readInt32LE(aOff + 8);
            const valueType = buf[aOff + 15];
            const valueData = buf.readUInt32LE(aOff + 16);

            const attrName =
              attrNameIdx >= 0 && attrNameIdx < strings.length ? strings[attrNameIdx] : '';
            const attrResId =
              attrNameIdx >= 0 && attrNameIdx < resourceIds.length ? resourceIds[attrNameIdx] : 0;

            const getStr = (): string => {
              if (valueType === TYPE_STRING && valueData < strings.length) {
                return strings[valueData];
              }
              if (rawValueIdx >= 0 && rawValueIdx < strings.length) {
                return strings[rawValueIdx];
              }
              return '';
            };

            if (tagName === 'manifest') {
              if (attrName === 'package' && !result.packageName) {
                result.packageName = getStr();
              } else if (
                (attrResId === ATTR_VERSION_NAME || attrName === 'versionName') &&
                !result.versionName
              ) {
                if (valueType === TYPE_STRING || rawValueIdx >= 0) {
                  result.versionName = getStr();
                }
              }
            } else if (tagName === 'application') {
              if (attrResId === ATTR_LABEL || attrName === 'label') {
                if (valueType === TYPE_REFERENCE) {
                  result.labelResId = valueData;
                } else {
                  const s = getStr();
                  if (s) result.labelText = s;
                }
              } else if (attrResId === ATTR_ICON || attrName === 'icon') {
                if (valueType === TYPE_REFERENCE) {
                  result.iconResId = valueData;
                }
              } else if (attrResId === ATTR_ROUND_ICON || attrName === 'roundIcon') {
                if (valueType === TYPE_REFERENCE) {
                  result.roundIconResId = valueData;
                }
              }
            }
          }
        }
      }
    }

    offset += chunkSize;
  }

  return result;
}

function parseAdaptiveIconForegroundResId(buf: Buffer): number | null {
  if (buf.length < 8 || buf.readUInt16LE(0) !== RES_XML_TYPE) return null;

  let offset = buf.readUInt16LE(2);
  let strings: string[] = [];
  let resourceIds: number[] = [];

  while (offset + 8 <= buf.length) {
    const chunkType = buf.readUInt16LE(offset);
    const headerSize = buf.readUInt16LE(offset + 2);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkSize < 8 || offset + chunkSize > buf.length) break;

    if (chunkType === RES_STRING_POOL_TYPE) {
      const pool = readStringPool(buf, offset);
      if (pool) strings = pool.strings;
    } else if (chunkType === RES_XML_RESOURCE_MAP_TYPE) {
      const count = Math.floor((chunkSize - headerSize) / 4);
      resourceIds = [];
      for (let i = 0; i < count; i++) {
        resourceIds.push(buf.readUInt32LE(offset + headerSize + i * 4));
      }
    } else if (chunkType === RES_XML_START_ELEMENT_TYPE) {
      const extOffset = offset + headerSize;
      if (extOffset + 20 <= offset + chunkSize) {
        const nameIdx = buf.readInt32LE(extOffset + 4);
        const attrStart = buf.readUInt16LE(extOffset + 8);
        const attrSize = buf.readUInt16LE(extOffset + 10);
        const attrCount = buf.readUInt16LE(extOffset + 12);
        const tagName = nameIdx >= 0 && nameIdx < strings.length ? strings[nameIdx] : '';

        if (tagName === 'foreground' || tagName === 'monochrome' || tagName === 'bitmap') {
          const attrsBase = extOffset + attrStart;
          for (let i = 0; i < attrCount; i++) {
            const aOff = attrsBase + i * attrSize;
            if (aOff + 20 > offset + chunkSize) break;
            const attrNameIdx = buf.readInt32LE(aOff + 4);
            const valueType = buf[aOff + 15];
            const valueData = buf.readUInt32LE(aOff + 16);
            const attrName =
              attrNameIdx >= 0 && attrNameIdx < strings.length ? strings[attrNameIdx] : '';
            const attrResId =
              attrNameIdx >= 0 && attrNameIdx < resourceIds.length ? resourceIds[attrNameIdx] : 0;

            if (
              (attrResId === ATTR_DRAWABLE || attrName === 'drawable' || attrName === 'src') &&
              valueType === TYPE_REFERENCE
            ) {
              return valueData;
            }
          }
        }
      }
    }

    offset += chunkSize;
  }

  return null;
}

function resolveResourcesFromArsc(buf: Buffer, targetResIds: Set<number>): Map<number, string[]> {
  const results = new Map<number, string[]>();
  if (targetResIds.size === 0 || buf.length < 12 || buf.readUInt16LE(0) !== RES_TABLE_TYPE) {
    return results;
  }

  const headerSize = buf.readUInt16LE(2);
  let offset = headerSize;
  let globalStrings: string[] = [];

  while (offset + 8 <= buf.length) {
    const chunkType = buf.readUInt16LE(offset);
    const chunkHeaderSize = buf.readUInt16LE(offset + 2);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkSize < 8 || offset + chunkSize > buf.length) break;

    if (chunkType === RES_STRING_POOL_TYPE) {
      const pool = readStringPool(buf, offset);
      if (pool) globalStrings = pool.strings;
    } else if (chunkType === RES_TABLE_PACKAGE_TYPE) {
      const pkgId = buf.readUInt32LE(offset + 8);
      let pkgOffset = offset + chunkHeaderSize;
      const pkgEnd = offset + chunkSize;

      while (pkgOffset + 8 <= pkgEnd) {
        const subType = buf.readUInt16LE(pkgOffset);
        const subHeaderSize = buf.readUInt16LE(pkgOffset + 2);
        const subSize = buf.readUInt32LE(pkgOffset + 4);
        if (subSize < 8 || pkgOffset + subSize > pkgEnd) break;

        if (subType === RES_TABLE_TYPE_TYPE && subHeaderSize >= 20) {
          const typeId = buf[pkgOffset + 8];
          const flags = buf[pkgOffset + 9];
          const entryCount = buf.readUInt32LE(pkgOffset + 12);
          const entriesStart = buf.readUInt32LE(pkgOffset + 16);
          const isSparse = (flags & 0x01) !== 0;
          const isOffset16 = (flags & 0x02) !== 0;

          const offsetsBase = pkgOffset + subHeaderSize;
          const dataBase = pkgOffset + entriesStart;

          for (const targetId of targetResIds) {
            const tPkg = (targetId >>> 24) & 0xff;
            const tType = (targetId >>> 16) & 0xff;
            const tEntry = targetId & 0xffff;

            if (tPkg !== pkgId || tType !== typeId) continue;

            let entryRelOffset = -1;
            if (!isSparse) {
              if (tEntry >= entryCount) continue;
              if (isOffset16) {
                const pos = offsetsBase + tEntry * 2;
                if (pos + 2 <= pkgOffset + subSize) {
                  const val = buf.readUInt16LE(pos);
                  if (val !== 0xffff) entryRelOffset = val * 4;
                }
              } else {
                const pos = offsetsBase + tEntry * 4;
                if (pos + 4 <= pkgOffset + subSize) {
                  const val = buf.readUInt32LE(pos);
                  if (val !== 0xffffffff) entryRelOffset = val;
                }
              }
            } else {
              for (let i = 0; i < entryCount; i++) {
                const pos = offsetsBase + i * 4;
                if (pos + 4 > pkgOffset + subSize) break;
                const idx = buf.readUInt16LE(pos);
                if (idx === tEntry) {
                  entryRelOffset = buf.readUInt16LE(pos + 2) * 4;
                  break;
                }
              }
            }

            if (entryRelOffset < 0) continue;
            const entryPos = dataBase + entryRelOffset;
            if (entryPos + 16 > pkgOffset + subSize) continue;

            const entrySize = buf.readUInt16LE(entryPos);
            const entryFlags = buf.readUInt16LE(entryPos + 2);
            const isComplex = (entryFlags & 0x0001) !== 0;
            const isCompact = (entryFlags & 0x0008) !== 0;

            let valueType = 0;
            let valueData = 0;
            if (isCompact) {
              valueType = (entryFlags >> 8) & 0xff;
              valueData = buf.readUInt32LE(entryPos + 4);
            } else if (!isComplex) {
              const valPos = entryPos + entrySize;
              if (valPos + 8 <= pkgOffset + subSize) {
                valueType = buf[valPos + 3];
                valueData = buf.readUInt32LE(valPos + 4);
              }
            }

            if (valueType === TYPE_STRING && valueData < globalStrings.length) {
              const strVal = globalStrings[valueData];
              if (strVal) {
                const existing = results.get(targetId) ?? [];
                if (!existing.includes(strVal)) {
                  existing.push(strVal);
                  results.set(targetId, existing);
                }
              }
            }
          }
        }

        pkgOffset += subSize;
      }
    }

    offset += chunkSize;
  }

  return results;
}

function getImageDimensions(buf: Buffer, ext: string): { width: number; height: number } | null {
  try {
    if (ext === '.png' && buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
      };
    }
    if (ext === '.webp' && buf.length >= 30 && buf.subarray(0, 4).toString('ascii') === 'RIFF') {
      const chunk = buf.subarray(12, 16).toString('ascii');
      if (chunk === 'VP8X' && buf.length >= 30) {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width: w, height: h };
      }
      if (chunk === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        const w = (bits & 0x3fff) + 1;
        const h = ((bits >> 14) & 0x3fff) + 1;
        return { width: w, height: h };
      }
      if (chunk === 'VP8 ' && buf.length >= 30) {
        const w = buf.readUInt16LE(26) & 0x3fff;
        const h = buf.readUInt16LE(28) & 0x3fff;
        return { width: w, height: h };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function scoreImagePath(entryPath: string, dims: { width: number; height: number } | null): number {
  const lower = entryPath.toLowerCase();
  const base = path.basename(lower);

  if (base.endsWith('.9.png')) return -1000;
  if (
    lower.includes('notif') ||
    lower.includes('ic_stat') ||
    lower.includes('abc_') ||
    lower.includes('mtrl_')
  ) {
    return -500;
  }

  let score = 0;

  if (/^ic_launcher\.(png|webp)$/.test(base)) score += 260;
  else if (/^ic_launcher_round\.(png|webp)$/.test(base)) score += 250;
  else if (/^ic_launcher_foreground\.(png|webp)$/.test(base)) score += 220;
  else if (/ic_launcher/.test(base)) score += 190;
  else if (/^(app_icon|icon|logo|launcher_icon|ic_app)\.(png|webp)$/.test(base)) score += 170;
  else if (/(app_icon|launcher|icon|logo)/.test(base)) score += 110;

  if (lower.includes('mipmap')) score += 90;
  else if (lower.includes('drawable')) score += 45;

  if (lower.includes('xxxhdpi')) score += 60;
  else if (lower.includes('xxhdpi')) score += 50;
  else if (lower.includes('xhdpi')) score += 40;
  else if (lower.includes('hdpi')) score += 30;
  else if (lower.includes('mdpi')) score += 15;

  if (dims) {
    const { width, height } = dims;
    if (width < 36 || height < 36) return -400;
    const ratio = width / Math.max(height, 1);
    if (ratio >= 0.95 && ratio <= 1.05) {
      score += 80;
    } else if (ratio >= 0.8 && ratio <= 1.25) {
      score += 20;
    } else {
      score -= 120;
    }

    if (width >= 144 && width <= 512) score += 60;
    else if (width >= 72 && width < 144) score += 40;
    else if (width > 512 && width <= 1024) score += 30;
  }

  return score;
}

function toDataUrl(buf: Buffer, entryName: string): string {
  const lower = entryName.toLowerCase();
  let mime = 'image/png';
  if (lower.endsWith('.webp')) mime = 'image/webp';
  else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) mime = 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function createFallbackSvgIcon(appName: string): string {
  const clean = appName.trim();
  const initial = clean ? Array.from(clean)[0].toUpperCase() : 'A';
  const safeInitial = initial.replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#059669"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
  </defs>
  <rect width="192" height="192" rx="44" fill="url(#g)"/>
  <text x="96" y="114" text-anchor="middle" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="84" font-weight="700">${safeInitial}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function cleanFileNameToAppName(originalFileName: string): string {
  const base = path.basename(originalFileName, path.extname(originalFileName));
  const cleaned = base
    .replace(/[_\-.]+/g, ' ')
    .replace(/\b(v?\d+(\.\d+)+|release|debug|signed|aligned|universal|arm64|armeabi)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || base || 'تطبيق أندرويد').slice(0, 100);
}

export function verifyZipSignature(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    return (
      bytesRead === 4 &&
      header[0] === 0x50 &&
      header[1] === 0x4b &&
      (header[2] === 0x03 || header[2] === 0x05)
    );
  } catch {
    return false;
  }
}

export function extractApkMetadata(filePath: string, originalFileName: string): ApkMetadata {
  const fallbackName = cleanFileNameToAppName(originalFileName);
  let fd: number | null = null;

  try {
    const stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, 'r');
    const entries = readZipCentralDirectory(fd, stat.size);

    const manifestEntry = entries.get('AndroidManifest.xml');
    const arscEntry = entries.get('resources.arsc');

    let manifest: ParsedManifest = {
      packageName: '',
      versionName: '',
      labelText: null,
      labelResId: null,
      iconResId: null,
      roundIconResId: null,
    };

    if (manifestEntry) {
      const manifestBuf = readZipEntryBuffer(fd, stat.size, manifestEntry, 8 * 1024 * 1024);
      if (manifestBuf) {
        try {
          manifest = parseBinaryXmlForManifest(manifestBuf);
        } catch {
          // Continue with heuristics
        }
      }
    }

    let resolvedName = manifest.labelText || '';
    const iconCandidatePaths: string[] = [];

    if (arscEntry && arscEntry.uncompressedSize <= 35 * 1024 * 1024) {
      const arscBuf = readZipEntryBuffer(fd, stat.size, arscEntry, 35 * 1024 * 1024);
      if (arscBuf) {
        try {
          const targetIds = new Set<number>();
          if (manifest.labelResId) targetIds.add(manifest.labelResId);
          if (manifest.iconResId) targetIds.add(manifest.iconResId);
          if (manifest.roundIconResId) targetIds.add(manifest.roundIconResId);

          const resolvedMap = resolveResourcesFromArsc(arscBuf, targetIds);

          if (!resolvedName && manifest.labelResId) {
            const labels = resolvedMap.get(manifest.labelResId) ?? [];
            const nonEmpty = labels.filter((l) => l.trim().length > 0 && !l.startsWith('res/'));
            const arabicLabel = nonEmpty.find((l) => /[\u0600-\u06FF]/.test(l));
            resolvedName = (arabicLabel || nonEmpty[0] || '').trim();
          }

          const rawIconPaths = [
            ...(manifest.iconResId ? resolvedMap.get(manifest.iconResId) ?? [] : []),
            ...(manifest.roundIconResId ? resolvedMap.get(manifest.roundIconResId) ?? [] : []),
          ];

          const xmlIconPaths: string[] = [];
          for (const p of rawIconPaths) {
            if (p.toLowerCase().endsWith('.xml')) {
              xmlIconPaths.push(p);
            } else {
              iconCandidatePaths.push(p);
            }
          }

          // Follow Adaptive Icon XML -> foreground drawable resource ID
          if (xmlIconPaths.length > 0) {
            const fgIds = new Set<number>();
            for (const xmlPath of xmlIconPaths) {
              const xmlEntry = entries.get(xmlPath.replace(/^\/+/, ''));
              if (!xmlEntry) continue;
              const xmlBuf = readZipEntryBuffer(fd, stat.size, xmlEntry, 512 * 1024);
              if (!xmlBuf) continue;
              try {
                const fgId = parseAdaptiveIconForegroundResId(xmlBuf);
                if (fgId) fgIds.add(fgId);
              } catch {
                continue;
              }
            }
            if (fgIds.size > 0) {
              const fgMap = resolveResourcesFromArsc(arscBuf, fgIds);
              for (const paths of fgMap.values()) {
                for (const p of paths) {
                  if (!p.toLowerCase().endsWith('.xml')) {
                    iconCandidatePaths.push(p);
                  }
                }
              }
            }
          }
        } catch {
          // Continue with heuristics
        }
      }
    }

    const finalName = (resolvedName || fallbackName).slice(0, 120);

    // Priority 1: Manifest-resolved icon paths
    let bestManifest: { name: string; data: Buffer; score: number } | null = null;
    for (const rawPath of iconCandidatePaths) {
      const normalized = rawPath.replace(/^\/+/, '');
      const lower = normalized.toLowerCase();
      if (
        !lower.endsWith('.png') &&
        !lower.endsWith('.webp') &&
        !lower.endsWith('.jpg') &&
        !lower.endsWith('.jpeg')
      ) {
        continue;
      }
      if (lower.endsWith('.9.png')) continue;

      const entry = entries.get(normalized);
      if (!entry) continue;
      const data = readZipEntryBuffer(fd, stat.size, entry, 2 * 1024 * 1024);
      if (!data || data.length === 0) continue;

      const dims = getImageDimensions(data, path.extname(lower));
      let score = scoreImagePath(normalized, dims) + 220;
      if (dims) score += Math.min(dims.width, 512) * 0.2;
      if (!bestManifest || score > bestManifest.score) {
        bestManifest = { name: normalized, data, score };
      }
    }

    if (bestManifest) {
      return {
        extractedName: finalName,
        packageName: manifest.packageName.slice(0, 180),
        versionName: manifest.versionName.slice(0, 60),
        iconDataUrl: toDataUrl(bestManifest.data, bestManifest.name),
        iconSource: 'manifest',
      };
    }

    // Priority 2: Smart heuristic scan of Central Directory (reads ONLY top candidates!)
    const preCandidates: Array<{ entry: ZipEntryMeta; preScore: number }> = [];
    for (const entry of entries.values()) {
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith('.png') && !lower.endsWith('.webp')) continue;
      if (lower.endsWith('.9.png')) continue;
      if (entry.uncompressedSize <= 0 || entry.uncompressedSize > 2 * 1024 * 1024) continue;

      const preScore = scoreImagePath(entry.name, null);
      if (preScore > 0) {
        preCandidates.push({ entry, preScore });
      }
    }

    // Sort by filename/directory score and inspect only top 25 candidates from disk
    preCandidates.sort((a, b) => b.preScore - a.preScore);
    const topCandidates = preCandidates.slice(0, 25);

    let bestHeuristic: { name: string; data: Buffer; score: number } | null = null;
    for (const { entry } of topCandidates) {
      const data = readZipEntryBuffer(fd, stat.size, entry, 2 * 1024 * 1024);
      if (!data || data.length === 0) continue;
      const dims = getImageDimensions(data, path.extname(entry.name.toLowerCase()));
      const score = scoreImagePath(entry.name, dims);
      if (score > 0 && (!bestHeuristic || score > bestHeuristic.score)) {
        bestHeuristic = { name: entry.name, data, score };
      }
    }

    if (bestHeuristic) {
      return {
        extractedName: finalName,
        packageName: manifest.packageName.slice(0, 180),
        versionName: manifest.versionName.slice(0, 60),
        iconDataUrl: toDataUrl(bestHeuristic.data, bestHeuristic.name),
        iconSource: 'heuristic',
      };
    }

    // Priority 3: Crisp fallback SVG icon
    return {
      extractedName: finalName,
      packageName: manifest.packageName.slice(0, 180),
      versionName: manifest.versionName.slice(0, 60),
      iconDataUrl: createFallbackSvgIcon(finalName),
      iconSource: 'fallback',
    };
  } catch {
    return {
      extractedName: fallbackName,
      packageName: '',
      versionName: '',
      iconDataUrl: createFallbackSvgIcon(fallbackName),
      iconSource: 'fallback',
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }
}

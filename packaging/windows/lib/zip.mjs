// Minimal, dependency-free ZIP reader used to extract the portable Node.js runtime from the official
// node-v<version>-win-x64.zip. Only what that archive needs: stored (0) and deflate (8) entries, ZIP64 sizes and
// offsets. Every extracted entry is checked against the size and CRC-32 recorded in the central directory.
import { crc32, inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

/**
 * @typedef {{ name: string, method: number, crc32: number, compressedSize: number, size: number,
 *   localHeaderOffset: number, isDirectory: boolean }} ZipEntry
 */

/** @param {Buffer} zip @returns {ZipEntry[]} */
export function readZipEntries(zip) {
  const eocd = findEndOfCentralDirectory(zip);
  let count = zip.readUInt16LE(eocd + 10);
  let directoryOffset = zip.readUInt32LE(eocd + 16);
  if (count === MAX_U16 || directoryOffset === MAX_U32) {
    const locator = eocd - 20;
    if (locator < 0 || zip.readUInt32LE(locator) !== ZIP64_EOCD_LOCATOR_SIGNATURE) {
      throw new Error('ZIP: ZIP64 end-of-central-directory locator not found');
    }
    const zip64 = toSafeNumber(zip.readBigUInt64LE(locator + 8));
    if (zip.readUInt32LE(zip64) !== ZIP64_EOCD_SIGNATURE) throw new Error('ZIP: invalid ZIP64 end of central directory');
    count = toSafeNumber(zip.readBigUInt64LE(zip64 + 32));
    directoryOffset = toSafeNumber(zip.readBigUInt64LE(zip64 + 48));
  }

  /** @type {ZipEntry[]} */
  const entries = [];
  let position = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(position) !== CENTRAL_SIGNATURE) throw new Error(`ZIP: bad central directory header #${index}`);
    const method = zip.readUInt16LE(position + 10);
    const entryCrc = zip.readUInt32LE(position + 16);
    let compressedSize = zip.readUInt32LE(position + 20);
    let size = zip.readUInt32LE(position + 24);
    const nameLength = zip.readUInt16LE(position + 28);
    const extraLength = zip.readUInt16LE(position + 30);
    const commentLength = zip.readUInt16LE(position + 32);
    let localHeaderOffset = zip.readUInt32LE(position + 42);
    const name = zip.toString('utf8', position + 46, position + 46 + nameLength);
    const extraStart = position + 46 + nameLength;
    const zip64 = readZip64Extra(zip.subarray(extraStart, extraStart + extraLength));
    // ZIP64 extra values appear only for fields saturated at 0xFFFFFFFF, in this fixed order.
    if (size === MAX_U32) size = zip64.shift() ?? fail(name, 'size');
    if (compressedSize === MAX_U32) compressedSize = zip64.shift() ?? fail(name, 'compressed size');
    if (localHeaderOffset === MAX_U32) localHeaderOffset = zip64.shift() ?? fail(name, 'offset');
    entries.push({ name, method, crc32: entryCrc, compressedSize, size, localHeaderOffset, isDirectory: name.endsWith('/') });
    position = extraStart + extraLength + commentLength;
  }
  return entries;
}

/** @param {Buffer} zip @param {ZipEntry} entry @returns {Buffer} */
export function extractEntry(zip, entry) {
  const header = entry.localHeaderOffset;
  if (zip.readUInt32LE(header) !== LOCAL_SIGNATURE) throw new Error(`ZIP: bad local header for ${entry.name}`);
  const dataStart = header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28);
  const raw = zip.subarray(dataStart, dataStart + entry.compressedSize);
  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = inflateRawSync(raw);
  else throw new Error(`ZIP: unsupported compression method ${entry.method} for ${entry.name}`);
  if (data.length !== entry.size) throw new Error(`ZIP: size mismatch for ${entry.name} (${data.length} != ${entry.size})`);
  const actualCrc = crc32(data);
  if (actualCrc !== entry.crc32) throw new Error(`ZIP: CRC-32 mismatch for ${entry.name}`);
  return data;
}

/** @param {Buffer} zip */
function findEndOfCentralDirectory(zip) {
  const lowest = Math.max(0, zip.length - 22 - MAX_U16);
  for (let position = zip.length - 22; position >= lowest; position--) {
    if (zip.readUInt32LE(position) === EOCD_SIGNATURE) return position;
  }
  throw new Error('ZIP: end of central directory not found (is this a ZIP file?)');
}

/** @param {Buffer} extra @returns {number[]} */
function readZip64Extra(extra) {
  for (let position = 0; position + 4 <= extra.length;) {
    const id = extra.readUInt16LE(position);
    const length = extra.readUInt16LE(position + 2);
    if (id === 0x0001) {
      const values = [];
      for (let offset = position + 4; offset + 8 <= position + 4 + length; offset += 8) {
        values.push(toSafeNumber(extra.readBigUInt64LE(offset)));
      }
      return values;
    }
    position += 4 + length;
  }
  return [];
}

/** @param {bigint} value */
function toSafeNumber(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP: value too large');
  return Number(value);
}

/** @param {string} name @param {string} field @returns {never} */
function fail(name, field) {
  throw new Error(`ZIP: missing ZIP64 ${field} for ${name}`);
}

'use strict';

/**
 * @file Test data: hand-built JPEG and PNG files, temporary sites and a
 * logger that records messages.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * @typedef {Object} RecordingLogger
 * @property {Array<string>} logs - Messages passed to log().
 * @property {Array<string>} warnings - Messages passed to warn().
 * @property {Array<string>} errors - Messages passed to error().
 * @property {function(string): void} log - Records an informational message.
 * @property {function(string): void} warn - Records a warning.
 * @property {function(string): void} error - Records an error.
 */

/**
 * A logger that remembers every message instead of printing it.
 *
 * @returns {RecordingLogger} The logger.
 */
function recordingLogger() {
  const logger = { logs: [], warnings: [], errors: [], log: null, warn: null, error: null };

  /**
   * Record an informational message.
   *
   * @param {string} message - The message.
   * @returns {void}
   */
  function log(message) {
    logger.logs.push(message);
  }

  /**
   * Record a warning.
   *
   * @param {string} message - The message.
   * @returns {void}
   */
  function warn(message) {
    logger.warnings.push(message);
  }

  /**
   * Record an error.
   *
   * @param {string} message - The message.
   * @returns {void}
   */
  function error(message) {
    logger.errors.push(message);
  }

  logger.log = log;
  logger.warn = warn;
  logger.error = error;
  return logger;
}

/**
 * Bytes from a hexadecimal string; spaces are ignored.
 *
 * @param {string} text - For example `ff d8`.
 * @returns {Buffer} The bytes.
 */
function hex(text) {
  return Buffer.from(text.replace(/\s+/g, ''), 'hex');
}

/**
 * A JPEG segment: 0xFF, the marker, a big-endian length and the payload.
 *
 * @param {number} marker - Marker byte.
 * @param {Buffer} payload - Segment contents after the length field.
 * @returns {Buffer} The segment.
 */
function segment(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/**
 * A TIFF structure with one directory.
 *
 * @param {boolean} littleEndian - Byte order.
 * @param {Array<{tag: number, value: number}>} entries - SHORT entries of the directory.
 * @returns {Buffer} TIFF header and directory.
 */
function tiff(littleEndian, entries) {
  const data = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
  if (littleEndian) {
    data.write('II', 0, 'latin1');
    data.writeUInt16LE(42, 2);
    data.writeUInt32LE(8, 4);
    data.writeUInt16LE(entries.length, 8);
  } else {
    data.write('MM', 0, 'latin1');
    data.writeUInt16BE(42, 2);
    data.writeUInt32BE(8, 4);
    data.writeUInt16BE(entries.length, 8);
  }
  for (let index = 0; index < entries.length; index += 1) {
    const offset = 10 + index * 12;
    if (littleEndian) {
      data.writeUInt16LE(entries[index].tag, offset);
      data.writeUInt16LE(3, offset + 2);
      data.writeUInt32LE(1, offset + 4);
      data.writeUInt16LE(entries[index].value, offset + 8);
    } else {
      data.writeUInt16BE(entries[index].tag, offset);
      data.writeUInt16BE(3, offset + 2);
      data.writeUInt32BE(1, offset + 4);
      data.writeUInt16BE(entries[index].value, offset + 8);
    }
  }
  return data;
}

/**
 * An APP1 EXIF segment.
 *
 * @param {Buffer} tiffData - TIFF structure (see tiff()).
 * @param {Buffer} extra - Bytes appended after the TIFF data (fake GPS text, thumbnails).
 * @returns {Buffer} The segment.
 */
function exifSegment(tiffData, extra) {
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), tiffData, extra]));
}

/**
 * A Start Of Frame segment.
 *
 * @param {number} marker - SOF marker byte, for example 0xC0 or 0xC2.
 * @param {number} width - Image width.
 * @param {number} height - Image height.
 * @returns {Buffer} The segment (19 bytes).
 */
function frame(marker, width, height) {
  const payload = Buffer.alloc(15);
  payload[0] = 8;
  payload.writeUInt16BE(height, 1);
  payload.writeUInt16BE(width, 3);
  payload[5] = 3;
  return segment(marker, payload);
}

/**
 * Start Of Scan, compressed data (including a stuffed 0xFF 0x00) and End Of Image.
 * @type {Buffer}
 */
const SCAN_AND_END = hex('ff da 00 08 01 01 00 00 3f 00  12 34 ff 00 56  ff d9');

/**
 * A complete JPEG like a camera writes it: JFIF, EXIF with an orientation,
 * fake GPS text and an embedded thumbnail (with its own, smaller frame header),
 * XMP, an ICC profile, Photoshop/IPTC data, a comment, the frame header and image data.
 *
 * @param {number} orientation - EXIF orientation to store.
 * @returns {Buffer} The file.
 */
function cameraJpeg(orientation) {
  const thumbnail = Buffer.concat([hex('ff d8'), frame(0xc0, 160, 120), hex('ff d9')]);
  return Buffer.concat([
    hex('ff d8'),
    segment(0xe0, Buffer.from('JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000', 'latin1')),
    exifSegment(tiff(false, [{ tag: 0x0112, value: orientation }]), Buffer.concat([Buffer.from('GPS 49.87N 8.65E', 'latin1'), thumbnail])),
    segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta/>', 'latin1')),
    segment(0xe2, Buffer.from('ICC_PROFILE\u0000\u0001\u0001profile', 'latin1')),
    segment(0xed, Buffer.from('Photoshop 3.0\u0000IPTC', 'latin1')),
    segment(0xfe, Buffer.from('a comment', 'latin1')),
    frame(0xc0, 2048, 1536),
    SCAN_AND_END,
  ]);
}

/**
 * A PNG chunk (the CRC is not checked by the generator and left zero).
 *
 * @param {string} type - Four-letter chunk type.
 * @param {Buffer} data - Chunk data.
 * @returns {Buffer} The chunk.
 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

/**
 * The PNG signature.
 * @type {Buffer}
 */
const PNG_SIGNATURE = hex('89 50 4e 47 0d 0a 1a 0a');

/**
 * A PNG header chunk.
 *
 * @param {number} width - Image width.
 * @param {number} height - Image height.
 * @returns {Buffer} The IHDR chunk.
 */
function pngHeader(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  return pngChunk('IHDR', data);
}

/**
 * A PNG with every kind of metadata chunk the generator removes.
 *
 * @returns {Buffer} The file.
 */
function metadataPng() {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngHeader(300, 200),
    pngChunk('tEXt', Buffer.from('Author\u0000secret-text', 'latin1')),
    pngChunk('zTXt', Buffer.from('secret-ztxt', 'latin1')),
    pngChunk('iTXt', Buffer.from('secret-itxt', 'latin1')),
    pngChunk('eXIf', Buffer.from('secret-exif', 'latin1')),
    pngChunk('tIME', Buffer.from('secret-time', 'latin1')),
    pngChunk('IDAT', hex('01 02 03')),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The same PNG as metadataPng() without the metadata chunks.
 *
 * @returns {Buffer} The file.
 */
function cleanPng() {
  return Buffer.concat([PNG_SIGNATURE, pngHeader(300, 200), pngChunk('IDAT', hex('01 02 03')), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Create an empty temporary directory.
 *
 * @returns {string} Its path.
 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'generator-qa-'));
}

/**
 * Write files below a directory, creating folders as needed.
 *
 * @param {string} root - Base directory.
 * @param {Object<string, (string|Buffer)>} files - Relative path to contents.
 * @returns {void}
 */
function writeFiles(root, files) {
  for (const relative of Object.keys(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files[relative]);
  }
}

/**
 * The article template used by site tests: every placeholder on its own line.
 * @type {string}
 */
const ARTICLE_TEMPLATE = [
  '<html lang="{{lang}}"><head>',
  '<link rel="stylesheet" href="{{root}}style.css">',
  '<meta property="og:image" content="{{ogImage}}">',
  '<meta property="og:image:width" content="{{ogImageWidth}}">',
  '<meta property="og:image:height" content="{{ogImageHeight}}">',
  '<meta name="twitter:image" content="{{ogImage}}">',
  '<meta property="og:url" content="{{ogUrl}}">',
  '<meta property="og:description" content="{{explanation}}">',
  '<meta name="twitter:description" content="{{explanation}}">',
  '</head><body><a href="{{logoHref}}">Home</a><h1>{{title}}</h1>',
  '<p class="article-authors">{{authors}}</p>',
  '<img src="{{image}}" alt="{{title}}" class="article-hero">',
  '<p class="article-explanation">{{explanation}}</p>',
  '{{content}}',
  '{{footer}}</body></html>',
].join('\n');

/**
 * The index template used by site tests.
 * @type {string}
 */
const INDEX_TEMPLATE = [
  '<html lang="{{lang}}"><a href="{{logoHref}}">Home</a>',
  '<h1>{{homeTitle}}</h1><img src="{{homeImage}}">',
  '<p>{{homeParagraph1}}</p><p>{{homeParagraph2}}</p><p>{{homeParagraph3}}</p><p>{{homeParagraph4}}</p>',
  '{{categories}}',
  '{{footer}}</html>',
].join('\n');

/**
 * Create a complete example site in a temporary directory: templates, a
 * home article, two articles in a category, a draft and a file without
 * frontmatter.
 *
 * @returns {string} The site's root directory.
 */
function makeSite() {
  const root = tempDir();
  writeFiles(root, {
    'templates/style.css': 'body{}',
    'templates/index.html': INDEX_TEMPLATE,
    'templates/article.html': ARTICLE_TEMPLATE,
    'templates/footer.html': '<footer><a href="{{root}}legal/impressum.html">Impressum</a></footer>',
    'templates/images/logo.jpg': cameraJpeg(1),
    'templates/images/nested/icon.png': metadataPng(),
    'templates/fonts/font.woff2': 'font-bytes',
    'content/home/start/start.md':
      '---\ncategory: Home\ntitle: Welcome\nimage: images/home.jpg\ntoc: false\n---\nFirst _one_.\n\nSecond\nline.\n\n[Doc](pdfs/x.pdf)\n\nFourth\n\nFifth is ignored',
    'content/home/start/images/home.jpg': cameraJpeg(1),
    'content/cat/b-second/b.md': '---\ncategory: Cat\ntitle: Second\nauthors: Ann\n---\nBody $$ text',
    'content/cat/a-first/a.md':
      '---\r\ncategory: Cat\r\ntitle: First "quoted"\r\nimage: images/p.jpg\r\nexplanation: Ex "1"\r\nlang: de\r\norder: 2\r\n---\r\nHello',
    'content/cat/a-first/images/p.jpg': cameraJpeg(6),
    'content/cat/a-first/pdfs/doc.pdf': 'pdf-bytes',
    'content/cat/a-first/pdfs/scan.jpg': cameraJpeg(1),
    'content/cat/draft/d.md': '---\ncategory: Cat\ntitle: Draft\ndraft: true\n---\nNot yet',
    'content/cat/notes/n.md': 'no frontmatter here',
    'content/cat/notes/readme.txt': 'not markdown',
  });
  return root;
}

module.exports = {
  ARTICLE_TEMPLATE: ARTICLE_TEMPLATE,
  INDEX_TEMPLATE: INDEX_TEMPLATE,
  PNG_SIGNATURE: PNG_SIGNATURE,
  SCAN_AND_END: SCAN_AND_END,
  cameraJpeg: cameraJpeg,
  cleanPng: cleanPng,
  exifSegment: exifSegment,
  frame: frame,
  hex: hex,
  makeSite: makeSite,
  metadataPng: metadataPng,
  pngChunk: pngChunk,
  pngHeader: pngHeader,
  recordingLogger: recordingLogger,
  segment: segment,
  tempDir: tempDir,
  tiff: tiff,
  writeFiles: writeFiles,
};

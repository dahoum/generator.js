'use strict';

/**
 * @file Tests for JPEG parsing, orientation and metadata removal.
 */

const assert = require('node:assert');
const test = require('node:test');

const generator = require('../helpers/subject.js').generator;
const fixtures = require('../helpers/fixtures.js');

const hex = fixtures.hex;
const segment = fixtures.segment;

/**
 * Standalone markers are TEM (0x01) and RST0-RST7 (0xD0-0xD7), nothing else.
 *
 * @returns {void}
 */
function standaloneMarkers() {
  assert.strictEqual(generator.isStandaloneJpegMarker(0x01), true);
  assert.strictEqual(generator.isStandaloneJpegMarker(0xd0), true);
  assert.strictEqual(generator.isStandaloneJpegMarker(0xd7), true);
  assert.strictEqual(generator.isStandaloneJpegMarker(0x00), false);
  assert.strictEqual(generator.isStandaloneJpegMarker(0x02), false);
  assert.strictEqual(generator.isStandaloneJpegMarker(0xcf), false);
  assert.strictEqual(generator.isStandaloneJpegMarker(0xd8), false);
}
test('isStandaloneJpegMarker accepts TEM and RST0-RST7 only', standaloneMarkers);

/**
 * Frame markers are 0xC0-0xCF without 0xC4, 0xC8 and 0xCC.
 *
 * @returns {void}
 */
function frameMarkers() {
  const frames = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
  for (let marker = 0xbf; marker <= 0xd0; marker += 1) {
    assert.strictEqual(generator.isStartOfFrameMarker(marker), frames.includes(marker), 'marker ' + String(marker));
  }
}
test('isStartOfFrameMarker accepts SOF0-SOF15 except DHT, JPG and DAC', frameMarkers);

/**
 * A regular file is split into its segments up to the image data.
 *
 * @returns {void}
 */
function layoutOfRegularFile() {
  const file = Buffer.concat([hex('ff d8'), segment(0xe0, hex('aa')), hex('ff ff'), hex('ff d0'), fixtures.frame(0xc0, 3, 2), fixtures.SCAN_AND_END]);
  assert.deepStrictEqual(generator.readJpegLayout(file), {
    segments: [
      { marker: 0xe0, start: 2, end: 7 },
      { marker: 0xd0, start: 9, end: 11 },
      { marker: 0xc0, start: 11, end: 30 },
    ],
    scanStart: 30,
  });
}
test('readJpegLayout lists segments, skips fill bytes and finds the image data', layoutOfRegularFile);

/**
 * Files that are not JPEGs, or end early, give no image data offset.
 *
 * @returns {void}
 */
function layoutOfBrokenFiles() {
  const empty = { segments: [], scanStart: -1 };
  assert.deepStrictEqual(generator.readJpegLayout(Buffer.alloc(0)), empty);
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff')), empty);
  assert.deepStrictEqual(generator.readJpegLayout(hex('00 d8 ff da')), empty);
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff 00 ff da')), empty);
  // A byte that is not a marker prefix stops the walk.
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff d8 00 da')), empty);
  // End Of Image before any image data.
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff d8 ff d9 00 02 ff da')), empty);
  // A segment header that is cut off.
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff d8 ff e0 00')), empty);
  // A segment that claims to be longer than the file.
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff d8 ff e0 00 09 00 00')), empty);
  // Only the start marker.
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff d8')), empty);
}
test('readJpegLayout stops at broken or truncated data', layoutOfBrokenFiles);

/**
 * Segments that end exactly at the end of the data are still read, and
 * markers in the last two bytes are still recognised.
 *
 * @returns {void}
 */
function layoutAtTheVeryEnd() {
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff d8 ff e0 00 02')), {
    segments: [{ marker: 0xe0, start: 2, end: 6 }],
    scanStart: -1,
  });
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff d8 ff e0 00 03 aa')), {
    segments: [{ marker: 0xe0, start: 2, end: 7 }],
    scanStart: -1,
  });
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff d8 ff d0')), {
    segments: [{ marker: 0xd0, start: 2, end: 4 }],
    scanStart: -1,
  });
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff d8 ff da')), { segments: [], scanStart: 2 });
  assert.deepStrictEqual(generator.readJpegLayout(hex('ff d8 ff 01 ff da')), {
    segments: [{ marker: 0x01, start: 2, end: 4 }],
    scanStart: 4,
  });
}
test('readJpegLayout reads segments that end exactly at the end of the data', layoutAtTheVeryEnd);

/**
 * Integers are read in the requested byte order.
 *
 * @returns {void}
 */
function readsBothByteOrders() {
  const data = hex('01 02 03 04');
  assert.strictEqual(generator.readUInt16(data, 1, true), 0x0302);
  assert.strictEqual(generator.readUInt16(data, 1, false), 0x0203);
  assert.strictEqual(generator.readUInt32(data, 0, true), 0x04030201);
  assert.strictEqual(generator.readUInt32(data, 0, false), 0x01020304);
}
test('readUInt16 and readUInt32 honour the byte order', readsBothByteOrders);

/**
 * The orientation is read in both byte orders and from any entry position.
 *
 * @returns {void}
 */
function readsOrientation() {
  const big = fixtures.exifSegment(fixtures.tiff(false, [{ tag: 0x0112, value: 6 }]), Buffer.alloc(0));
  const little = fixtures.exifSegment(fixtures.tiff(true, [{ tag: 0x0112, value: 3 }]), Buffer.alloc(0));
  const second = fixtures.exifSegment(fixtures.tiff(false, [{ tag: 0x0100, value: 7 }, { tag: 0x0112, value: 8 }]), Buffer.alloc(0));
  assert.strictEqual(generator.readExifOrientation(big), 6);
  assert.strictEqual(generator.readExifOrientation(little), 3);
  assert.strictEqual(generator.readExifOrientation(second), 8);
}
test('readExifOrientation reads the orientation tag', readsOrientation);

/**
 * Values outside 1-8 and missing tags mean "upright".
 *
 * @returns {void}
 */
function invalidOrientations() {
  /**
   * An EXIF segment with one orientation entry.
   *
   * @param {number} value - Stored orientation value.
   * @returns {Buffer} The segment.
   */
  function make(value) {
    return fixtures.exifSegment(fixtures.tiff(false, [{ tag: 0x0112, value: value }]), Buffer.alloc(0));
  }
  assert.strictEqual(generator.readExifOrientation(make(0)), 1);
  assert.strictEqual(generator.readExifOrientation(make(9)), 1);
  assert.strictEqual(generator.readExifOrientation(make(2)), 2);
  assert.strictEqual(generator.readExifOrientation(make(1)), 1);
  const noTag = fixtures.exifSegment(fixtures.tiff(false, [{ tag: 0x0100, value: 6 }]), Buffer.alloc(0));
  assert.strictEqual(generator.readExifOrientation(noTag), 1);
}
test('readExifOrientation treats invalid or missing values as upright', invalidOrientations);

/**
 * Only the declared number of entries is read, even if more data follows.
 *
 * @returns {void}
 */
function readsOnlyDeclaredEntries() {
  const data = fixtures.tiff(false, [{ tag: 0x0100, value: 1 }, { tag: 0x0112, value: 6 }]);
  data.writeUInt16BE(1, 8); // claim one entry; the orientation entry is beyond it
  assert.strictEqual(generator.readExifOrientation(fixtures.exifSegment(data, Buffer.alloc(0))), 1);
}
test('readExifOrientation reads only the declared entries', readsOnlyDeclaredEntries);

/**
 * Segments without the EXIF identifier, or with truncated data, give 1.
 *
 * @returns {void}
 */
function orientationOfOtherSegments() {
  const valid = fixtures.tiff(false, [{ tag: 0x0112, value: 6 }]);
  const notExif = segment(0xe1, Buffer.concat([Buffer.from('Exix\u0000\u0000', 'latin1'), valid]));
  assert.strictEqual(generator.readExifOrientation(notExif), 1);
  const truncated = segment(0xe1, Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), hex('4d 4d 00 2a 00 00 00 08 00 05')]));
  assert.strictEqual(generator.readExifOrientation(truncated), 1);
}
test('readExifOrientation ignores non-EXIF and truncated segments', orientationOfOtherSegments);

/**
 * The orientation-only segment has exactly the expected bytes and reads back.
 *
 * @returns {void}
 */
function orientationSegmentBytes() {
  const bytes = generator.exifOrientationSegment(6);
  assert.strictEqual(
    bytes.toString('hex'),
    'ffe10022' + '457869660000' + '4d4d002a00000008' + '0001' + '011200030000000100060000' + '00000000'
  );
  assert.strictEqual(generator.readExifOrientation(bytes), 6);
}
test('exifOrientationSegment writes a minimal big-endian EXIF block', orientationSegmentBytes);

/**
 * A later APP1 segment without orientation does not reset an earlier one,
 * and EXIF-like data in other segments is ignored.
 *
 * @returns {void}
 */
function orientationAcrossSegments() {
  const file = fixtures.cameraJpeg(6);
  const layout = generator.readJpegLayout(file);
  assert.strictEqual(generator.findJpegOrientation(file, layout.segments), 6);

  const exifInApp0 = Buffer.concat([
    hex('ff d8'),
    segment(0xe0, Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), fixtures.tiff(false, [{ tag: 0x0112, value: 6 }])])),
    fixtures.SCAN_AND_END,
  ]);
  assert.strictEqual(generator.findJpegOrientation(exifInApp0, generator.readJpegLayout(exifInApp0).segments), 1);
}
test('findJpegOrientation keeps the EXIF orientation and ignores other segments', orientationAcrossSegments);

/**
 * The size comes from the frame header, not from the thumbnail inside EXIF.
 *
 * @returns {void}
 */
function sizeFromFrameHeader() {
  assert.deepStrictEqual(generator.getJpegInfo(fixtures.cameraJpeg(1)), { width: 2048, height: 1536, orientation: 1 });
  assert.deepStrictEqual(generator.getJpegInfo(fixtures.cameraJpeg(8)), { width: 2048, height: 1536, orientation: 8 });
}
test('getJpegInfo reads the frame header, not the EXIF thumbnail', sizeFromFrameHeader);

/**
 * Progressive JPEGs (SOF2) are read; a DHT segment (0xC4) is not mistaken for a frame.
 *
 * @returns {void}
 */
function progressiveAndHuffman() {
  const file = Buffer.concat([hex('ff d8'), segment(0xc4, Buffer.alloc(15, 1)), fixtures.frame(0xc2, 640, 480), fixtures.SCAN_AND_END]);
  assert.deepStrictEqual(generator.getJpegInfo(file), { width: 640, height: 480, orientation: 1 });
}
test('getJpegInfo reads progressive JPEGs and skips Huffman tables', progressiveAndHuffman);

/**
 * A frame header must be at least 9 bytes long to hold a size.
 *
 * @returns {void}
 */
function shortFrameHeaders() {
  const nine = Buffer.concat([hex('ff d8'), segment(0xc0, hex('08 00 02 00 03')), fixtures.SCAN_AND_END]);
  assert.deepStrictEqual(generator.getJpegInfo(nine), { width: 3, height: 2, orientation: 1 });
  const eight = Buffer.concat([hex('ff d8'), segment(0xc0, hex('08 00 02 00')), fixtures.frame(0xc1, 5, 4), fixtures.SCAN_AND_END]);
  assert.deepStrictEqual(generator.getJpegInfo(eight), { width: 5, height: 4, orientation: 1 });
  assert.strictEqual(generator.getJpegInfo(Buffer.concat([hex('ff d8'), fixtures.SCAN_AND_END])), null);
  assert.strictEqual(generator.getJpegInfo(fixtures.metadataPng()), null);
}
test('getJpegInfo needs a complete frame header', shortFrameHeaders);

/**
 * Which segments count as metadata.
 *
 * @returns {void}
 */
function metadataSegments() {
  const any = Buffer.alloc(20);
  const icc = segment(0xe2, Buffer.from('ICC_PROFILE\u0000data', 'latin1'));
  const flashpix = segment(0xe2, Buffer.from('FPXR\u0000data', 'latin1'));
  assert.strictEqual(generator.isJpegMetadataSegment(0xe1, any), true);
  assert.strictEqual(generator.isJpegMetadataSegment(0xe2, icc), false);
  assert.strictEqual(generator.isJpegMetadataSegment(0xe2, flashpix), true);
  for (let marker = 0xe3; marker <= 0xed; marker += 1) {
    assert.strictEqual(generator.isJpegMetadataSegment(marker, any), true, 'APP marker ' + String(marker));
  }
  assert.strictEqual(generator.isJpegMetadataSegment(0xee, any), false);
  assert.strictEqual(generator.isJpegMetadataSegment(0xef, any), true);
  assert.strictEqual(generator.isJpegMetadataSegment(0xfe, any), true);
  assert.strictEqual(generator.isJpegMetadataSegment(0xe0, any), false);
  assert.strictEqual(generator.isJpegMetadataSegment(0xc0, any), false);
  assert.strictEqual(generator.isJpegMetadataSegment(0xdb, any), false);
}
test('isJpegMetadataSegment removes EXIF/XMP/IPTC/comments and keeps image data', metadataSegments);

/**
 * A camera photo loses all metadata and keeps JFIF, ICC, frame and image data.
 *
 * @returns {void}
 */
function stripsCameraPhoto() {
  const output = generator.stripJpegMetadata(fixtures.cameraJpeg(1));
  const expected = Buffer.concat([
    hex('ff d8'),
    segment(0xe0, Buffer.from('JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000', 'latin1')),
    segment(0xe2, Buffer.from('ICC_PROFILE\u0000\u0001\u0001profile', 'latin1')),
    fixtures.frame(0xc0, 2048, 1536),
    fixtures.SCAN_AND_END,
  ]);
  assert.strictEqual(output.toString('hex'), expected.toString('hex'));
}
test('stripJpegMetadata removes EXIF, GPS, XMP, IPTC and comments', stripsCameraPhoto);

/**
 * A rotated photo keeps only its orientation, placed after the JFIF segment.
 *
 * @returns {void}
 */
function keepsOrientationAfterJfif() {
  const output = generator.stripJpegMetadata(fixtures.cameraJpeg(6));
  const expected = Buffer.concat([
    hex('ff d8'),
    segment(0xe0, Buffer.from('JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000', 'latin1')),
    generator.exifOrientationSegment(6),
    segment(0xe2, Buffer.from('ICC_PROFILE\u0000\u0001\u0001profile', 'latin1')),
    fixtures.frame(0xc0, 2048, 1536),
    fixtures.SCAN_AND_END,
  ]);
  assert.strictEqual(output.toString('hex'), expected.toString('hex'));
}
test('stripJpegMetadata keeps the orientation after the JFIF segment', keepsOrientationAfterJfif);

/**
 * Without JFIF, the orientation goes directly after the start marker,
 * also when a JFIF segment appears later in the file.
 *
 * @returns {void}
 */
function keepsOrientationWithoutJfif() {
  const exif = fixtures.exifSegment(fixtures.tiff(true, [{ tag: 0x0112, value: 8 }]), Buffer.from('GPS', 'latin1'));
  const quantization = segment(0xdb, hex('00 01'));
  const lateJfif = segment(0xe0, Buffer.from('JFIF\u0000', 'latin1'));
  const input = Buffer.concat([hex('ff d8'), exif, quantization, lateJfif, fixtures.frame(0xc0, 4, 3), fixtures.SCAN_AND_END]);
  const expected = Buffer.concat([
    hex('ff d8'),
    generator.exifOrientationSegment(8),
    quantization,
    lateJfif,
    fixtures.frame(0xc0, 4, 3),
    fixtures.SCAN_AND_END,
  ]);
  assert.strictEqual(generator.stripJpegMetadata(input).toString('hex'), expected.toString('hex'));
}
test('stripJpegMetadata puts the orientation after the start marker when JFIF is not first', keepsOrientationWithoutJfif);

/**
 * A photo whose only segments are metadata keeps just its orientation and image data.
 *
 * @returns {void}
 */
function onlyMetadataSegments() {
  const exif = fixtures.exifSegment(fixtures.tiff(false, [{ tag: 0x0112, value: 3 }]), Buffer.alloc(0));
  const input = Buffer.concat([hex('ff d8'), exif, fixtures.SCAN_AND_END]);
  const expected = Buffer.concat([hex('ff d8'), generator.exifOrientationSegment(3), fixtures.SCAN_AND_END]);
  assert.strictEqual(generator.stripJpegMetadata(input).toString('hex'), expected.toString('hex'));
}
test('stripJpegMetadata handles files that contain only metadata segments', onlyMetadataSegments);

/**
 * Data that cannot be parsed is returned as it is (the same Buffer).
 *
 * @returns {void}
 */
function unreadableJpegUnchanged() {
  const junk = hex('ff d8 00 01 02');
  assert.strictEqual(generator.stripJpegMetadata(junk), junk);
  const png = fixtures.metadataPng();
  assert.strictEqual(generator.stripJpegMetadata(png), png);
}
test('stripJpegMetadata returns unreadable data unchanged', unreadableJpegUnchanged);

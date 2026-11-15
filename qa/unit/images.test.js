'use strict';

/**
 * @file Tests for PNG handling, image sizes and copying directories.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const generator = require('../helpers/subject.js').generator;
const fixtures = require('../helpers/fixtures.js');

/**
 * Only data that starts with the full signature is a PNG.
 *
 * @returns {void}
 */
function recognisesPng() {
  assert.strictEqual(generator.isPng(fixtures.metadataPng()), true);
  assert.strictEqual(generator.isPng(fixtures.PNG_SIGNATURE), true);
  assert.strictEqual(generator.isPng(fixtures.PNG_SIGNATURE.subarray(0, 7)), false);
  assert.strictEqual(generator.isPng(fixtures.cameraJpeg(1)), false);
}
test('isPng checks the eight-byte signature', recognisesPng);

/**
 * All five metadata chunk types are removed, everything else is kept in order.
 *
 * @returns {void}
 */
function stripsPngChunks() {
  assert.strictEqual(generator.stripPngMetadata(fixtures.metadataPng()).toString('hex'), fixtures.cleanPng().toString('hex'));
}
test('stripPngMetadata removes tEXt, zTXt, iTXt, eXIf and tIME', stripsPngChunks);

/**
 * Chunks after IEND are dropped; a PNG without metadata comes out identical.
 *
 * @returns {void}
 */
function stopsAtImageEnd() {
  const withTrailer = Buffer.concat([fixtures.cleanPng(), fixtures.pngChunk('tEXt', Buffer.from('after', 'latin1'))]);
  assert.strictEqual(generator.stripPngMetadata(withTrailer).toString('hex'), fixtures.cleanPng().toString('hex'));
  assert.strictEqual(generator.stripPngMetadata(fixtures.cleanPng()).toString('hex'), fixtures.cleanPng().toString('hex'));
}
test('stripPngMetadata stops at IEND', stopsAtImageEnd);

/**
 * Unreadable data is returned as it is (the same Buffer).
 *
 * @returns {void}
 */
function unreadablePngUnchanged() {
  const notPng = fixtures.cameraJpeg(1);
  assert.strictEqual(generator.stripPngMetadata(notPng), notPng);
  const withoutEnd = Buffer.concat([fixtures.PNG_SIGNATURE, fixtures.pngHeader(1, 1)]);
  assert.strictEqual(generator.stripPngMetadata(withoutEnd), withoutEnd);
  const tooLong = Buffer.concat([fixtures.PNG_SIGNATURE, fixtures.hex('00 00 00 ff 49 48 44 52 00 00 00 00')]);
  assert.strictEqual(generator.stripPngMetadata(tooLong), tooLong);
  const cutChunk = Buffer.concat([fixtures.PNG_SIGNATURE, fixtures.hex('00 00 00 00 49 45 4e 44 00 00 00')]);
  assert.strictEqual(generator.stripPngMetadata(cutChunk), cutChunk);
  // The last chunk claims four data bytes that are missing.
  const overlongEnd = Buffer.concat([
    fixtures.PNG_SIGNATURE,
    fixtures.pngChunk('tEXt', Buffer.from('secret', 'latin1')),
    fixtures.hex('00 00 00 04 49 45 4e 44 00 00 00 00'),
  ]);
  assert.strictEqual(generator.stripPngMetadata(overlongEnd), overlongEnd);
  // Valid chunks behind a wrong signature are not touched.
  const wrongSignature = Buffer.concat([
    Buffer.from('NOT-PNG!', 'latin1'),
    fixtures.pngChunk('tEXt', Buffer.from('secret', 'latin1')),
    fixtures.pngChunk('IEND', Buffer.alloc(0)),
  ]);
  assert.strictEqual(generator.stripPngMetadata(wrongSignature), wrongSignature);
}
test('stripPngMetadata returns unreadable data unchanged', unreadablePngUnchanged);

/**
 * Sizes of JPEGs (with rotation) and PNGs.
 *
 * @returns {void}
 */
function imageSizes() {
  assert.deepStrictEqual(generator.getImageSize(fixtures.cameraJpeg(1)), { width: 2048, height: 1536 });
  assert.deepStrictEqual(generator.getImageSize(fixtures.cameraJpeg(4)), { width: 2048, height: 1536 });
  assert.deepStrictEqual(generator.getImageSize(fixtures.cameraJpeg(5)), { width: 1536, height: 2048 });
  assert.deepStrictEqual(generator.getImageSize(fixtures.cameraJpeg(6)), { width: 1536, height: 2048 });
  assert.deepStrictEqual(generator.getImageSize(fixtures.metadataPng()), { width: 300, height: 200 });
  const headerOnly = Buffer.concat([fixtures.PNG_SIGNATURE, fixtures.pngHeader(7, 9)]).subarray(0, 24);
  assert.deepStrictEqual(generator.getImageSize(headerOnly), { width: 7, height: 9 });
  assert.strictEqual(generator.getImageSize(headerOnly.subarray(0, 23)), null);
  assert.strictEqual(generator.getImageSize(Buffer.from('GIF89a', 'latin1')), null);
}
test('getImageSize reads JPEG and PNG sizes as displayed', imageSizes);

/**
 * Sizes are read from files; missing files give null.
 *
 * @returns {void}
 */
function imageDimensionsFromFiles() {
  const root = fixtures.tempDir();
  fs.writeFileSync(path.join(root, 'a.jpg'), fixtures.cameraJpeg(6));
  assert.deepStrictEqual(generator.getImageDimensions(path.join(root, 'a.jpg')), { width: 1536, height: 2048 });
  assert.strictEqual(generator.getImageDimensions(path.join(root, 'missing.jpg')), null);
}
test('getImageDimensions reads files and returns null for missing ones', imageDimensionsFromFiles);

/**
 * The stripper is chosen by file extension, in any letter case.
 *
 * @returns {void}
 */
function choosesStripper() {
  assert.strictEqual(generator.findMetadataStripper('a.jpg'), generator.stripJpegMetadata);
  assert.strictEqual(generator.findMetadataStripper('a.JPEG'), generator.stripJpegMetadata);
  assert.strictEqual(generator.findMetadataStripper('a.Png'), generator.stripPngMetadata);
  assert.strictEqual(generator.findMetadataStripper('a.gif'), null);
  assert.strictEqual(generator.findMetadataStripper('jpg'), null);
}
test('findMetadataStripper picks the stripper by extension', choosesStripper);

/**
 * Copying with stripping: images are cleaned and counted, other files and
 * sub-directories are copied, and the target may be several levels deep.
 *
 * @returns {void}
 */
function copiesAndStrips() {
  const root = fixtures.tempDir();
  fixtures.writeFiles(root, {
    'source/photo.jpg': fixtures.cameraJpeg(1),
    'source/sub/icon.png': fixtures.metadataPng(),
    'source/sub/clean.png': fixtures.cleanPng(),
    'source/notes.txt': 'GPS 49.87N',
  });
  const stats = { imagesStripped: 0 };
  generator.copyDirectory(path.join(root, 'source'), path.join(root, 'deep', 'target'), true, stats);
  assert.strictEqual(stats.imagesStripped, 2);
  assert.strictEqual(
    fs.readFileSync(path.join(root, 'deep/target/photo.jpg')).toString('hex'),
    generator.stripJpegMetadata(fixtures.cameraJpeg(1)).toString('hex')
  );
  assert.strictEqual(fs.readFileSync(path.join(root, 'deep/target/sub/icon.png')).toString('hex'), fixtures.cleanPng().toString('hex'));
  assert.strictEqual(fs.readFileSync(path.join(root, 'deep/target/sub/clean.png')).toString('hex'), fixtures.cleanPng().toString('hex'));
  assert.strictEqual(fs.readFileSync(path.join(root, 'deep/target/notes.txt'), 'utf8'), 'GPS 49.87N');
}
test('copyDirectory strips images, copies the rest and counts stripped images', copiesAndStrips);

/**
 * Copying without stripping leaves images byte for byte unchanged.
 *
 * @returns {void}
 */
function copiesWithoutStripping() {
  const root = fixtures.tempDir();
  fixtures.writeFiles(root, { 'source/photo.jpg': fixtures.cameraJpeg(1) });
  const stats = { imagesStripped: 0 };
  generator.copyDirectory(path.join(root, 'source'), path.join(root, 'target'), false, stats);
  assert.strictEqual(stats.imagesStripped, 0);
  assert.strictEqual(fs.readFileSync(path.join(root, 'target/photo.jpg')).toString('hex'), fixtures.cameraJpeg(1).toString('hex'));
}
test('copyDirectory keeps images unchanged when stripping is off', copiesWithoutStripping);

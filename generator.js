'use strict';

/**
 * @file A dependency-free static site generator.
 *
 * Reads Markdown articles with a small frontmatter block from a content
 * directory, renders them into HTML templates and writes a static site into a
 * build directory. Published images are copied without privacy-relevant
 * metadata (EXIF including GPS, XMP, IPTC, comments).
 *
 * Code style, enforced by qa/style.test.js:
 * - no conditional (`a ? b : c`), optional chaining (`?.`) or nullish (`??`) operators,
 * - no arrow functions, no `++` / `--`, no spread, destructuring or default parameters,
 * - strict equality only, braces on every block, `||` / `&&` only inside conditions,
 * - a complete JSDoc comment on every function.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Minimum width in pixels recommended for social media preview images.
 * @type {number}
 */
const MIN_IMAGE_WIDTH = 1200;

/**
 * Minimum height in pixels recommended for social media preview images.
 * @type {number}
 */
const MIN_IMAGE_HEIGHT = 627;

/**
 * Template sub-directories that are copied into the build directory as they are
 * (images are stripped of metadata on the way).
 * @type {Array<string>}
 */
const TEMPLATE_ASSET_DIRECTORIES = ['images', 'icons', 'fonts'];

/**
 * Article sub-directories that are published next to the article page.
 * @type {Array<string>}
 */
const ARTICLE_ASSET_DIRECTORIES = ['images', 'pdfs'];

/**
 * Templates that must exist in the templates directory.
 * @type {Array<string>}
 */
const REQUIRED_TEMPLATES = ['index.html', 'article.html', 'style.css'];

/**
 * The eight bytes every PNG file starts with.
 * @type {Buffer}
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG chunk types that carry metadata and are removed from published images.
 * @type {Set<string>}
 */
const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

/**
 * Inline Markdown spans that must not be touched by emphasis processing, in one
 * left-to-right pattern: `code`, [text](url) links, raw HTML tags and bare URLs.
 * @type {RegExp}
 */
const INLINE_TOKENS =
  /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|<\/?[a-zA-Z][^>]*>|(?<![\w/"'=])(https?:\/\/[^\s<>"()]*[^\s<>"().,;:!?'])/g;

/**
 * @typedef {Object} Logger
 * @property {function(string): void} log - Informational messages.
 * @property {function(string): void} warn - Warnings; the build continues.
 * @property {function(string): void} error - Errors reported by the command line interface.
 */

/**
 * @typedef {Object} SiteOptions
 * @property {string} [rootDir] - Project directory. Default: the current working directory.
 * @property {string} [contentDir] - Markdown articles. Default: `<rootDir>/content`.
 * @property {string} [templatesDir] - Templates. Default: `<rootDir>/templates`.
 * @property {string} [buildDir] - Output; deleted and rebuilt on every run. Default: `<rootDir>/public`.
 * @property {string} [siteUrl] - Base URL such as `https://example.com`, used for absolute `og:` URLs.
 * @property {boolean} [stripImageMetadata] - Remove metadata from published images. Default: true.
 * @property {string} [defaultLang] - Value of `{{lang}}` for articles without `lang:`. Default: `en`.
 * @property {Logger} [logger] - Where messages go. Default: `console`.
 * @property {string} [homeDir] - The user's home directory, which is never used as build directory. Default: `os.homedir()`.
 * @property {Array<Language>} [languages] - Two or more languages switch on the multilingual layout (see README).
 */

/**
 * @typedef {Object} Settings
 * @property {string} rootDir - Project directory.
 * @property {string} contentDir - Markdown articles.
 * @property {string} templatesDir - Templates.
 * @property {string} buildDir - Output directory.
 * @property {string} siteUrl - Base URL without trailing slash, or an empty string.
 * @property {boolean} stripImageMetadata - Whether published images are stripped of metadata.
 * @property {string} defaultLang - Fallback language.
 * @property {Logger} logger - Where messages go.
 * @property {string} homeDir - The user's home directory.
 * @property {(Array<Language>|null)} languages - Languages of a multilingual site, or null.
 */

/**
 * @typedef {Object} Article
 * @property {string} category - Table of contents section (required frontmatter field).
 * @property {string} title - Article title (required frontmatter field).
 * @property {string} authors - Author line, or an empty string.
 * @property {string} image - Hero image path relative to the article folder, or an empty string.
 * @property {string} explanation - Caption and description, or an empty string.
 * @property {string} lang - Language code, or an empty string for the default.
 * @property {(number|null)} order - Position in the table of contents, or null.
 * @property {boolean} toc - Whether the article is listed in the table of contents.
 * @property {string} body - Markdown body.
 * @property {string} filePath - Path of the Markdown file.
 */

/**
 * @typedef {Object} ParseResult
 * @property {(Article|null)} article - The article, or null when the file is not published.
 * @property {boolean} draft - True when the file is marked `draft: true`.
 * @property {string} skipReason - Why the file is not published, or an empty string.
 */

/**
 * @typedef {Object} ArticleCollection
 * @property {Array<Article>} articles - Publishable articles, sorted.
 * @property {Array<string>} drafts - Files marked as drafts.
 * @property {Array<{file: string, reason: string}>} skipped - Files that cannot be published.
 */

/**
 * @typedef {Object} ArticleLocation
 * @property {string} articleDir - Folder of the Markdown file.
 * @property {string} relativeDir - Folder of the output page, relative to the content directory.
 * @property {string} articleRelativePath - Article folder relative to the content directory.
 * @property {string} folderName - Name of the article folder; the page is `<folderName>.html`.
 */

/**
 * @typedef {Object} ImageSize
 * @property {number} width - Width in pixels as displayed.
 * @property {number} height - Height in pixels as displayed.
 */

/**
 * @typedef {Object} JpegSegment
 * @property {number} marker - Marker byte (the byte after 0xFF).
 * @property {number} start - Offset of the 0xFF marker prefix.
 * @property {number} end - Offset just after the segment.
 */

/**
 * @typedef {Object} JpegLayout
 * @property {Array<JpegSegment>} segments - Segments before the image data, in file order.
 * @property {number} scanStart - Offset of the Start Of Scan marker, or -1 if it was not reached.
 */

/**
 * @typedef {Object} JpegInfo
 * @property {number} width - Stored width in pixels.
 * @property {number} height - Stored height in pixels.
 * @property {number} orientation - EXIF orientation 1-8 (1 = upright).
 */

/**
 * @typedef {Object} CopyStats
 * @property {number} imagesStripped - Number of images whose metadata was removed.
 */

/**
 * @typedef {Object} Templates
 * @property {string} index - Contents of index.html.
 * @property {string} article - Contents of article.html.
 * @property {string} footer - Contents of footer.html, or an empty string.
 */

/**
 * @typedef {Object} Language
 * @property {string} code - Language code such as `de`; also the prefix of content file names (`de-das-netz.md`).
 * @property {string} path - Folder of the language in the build directory; empty for the first language, which is published at the top level.
 */

/**
 * @typedef {Object} PageTarget
 * @property {string} file - Where the page is written.
 * @property {string} articleDir - Where the article's `images/` and `pdfs/` are published.
 * @property {string} sourceDir - The article's folder in the content directory.
 * @property {string} lang - Language of the page.
 * @property {string} indexFile - The home page the logo links to.
 */

/**
 * @typedef {Object} BuildResult
 * @property {Array<Article>} articles - Published articles.
 * @property {string} outputDir - The build directory.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Convert a file system path into a URL path with forward slashes.
 *
 * @param {string} filePath - Path as produced by the `path` module.
 * @param {string} separator - The separator used in `filePath`, normally `path.sep`.
 * @returns {string} The path with every separator replaced by `/`.
 */
function toPosix(filePath, separator) {
  return filePath.split(separator).join('/');
}

/**
 * Relative URL from a directory to a file, with forward slashes.
 *
 * @param {string} fromDirectory - Directory of the page that contains the link.
 * @param {string} target - File the link points to.
 * @returns {string} The relative URL.
 */
function relativeUrl(fromDirectory, target) {
  return toPosix(path.relative(fromDirectory, target), path.sep);
}

/**
 * Replace every `{{key}}` placeholder in a template. split/join is used instead
 * of String#replace so that `$&`, `$'` and `$$` in the value are inserted literally.
 *
 * @param {string} template - Text containing placeholders.
 * @param {string} key - Placeholder name without braces.
 * @param {(string|number)} value - Replacement.
 * @returns {string} The template with all occurrences replaced.
 */
function fill(template, key, value) {
  return template.split('{{' + key + '}}').join(String(value));
}

/**
 * Escape double quotes so a value can be used inside an HTML attribute.
 * Entities such as `&laquo;` are intentionally left alone.
 *
 * @param {string} text - Plain text or HTML.
 * @returns {string} The text with `"` replaced by `&quot;`.
 */
function escapeQuotes(text) {
  return text.replace(/"/g, '&quot;');
}

/**
 * Escape `&`, `<` and `>` so text is shown literally in HTML.
 *
 * @param {string} text - Plain text.
 * @returns {string} HTML-safe text.
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Whether a link target is absolute (has a scheme, starts with `//`, `/` or `#`).
 *
 * @param {string} url - Link target from Markdown.
 * @returns {boolean} True for absolute targets that must not be rewritten.
 */
function isExternalUrl(url) {
  return /^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(url);
}

/**
 * Convert Windows and old Mac line endings to `\n`.
 *
 * @param {string} text - Any text.
 * @returns {string} The text with `\n` line endings only.
 */
function normalizeNewlines(text) {
  return text.replace(/\r\n|\r/g, '\n');
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/**
 * Whether a JPEG marker stands alone, without a length field (TEM and RST0-RST7).
 *
 * @param {number} marker - Marker byte.
 * @returns {boolean} True for markers without a payload.
 */
function isStandaloneJpegMarker(marker) {
  if (marker === 0x01) {
    return true;
  }
  if (marker >= 0xd0 && marker <= 0xd7) {
    return true;
  }
  return false;
}

/**
 * Whether a JPEG marker is a Start Of Frame marker, which holds the image size.
 * 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC) share the range but are not frames.
 *
 * @param {number} marker - Marker byte.
 * @returns {boolean} True for SOF0-SOF15 except DHT, JPG and DAC.
 */
function isStartOfFrameMarker(marker) {
  if (marker < 0xc0 || marker > 0xcf) {
    return false;
  }
  if (marker === 0xc4 || marker === 0xc8 || marker === 0xcc) {
    return false;
  }
  return true;
}

/**
 * Read the segment structure of a JPEG up to the compressed image data.
 * Reading stops early (with `scanStart` -1) when the data is not a well-formed JPEG.
 *
 * @param {Buffer} buffer - File contents.
 * @returns {JpegLayout} The segments found and where the image data starts.
 */
function readJpegLayout(buffer) {
  const layout = { segments: [], scanStart: -1 };
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return layout;
  }
  let offset = 2;
  while (buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      // Fill byte: markers may be preceded by any number of 0xFF bytes.
      offset += 1;
      continue;
    }
    if (isStandaloneJpegMarker(marker)) {
      layout.segments.push({ marker: marker, start: offset, end: offset + 2 });
      offset += 2;
      continue;
    }
    if (marker === 0xda) {
      layout.scanStart = offset;
      return layout;
    }
    if (marker === 0xd9) {
      return layout;
    }
    if (offset + 4 > buffer.length) {
      return layout;
    }
    const end = offset + 2 + buffer.readUInt16BE(offset + 2);
    if (end > buffer.length) {
      return layout;
    }
    layout.segments.push({ marker: marker, start: offset, end: end });
    offset = end;
  }
  return layout;
}

/**
 * Read an unsigned 16-bit integer in the given byte order.
 *
 * @param {Buffer} buffer - Data.
 * @param {number} offset - Position of the integer.
 * @param {boolean} littleEndian - True for Intel (II) byte order, false for Motorola (MM).
 * @returns {number} The integer.
 */
function readUInt16(buffer, offset, littleEndian) {
  if (littleEndian) {
    return buffer.readUInt16LE(offset);
  }
  return buffer.readUInt16BE(offset);
}

/**
 * Read an unsigned 32-bit integer in the given byte order.
 *
 * @param {Buffer} buffer - Data.
 * @param {number} offset - Position of the integer.
 * @param {boolean} littleEndian - True for Intel (II) byte order, false for Motorola (MM).
 * @returns {number} The integer.
 */
function readUInt32(buffer, offset, littleEndian) {
  if (littleEndian) {
    return buffer.readUInt32LE(offset);
  }
  return buffer.readUInt32BE(offset);
}

/**
 * Read the EXIF orientation from an APP1 segment.
 *
 * @param {Buffer} segment - The complete segment, starting with 0xFF 0xE1.
 * @returns {number} Orientation 1-8, or 1 when the segment has no valid orientation.
 */
function readExifOrientation(segment) {
  if (segment.toString('latin1', 4, 10) !== 'Exif\u0000\u0000') {
    return 1;
  }
  const tiffStart = 10;
  const littleEndian = segment.toString('latin1', tiffStart, tiffStart + 2) === 'II';
  try {
    const directoryStart = tiffStart + readUInt32(segment, tiffStart + 4, littleEndian);
    const entryCount = readUInt16(segment, directoryStart, littleEndian);
    for (let index = 0; index < entryCount; index += 1) {
      const entryStart = directoryStart + 2 + index * 12;
      if (readUInt16(segment, entryStart, littleEndian) === 0x0112) {
        const value = readUInt16(segment, entryStart + 8, littleEndian);
        if (value === 0 || value > 8) {
          return 1;
        }
        return value;
      }
    }
  } catch (error) {
    // A truncated EXIF block cannot carry a usable orientation; fall through.
  }
  return 1;
}

/**
 * Build a minimal APP1/EXIF segment that contains nothing but the orientation,
 * so that rotated photos still display upright after their metadata is removed.
 *
 * @param {number} orientation - EXIF orientation 2-8.
 * @returns {Buffer} A 36-byte JPEG segment.
 */
function exifOrientationSegment(orientation) {
  const segment = Buffer.alloc(36);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(34, 2); // segment length, excluding the marker
  segment.write('Exif\u0000\u0000', 4);
  segment.write('MM', 10); // big-endian TIFF header
  segment.writeUInt16BE(42, 12);
  segment.writeUInt32BE(8, 14); // offset of the first directory
  segment.writeUInt16BE(1, 18); // one entry
  segment.writeUInt16BE(0x0112, 20); // tag: Orientation
  segment.writeUInt16BE(3, 22); // type: SHORT
  segment.writeUInt32BE(1, 24); // count
  segment.writeUInt16BE(orientation, 28);
  segment.writeUInt32BE(0, 32); // no further directory
  return segment;
}

/**
 * The orientation stored in a JPEG's EXIF segments. A later segment without an
 * orientation (for example XMP, which is also APP1) does not reset an earlier one.
 *
 * @param {Buffer} buffer - File contents.
 * @param {Array<JpegSegment>} segments - Segments of the file.
 * @returns {number} Orientation 1-8.
 */
function findJpegOrientation(buffer, segments) {
  let orientation = 1;
  for (const segment of segments) {
    if (segment.marker === 0xe1) {
      const segmentOrientation = readExifOrientation(buffer.subarray(segment.start, segment.end));
      if (segmentOrientation !== 1) {
        orientation = segmentOrientation;
      }
    }
  }
  return orientation;
}

/**
 * Stored size and orientation of a JPEG.
 *
 * @param {Buffer} buffer - File contents.
 * @returns {(JpegInfo|null)} Size and orientation, or null if no frame header was found.
 */
function getJpegInfo(buffer) {
  const layout = readJpegLayout(buffer);
  for (const segment of layout.segments) {
    if (isStartOfFrameMarker(segment.marker) && segment.end - segment.start >= 9) {
      return {
        width: buffer.readUInt16BE(segment.start + 7),
        height: buffer.readUInt16BE(segment.start + 5),
        orientation: findJpegOrientation(buffer, layout.segments),
      };
    }
  }
  return null;
}

/**
 * Whether a JPEG segment only carries metadata and is removed from published images.
 * Removed: EXIF/XMP (APP1), APP2 other than ICC profiles, APP3-APP13 (including
 * Photoshop/IPTC), APP15 and comments. Kept: everything needed to show the
 * image correctly, including JFIF (APP0), ICC profiles and Adobe (APP14).
 *
 * @param {number} marker - Marker byte.
 * @param {Buffer} segment - The complete segment.
 * @returns {boolean} True when the segment should be removed.
 */
function isJpegMetadataSegment(marker, segment) {
  if (marker === 0xe1) {
    return true;
  }
  if (marker === 0xe2) {
    return segment.toString('latin1', 4, 16) !== 'ICC_PROFILE\u0000';
  }
  if (marker >= 0xe3 && marker <= 0xed) {
    return true;
  }
  if (marker === 0xef || marker === 0xfe) {
    return true;
  }
  return false;
}

/**
 * Remove metadata from a JPEG. The image data is copied unchanged; if the photo
 * needs rotating, a minimal EXIF segment with only the orientation is added.
 *
 * @param {Buffer} buffer - File contents.
 * @returns {Buffer} The cleaned file, or the input itself if it is not a readable JPEG.
 */
function stripJpegMetadata(buffer) {
  const layout = readJpegLayout(buffer);
  if (layout.scanStart === -1) {
    return buffer;
  }
  const parts = [buffer.subarray(0, 2)];
  let jfifFirst = false;
  for (const segment of layout.segments) {
    const bytes = buffer.subarray(segment.start, segment.end);
    if (!isJpegMetadataSegment(segment.marker, bytes)) {
      if (parts.length === 1 && segment.marker === 0xe0) {
        jfifFirst = true;
      }
      parts.push(bytes);
    }
  }
  const orientation = findJpegOrientation(buffer, layout.segments);
  if (orientation !== 1) {
    // EXIF conventionally follows the start marker, or the JFIF segment if there is one.
    let position = 1;
    if (jfifFirst) {
      position = 2;
    }
    parts.splice(position, 0, exifOrientationSegment(orientation));
  }
  parts.push(buffer.subarray(layout.scanStart));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/**
 * Whether data starts with the PNG signature.
 *
 * @param {Buffer} buffer - File contents.
 * @returns {boolean} True for PNG files.
 */
function isPng(buffer) {
  return buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * Remove text, EXIF and timestamp chunks from a PNG.
 *
 * @param {Buffer} buffer - File contents.
 * @returns {Buffer} The cleaned file, or the input itself if it is not a readable PNG.
 */
function stripPngMetadata(buffer) {
  if (!isPng(buffer)) {
    return buffer;
  }
  const parts = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + buffer.readUInt32BE(offset);
    if (end > buffer.length) {
      return buffer;
    }
    if (!PNG_METADATA_CHUNKS.has(type)) {
      parts.push(buffer.subarray(offset, end));
    }
    if (type === 'IEND') {
      return Buffer.concat(parts);
    }
    offset = end;
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Displayed size of a JPEG or PNG image held in memory.
 *
 * @param {Buffer} buffer - File contents.
 * @returns {(ImageSize|null)} Width and height as displayed (EXIF rotation applied), or null.
 */
function getImageSize(buffer) {
  const jpeg = getJpegInfo(buffer);
  if (jpeg !== null) {
    if (jpeg.orientation >= 5) {
      // Orientations 5-8 rotate by 90 degrees, which swaps width and height on screen.
      return { width: jpeg.height, height: jpeg.width };
    }
    return { width: jpeg.width, height: jpeg.height };
  }
  if (isPng(buffer) && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return null;
}

/**
 * Displayed size of a JPEG or PNG file.
 *
 * @param {string} filePath - Image file.
 * @returns {(ImageSize|null)} Width and height, or null if the file cannot be read or is no JPEG/PNG.
 */
function getImageDimensions(filePath) {
  let buffer = null;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    return null;
  }
  return getImageSize(buffer);
}

/**
 * The metadata stripper for a file, chosen by its extension.
 *
 * @param {string} fileName - File name.
 * @returns {(function(Buffer): Buffer|null)} The stripper, or null for files that are copied unchanged.
 */
function findMetadataStripper(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') {
    return stripJpegMetadata;
  }
  if (extension === '.png') {
    return stripPngMetadata;
  }
  return null;
}

/**
 * Copy a directory recursively. With `stripMetadata`, JPEG and PNG files are
 * written without metadata; all other files are copied byte for byte.
 *
 * @param {string} source - Directory to copy.
 * @param {string} destination - Target directory; created if needed.
 * @param {boolean} stripMetadata - Whether to remove image metadata.
 * @param {CopyStats} stats - Counter, updated for every image that got smaller.
 * @returns {void}
 */
function copyDirectory(source, destination, stripMetadata, stats) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to, stripMetadata, stats);
      continue;
    }
    let stripper = null;
    if (stripMetadata) {
      stripper = findMetadataStripper(entry.name);
    }
    if (stripper === null) {
      fs.copyFileSync(from, to);
      continue;
    }
    const input = fs.readFileSync(from);
    const output = stripper(input);
    fs.writeFileSync(to, output);
    if (output.length !== input.length) {
      stats.imagesStripped += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * Apply emphasis: `__strong__`, `**strong**`, `_em_` and `*em*`. Underscores
 * only count at word boundaries, so snake_case words are left alone.
 *
 * @param {string} text - Text without code spans, links or URLs.
 * @returns {string} HTML.
 */
function emphasis(text) {
  return text
    .replace(/(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, '<strong>$1</strong>')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, '<em>$1</em>')
    .replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, '<em>$1</em>');
}

/**
 * Convert inline Markdown to HTML: code spans, links, bare URLs and emphasis.
 * Raw HTML tags are passed through untouched.
 *
 * @param {string} text - One line or paragraph of Markdown.
 * @param {function(string): string} linkHref - Resolves the target of a `[text](target)` link.
 * @returns {string} HTML.
 */
function inline(text, linkHref) {
  const stash = new Map();

  /**
   * Replace one protected span by a placeholder and remember its HTML.
   *
   * @param {string} match - The whole match.
   * @param {(string|undefined)} code - Contents of a code span.
   * @param {(string|undefined)} linkText - Text of a Markdown link.
   * @param {(string|undefined)} href - Target of a Markdown link.
   * @param {(string|undefined)} url - A bare URL.
   * @returns {string} Placeholder `\u0000<index>\u0000`.
   */
  function protect(match, code, linkText, href, url) {
    let html = match;
    if (code !== undefined) {
      html = '<code>' + escapeHtml(code) + '</code>';
    } else if (linkText !== undefined) {
      html = '<a href="' + linkHref(href.trim()) + '">' + emphasis(linkText) + '</a>';
    } else if (url !== undefined) {
      html = '<a href="' + url + '">' + url + '</a>';
    }
    const index = stash.size;
    stash.set(index, html);
    return '\u0000' + String(index) + '\u0000';
  }

  /**
   * Put the HTML of a protected span back in place of its placeholder.
   *
   * @param {string} match - The placeholder.
   * @param {string} index - Position in the stash, as digits.
   * @returns {string} The stored HTML.
   */
  function restore(match, index) {
    return stash.get(Number(index));
  }

  return emphasis(text.replace(INLINE_TOKENS, protect)).replace(/\u0000(\d+)\u0000/g, restore);
}

/**
 * Close the open list, if any.
 *
 * @param {{html: Array<string>, openList: string}} state - Rendering state; `openList` is `ul`, `ol` or empty.
 * @returns {void}
 */
function closeList(state) {
  if (state.openList !== '') {
    state.html.push('</' + state.openList + '>');
    state.openList = '';
  }
}

/**
 * Render a Markdown image line. Local paths are resolved to the article's
 * `images` folder; a non-empty alt text is also shown as a caption.
 *
 * @param {string} alt - Alt text.
 * @param {string} source - Image path or URL.
 * @param {string} outputDir - Directory of the page.
 * @param {string} articleImagesDir - The article's `images` folder in the build directory.
 * @param {function(string): string} linkHref - Link resolver for the caption.
 * @returns {string} HTML.
 */
function renderImage(alt, source, outputDir, articleImagesDir, linkHref) {
  let src = source;
  if (!isExternalUrl(source)) {
    let fileName = source;
    if (fileName.startsWith('images/')) {
      fileName = fileName.substring(7);
    }
    src = relativeUrl(outputDir, path.join(articleImagesDir, fileName));
  }
  let html = '<p><img src="' + src + '" alt="' + escapeQuotes(alt) + '" class="article-inline-image"></p>';
  if (alt !== '') {
    html += '\n<p class="article-explanation">' + inline(alt, linkHref) + '</p>';
  }
  return html;
}

/**
 * Convert an article body from Markdown to HTML (single-language layout).
 *
 * @param {string} markdown - Article body.
 * @param {string} outputDir - Directory of the page in the build directory.
 * @param {string} articleRelativePath - Article folder relative to the content directory.
 * @returns {string} HTML.
 */
function markdownToHtml(markdown, outputDir, articleRelativePath) {
  return renderMarkdown(markdown, outputDir, path.join(path.dirname(outputDir), articleRelativePath));
}

/**
 * Convert an article body from Markdown to HTML. Every non-empty line is a
 * block: a heading, a list item, an image or a paragraph.
 *
 * @param {string} markdown - Article body.
 * @param {string} outputDir - Directory of the page in the build directory.
 * @param {string} articleDir - Where the article's `images/` and `pdfs/` are published.
 * @returns {string} HTML.
 */
function renderMarkdown(markdown, outputDir, articleDir) {

  /**
   * Resolve `pdfs/...` link targets to the article's PDF folder.
   *
   * @param {string} href - Link target from Markdown.
   * @returns {string} The target to use in HTML.
   */
  function linkHref(href) {
    if (href.startsWith('pdfs/')) {
      return relativeUrl(outputDir, path.join(articleDir, 'pdfs', href.substring(5)));
    }
    return href;
  }

  const state = { html: [], openList: '' };
  for (const line of normalizeNewlines(markdown).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      closeList(state);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (heading !== null) {
      closeList(state);
      const level = String(heading[1].length);
      state.html.push('<h' + level + '>' + inline(heading[2], linkHref) + '</h' + level + '>');
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (bullet !== null || numbered !== null) {
      let listType = 'ol';
      let item = numbered;
      if (bullet !== null) {
        listType = 'ul';
        item = bullet;
      }
      if (state.openList !== listType) {
        closeList(state);
        state.html.push('<' + listType + '>');
        state.openList = listType;
      }
      state.html.push('<li>' + inline(item[1], linkHref) + '</li>');
      continue;
    }

    closeList(state);

    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image !== null) {
      state.html.push(renderImage(image[1], image[2].trim(), outputDir, path.join(articleDir, 'images'), linkHref));
      continue;
    }

    state.html.push('<p>' + inline(trimmed, linkHref) + '</p>');
  }
  closeList(state);
  return state.html.join('\n');
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * Parse `key: value` lines of a frontmatter block.
 *
 * @param {string} block - Lines between the `---` markers.
 * @returns {Object<string, string>} Field values, trimmed.
 */
function parseFrontmatter(block) {
  const fields = Object.create(null);
  for (const line of block.split('\n')) {
    const match = line.match(/^(\w+):\s*(.*)/);
    if (match !== null) {
      fields[match[1]] = match[2].trim();
    }
  }
  return fields;
}

/**
 * Value of a frontmatter field.
 *
 * @param {Object<string, string>} fields - Parsed frontmatter.
 * @param {string} name - Field name.
 * @returns {string} The value, or an empty string if the field is absent.
 */
function fieldOrEmpty(fields, name) {
  if (name in fields) {
    return fields[name];
  }
  return '';
}

/**
 * Parse the `order:` field.
 *
 * @param {string} text - Field value.
 * @returns {(number|null)} The number, or null when the field is empty or not a finite number.
 */
function parseOrder(text) {
  if (text === '') {
    return null;
  }
  const value = Number(text);
  if (Number.isFinite(value)) {
    return value;
  }
  return null;
}

/**
 * Turn the source of a Markdown file into an article.
 *
 * @param {string} source - File contents.
 * @param {string} filePath - Path of the file (stored in the article).
 * @returns {ParseResult} The article, or why it is not published.
 */
function parseArticleSource(source, filePath) {
  const text = normalizeNewlines(source.replace(/^﻿/, ''));
  const match = text.match(/^---\n(.*?)\n---(?:\n(.*))?$/s);
  if (match === null) {
    return { article: null, draft: false, skipReason: 'no frontmatter (--- block at the top of the file)' };
  }

  const fields = parseFrontmatter(match[1]);
  if (fieldOrEmpty(fields, 'draft') === 'true') {
    return { article: null, draft: true, skipReason: 'draft' };
  }

  const missing = [];
  for (const required of ['category', 'title']) {
    if (fieldOrEmpty(fields, required) === '') {
      missing.push(required);
    }
  }
  if (missing.length > 0) {
    return { article: null, draft: false, skipReason: 'missing ' + missing.join(' and ') + ' in frontmatter' };
  }

  let body = '';
  if (match[2] !== undefined) {
    body = match[2].trim();
  }

  return {
    article: {
      category: fields.category,
      title: fields.title,
      authors: fieldOrEmpty(fields, 'authors'),
      image: fieldOrEmpty(fields, 'image'),
      explanation: fieldOrEmpty(fields, 'explanation'),
      lang: fieldOrEmpty(fields, 'lang'),
      order: parseOrder(fieldOrEmpty(fields, 'order')),
      toc: fieldOrEmpty(fields, 'toc') !== 'false',
      body: body,
      filePath: filePath,
    },
    draft: false,
    skipReason: '',
  };
}

/**
 * Read and parse a Markdown file.
 *
 * @param {string} filePath - Markdown file.
 * @returns {ParseResult} The article, or why it is not published.
 */
function readArticle(filePath) {
  return parseArticleSource(fs.readFileSync(filePath, 'utf8'), filePath);
}

/**
 * Read and parse a Markdown file (kept for compatibility with version 1.0).
 *
 * @param {string} filePath - Markdown file.
 * @returns {(Article|null)} The article, or null when the file is not published.
 */
function parseMarkdown(filePath) {
  return readArticle(filePath).article;
}

/**
 * Where an article is published: `content/<dir>/<slug>/<file>.md` becomes
 * `<build>/<dir>/<slug>.html`.
 *
 * @param {Article} article - The article.
 * @param {string} contentDir - Content directory.
 * @returns {ArticleLocation} Paths derived from the article's location.
 */
function articleOutput(article, contentDir) {
  const articleDir = path.dirname(article.filePath);
  return {
    articleDir: articleDir,
    relativeDir: path.relative(contentDir, path.dirname(articleDir)),
    articleRelativePath: path.relative(contentDir, articleDir),
    folderName: path.basename(articleDir),
  };
}

/**
 * Sort key for the `order:` field; articles without it come last.
 *
 * @param {Article} article - The article.
 * @returns {number} The order, or Infinity.
 */
function orderValue(article) {
  if (article.order === null) {
    return Infinity;
  }
  return article.order;
}

/**
 * Sort comparator: by `order:` first, then by file path.
 *
 * @param {Article} first - One article.
 * @param {Article} second - Another article.
 * @returns {number} Negative, zero or positive, as Array#sort expects.
 */
function compareArticles(first, second) {
  const firstOrder = orderValue(first);
  const secondOrder = orderValue(second);
  if (firstOrder !== secondOrder) {
    return firstOrder - secondOrder;
  }
  if (first.filePath < second.filePath) {
    return -1;
  }
  if (first.filePath > second.filePath) {
    return 1;
  }
  return 0;
}

/**
 * Find all Markdown files below a directory, in a stable order, and parse them.
 *
 * @param {string} contentDir - Content directory.
 * @returns {ArticleCollection} Publishable articles (sorted), drafts and skipped files.
 */
function collectArticles(contentDir) {
  const collection = { articles: [], drafts: [], skipped: [] };

  /**
   * Visit one directory.
   *
   * @param {string} directory - Directory to read.
   * @returns {void}
   */
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const filePath = path.join(directory, name);
      if (fs.statSync(filePath).isDirectory()) {
        visit(filePath);
      } else if (name.endsWith('.md')) {
        const result = readArticle(filePath);
        if (result.article !== null) {
          collection.articles.push(result.article);
        } else if (result.draft) {
          collection.drafts.push(filePath);
        } else {
          collection.skipped.push({ file: filePath, reason: result.skipReason });
        }
      }
    }
  }

  visit(contentDir);
  collection.articles.sort(compareArticles);
  return collection;
}

/**
 * HTML for the table of contents: one section per category, in the order of
 * the (sorted) articles. Articles with `toc: false` are left out.
 *
 * @param {Array<Article>} articles - Sorted articles.
 * @param {string} contentDir - Content directory.
 * @returns {string} HTML.
 */
function generateCategoriesHtml(articles, contentDir) {
  const byCategory = new Map();
  for (const article of articles) {
    if (article.toc) {
      if (!byCategory.has(article.category)) {
        byCategory.set(article.category, []);
      }
      byCategory.get(article.category).push(article);
    }
  }

  let html = '';
  for (const entry of byCategory) {
    html += '<section>\n<h2>' + entry[0] + '</h2>\n';
    for (const article of entry[1]) {
      const location = articleOutput(article, contentDir);
      const href = toPosix(path.join(location.relativeDir, location.folderName + '.html'), path.sep);
      html += '<p><a href="' + href + '">' + article.title + '</a></p>\n';
    }
    html += '</section>\n';
  }
  return html;
}

// ---------------------------------------------------------------------------
// Safety and checks
// ---------------------------------------------------------------------------

/**
 * Refuse build directories that would take sources (or worse) with them when
 * they are deleted before the build.
 *
 * @param {string} buildDir - Proposed build directory.
 * @param {Array<string>} protectedDirs - Directories that must survive.
 * @param {string} homeDir - The user's home directory.
 * @returns {void}
 * @throws {Error} When the build directory is the file system root, the home
 *   directory, or one of (or a parent of) the protected directories.
 */
function assertSafeBuildDir(buildDir, protectedDirs, homeDir) {
  const target = path.resolve(buildDir);
  if (target === path.parse(target).root || target === path.resolve(homeDir)) {
    throw new Error('Refusing to use ' + target + ' as build directory.');
  }
  for (const directory of protectedDirs) {
    const protectedPath = path.resolve(directory);
    if (protectedPath === target || protectedPath.startsWith(target + path.sep)) {
      throw new Error('Refusing to use ' + target + ' as build directory: deleting it would delete ' + protectedPath + '.');
    }
  }
}

/**
 * Placeholders such as `{{name}}` that are still present in rendered HTML.
 *
 * @param {string} html - Rendered page.
 * @returns {Array<string>} Distinct placeholders in order of appearance.
 */
function findLeftoverPlaceholders(html) {
  const found = [];
  const matches = html.match(/{{[^{}]+}}/g);
  if (matches !== null) {
    for (const placeholder of matches) {
      if (!found.includes(placeholder)) {
        found.push(placeholder);
      }
    }
  }
  return found;
}

/**
 * Throw if a required template is missing.
 *
 * @param {string} templatesDir - Templates directory.
 * @returns {void}
 * @throws {Error} Naming the first missing template.
 */
function checkTemplates(templatesDir) {
  for (const name of REQUIRED_TEMPLATES) {
    if (!fs.existsSync(path.join(templatesDir, name))) {
      throw new Error("Template '" + name + "' not found in " + templatesDir + '/');
    }
  }
}

/**
 * Fill in defaults for all options.
 *
 * @param {(SiteOptions|undefined)} options - Options as passed to generateSite.
 * @returns {Settings} Complete settings.
 */
function resolveOptions(options) {
  let given = {};
  if (options !== undefined) {
    given = options;
  }
  let rootDir = process.cwd();
  if (given.rootDir !== undefined) {
    rootDir = given.rootDir;
  }
  const settings = {
    rootDir: rootDir,
    contentDir: path.join(rootDir, 'content'),
    templatesDir: path.join(rootDir, 'templates'),
    buildDir: path.join(rootDir, 'public'),
    siteUrl: '',
    stripImageMetadata: true,
    defaultLang: 'en',
    logger: console,
    homeDir: os.homedir(),
    languages: null,
  };
  for (const name of ['contentDir', 'templatesDir', 'buildDir', 'stripImageMetadata', 'defaultLang', 'logger', 'homeDir']) {
    if (given[name] !== undefined) {
      settings[name] = given[name];
    }
  }
  if (given.siteUrl !== undefined) {
    settings.siteUrl = given.siteUrl.replace(/\/+$/, '');
  }
  if (given.languages !== undefined) {
    checkLanguages(given.languages);
    settings.languages = given.languages;
  }
  return settings;
}

/**
 * Check the `languages` option.
 *
 * @param {Array<Language>} languages - Languages as passed to generateSite.
 * @returns {void}
 * @throws {Error} When there are fewer than two languages, a code is not two
 *   or three lowercase letters or used twice, the first language has a path,
 *   or another language has none or an invalid one.
 */
function checkLanguages(languages) {
  if (!Array.isArray(languages) || languages.length < 2) {
    throw new Error('languages needs at least two entries.');
  }
  const codes = new Set();
  for (let index = 0; index < languages.length; index += 1) {
    const language = languages[index];
    if (!/^[a-z]{2,3}$/.test(language.code) || codes.has(language.code)) {
      throw new Error('Invalid or repeated language code: ' + String(language.code));
    }
    codes.add(language.code);
    if (index === 0 && language.path !== '') {
      throw new Error('The first language is published at the top level; its path must be empty.');
    }
    if (index > 0 && !/^[a-z0-9][a-z0-9-]*$/.test(language.path)) {
      throw new Error('Invalid path for language ' + language.code + ': ' + String(language.path));
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Absolute URL of a file in the build directory, or a root-relative one when
 * no site URL is configured.
 *
 * @param {string} siteUrl - Base URL without trailing slash, or an empty string.
 * @param {string} relativePath - Path relative to the build directory.
 * @returns {string} The URL, with special characters percent-encoded.
 */
function absoluteUrl(siteUrl, relativePath) {
  return siteUrl + '/' + encodeURI(toPosix(relativePath, path.sep));
}

/**
 * Insert the footer, resolve `{{root}}` and warn about placeholders left over.
 *
 * @param {string} html - Rendered page.
 * @param {string} pageFile - Where the page will be written.
 * @param {Settings} settings - Build settings.
 * @param {string} footer - Footer template.
 * @returns {string} The finished page.
 */
function finishPage(html, pageFile, settings, footer) {
  return completePage(fill(html, 'footer', footer), pageFile, settings);
}

/**
 * Resolve `{{root}}` and warn about placeholders left over.
 *
 * @param {string} html - Rendered page, footer already inserted.
 * @param {string} pageFile - Where the page will be written.
 * @param {Settings} settings - Build settings.
 * @returns {string} The finished page.
 */
function completePage(html, pageFile, settings) {
  let root = relativeUrl(path.dirname(pageFile), settings.buildDir);
  if (root !== '') {
    root += '/';
  }
  const page = fill(html, 'root', root);
  const leftover = findLeftoverPlaceholders(page);
  if (leftover.length > 0) {
    settings.logger.warn(
      'WARNING: Unfilled placeholder(s) ' + leftover.join(', ') + ' in ' + path.relative(settings.buildDir, pageFile)
    );
  }
  return page;
}

/**
 * Fill the home page fields from the home article.
 *
 * @param {string} html - Index template, partly filled.
 * @param {Article} home - The home article.
 * @param {string} indexDir - Directory of the index page.
 * @param {string} articleDir - Where the home article's `images/` and `pdfs/` are published.
 * @returns {string} The template with `{{homeTitle}}`, `{{homeImage}}` and `{{homeParagraph1}}`-`{{homeParagraph4}}` filled.
 */
function fillHomeArticle(html, home, indexDir, articleDir) {
  /**
   * Resolve `pdfs/...` link targets relative to the home page.
   *
   * @param {string} href - Link target from Markdown.
   * @returns {string} The target to use in HTML.
   */
  function homeLink(href) {
    if (href.startsWith('pdfs/')) {
      return relativeUrl(indexDir, path.join(articleDir, href));
    }
    return href;
  }

  let image = '';
  if (home.image !== '') {
    image = relativeUrl(indexDir, path.join(articleDir, home.image));
  }
  let result = fill(fill(html, 'homeTitle', home.title), 'homeImage', image);
  const paragraphs = home.body.split(/\n\s*\n/);
  for (let number = 1; number <= 4; number += 1) {
    let text = '';
    if (number <= paragraphs.length) {
      text = inline(paragraphs[number - 1].trim().replace(/\s*\n\s*/g, ' '), homeLink);
    }
    result = fill(result, 'homeParagraph' + String(number), text);
  }
  return result;
}

/**
 * Render the index page.
 *
 * @param {Array<Article>} articles - Sorted articles.
 * @param {Settings} settings - Build settings.
 * @param {Templates} templates - Loaded templates.
 * @returns {string} The finished index page.
 */
function renderIndex(articles, settings, templates) {
  let html = fill(templates.index, 'categories', generateCategoriesHtml(articles, settings.contentDir));
  html = fill(fill(html, 'logoHref', 'index.html'), 'lang', settings.defaultLang);
  for (const article of articles) {
    if (article.category === 'Home') {
      const articleDir = path.join(settings.buildDir, articleOutput(article, settings.contentDir).articleRelativePath);
      html = fillHomeArticle(html, article, settings.buildDir, articleDir);
      break;
    }
  }
  return finishPage(html, path.join(settings.buildDir, 'index.html'), settings, templates.footer);
}

/**
 * Social media image fields of an article, with a warning for missing or small images.
 *
 * @param {Article} article - The article (with an image).
 * @param {PageTarget} target - Where the page and its files go.
 * @param {Settings} settings - Build settings.
 * @returns {{url: string, width: string, height: string}} Values for `og:image`, `og:image:width` and `og:image:height`.
 */
function socialImage(article, target, settings) {
  const imageInBuild = path.join(target.articleDir, article.image);
  const result = {
    url: absoluteUrl(settings.siteUrl, path.relative(settings.buildDir, imageInBuild)),
    width: '',
    height: '',
  };
  const size = getImageDimensions(path.join(target.sourceDir, article.image));
  if (size === null) {
    settings.logger.warn("WARNING: Could not read dimensions for image '" + article.image + "'. Article: " + article.title);
    return result;
  }
  if (size.width < MIN_IMAGE_WIDTH || size.height < MIN_IMAGE_HEIGHT) {
    settings.logger.warn(
      "WARNING: Image '" + article.image + "' is too small for social media cards. " +
        'Recommended: at least ' + String(MIN_IMAGE_WIDTH) + 'x' + String(MIN_IMAGE_HEIGHT) + 'px. ' +
        'Actual: ' + String(size.width) + 'x' + String(size.height) + 'px. ' +
        'Article: ' + article.title
    );
  }
  result.width = String(size.width);
  result.height = String(size.height);
  return result;
}

/**
 * Render an article page.
 *
 * @param {Article} article - The article.
 * @param {Settings} settings - Build settings.
 * @param {Templates} templates - Loaded templates.
 * @returns {{file: string, html: string}} Where to write the page, and its contents.
 */
function renderArticle(article, settings, templates) {
  const location = articleOutput(article, settings.contentDir);
  const outputDir = path.join(settings.buildDir, location.relativeDir);
  const file = path.join(outputDir, location.folderName + '.html');

  let lang = settings.defaultLang;
  if (article.lang !== '') {
    lang = article.lang;
  }
  const target = {
    file: file,
    articleDir: path.join(settings.buildDir, location.articleRelativePath),
    sourceDir: location.articleDir,
    lang: lang,
    indexFile: path.join(settings.buildDir, 'index.html'),
  };
  const html = fillArticleTemplate(templates.article, article, target, settings);
  return { file: file, html: finishPage(html, file, settings, templates.footer) };
}

/**
 * Fill an article template with the fields of an article.
 *
 * @param {string} template - The article template.
 * @param {Article} article - The article.
 * @param {PageTarget} target - Where the page and its files go.
 * @param {Settings} settings - Build settings.
 * @returns {string} The page before the footer and `{{root}}` are filled.
 */
function fillArticleTemplate(template, article, target, settings) {
  const outputDir = path.dirname(target.file);
  let html = fill(template, 'title', escapeQuotes(article.title));
  html = fill(html, 'logoHref', relativeUrl(outputDir, target.indexFile));
  html = fill(html, 'ogUrl', absoluteUrl(settings.siteUrl, path.relative(settings.buildDir, target.file)));
  html = fill(html, 'lang', target.lang);

  // Optional fields: fill them, or remove the template line that would stay empty.
  if (article.authors !== '') {
    html = fill(html, 'authors', escapeQuotes(article.authors));
  } else {
    html = html.replace(/^\s*<p class="article-authors">{{authors}}<\/p>\s*$/gm, '');
  }

  if (article.image !== '') {
    const image = socialImage(article, target, settings);
    html = fill(html, 'image', relativeUrl(outputDir, path.join(target.articleDir, article.image)));
    html = fill(html, 'ogImage', image.url);
    html = fill(html, 'ogImageWidth', image.width);
    html = fill(html, 'ogImageHeight', image.height);
  } else {
    html = html.replace(/^\s*<img[^>]*src="{{image}}"[^>]*>\s*$/gm, '');
    html = html.replace(/^\s*<meta (property|name)="(og|twitter):image(:\w+)?"[^>]*>\s*$/gm, '');
  }

  if (article.explanation !== '') {
    html = fill(html, 'explanation', escapeQuotes(article.explanation));
  } else {
    html = html.replace(/^\s*<p class="article-explanation">{{explanation}}<\/p>\s*$/gm, '');
    html = html.replace(/^\s*<meta (property|name)="(og|twitter):description"[^>]*>\s*$/gm, '');
  }

  return fill(html, 'content', renderMarkdown(article.body, outputDir, target.articleDir));
}

/**
 * Load the templates.
 *
 * @param {string} templatesDir - Templates directory.
 * @returns {Templates} Template contents; the footer is empty if footer.html does not exist.
 */
function loadTemplates(templatesDir) {
  const templates = {
    index: fs.readFileSync(path.join(templatesDir, 'index.html'), 'utf8'),
    article: fs.readFileSync(path.join(templatesDir, 'article.html'), 'utf8'),
    footer: '',
  };
  const footerPath = path.join(templatesDir, 'footer.html');
  if (fs.existsSync(footerPath)) {
    templates.footer = fs.readFileSync(footerPath, 'utf8');
  }
  return templates;
}

/**
 * Print drafts and skipped files.
 *
 * @param {(ArticleCollection|MultilingualCollection)} collection - Result of collectArticles or collectMultilingual.
 * @param {Settings} settings - Build settings.
 * @returns {void}
 */
function reportCollection(collection, settings) {
  if (collection.drafts.length > 0) {
    settings.logger.log('Skipped ' + String(collection.drafts.length) + ' draft(s):');
    for (const file of collection.drafts) {
      settings.logger.log('  - ' + path.relative(settings.contentDir, file));
    }
  }
  if (collection.skipped.length > 0) {
    settings.logger.warn('WARNING: Skipped ' + String(collection.skipped.length) + ' file(s):');
    for (const skipped of collection.skipped) {
      settings.logger.warn('  - ' + path.relative(settings.contentDir, skipped.file) + ': ' + skipped.reason);
    }
  }
}

/**
 * Empty the build directory and copy the shared files: style.css and the
 * template folders (images, icons, fonts). Warns when no site URL is set.
 *
 * @param {Settings} settings - Build settings.
 * @returns {CopyStats} Counter of stripped images, to be continued by the caller.
 * @throws {Error} When the build directory is unsafe.
 */
function prepareBuildDirectory(settings) {
  if (settings.siteUrl === '') {
    settings.logger.warn(
      'WARNING: siteUrl is not set, so og:image and og:url are relative. ' +
        'Social networks need absolute URLs: pass siteUrl: "https://your-domain".'
    );
  }
  assertSafeBuildDir(
    settings.buildDir,
    [settings.rootDir, settings.contentDir, settings.templatesDir, process.cwd()],
    settings.homeDir
  );
  fs.rmSync(settings.buildDir, { recursive: true, force: true });
  fs.mkdirSync(settings.buildDir, { recursive: true });

  const stats = { imagesStripped: 0 };
  fs.copyFileSync(path.join(settings.templatesDir, 'style.css'), path.join(settings.buildDir, 'style.css'));
  for (const name of TEMPLATE_ASSET_DIRECTORIES) {
    const source = path.join(settings.templatesDir, name);
    if (fs.existsSync(source)) {
      copyDirectory(source, path.join(settings.buildDir, name), settings.stripImageMetadata, stats);
    }
  }
  return stats;
}

/**
 * Report the end of a build.
 *
 * @param {CopyStats} stats - Image counter.
 * @param {number} pages - Number of article pages written.
 * @param {Settings} settings - Build settings.
 * @returns {void}
 */
function reportBuild(stats, pages, settings) {
  if (stats.imagesStripped > 0) {
    settings.logger.log('Removed metadata (EXIF/GPS/XMP/text) from ' + String(stats.imagesStripped) + ' image(s).');
  }
  settings.logger.log('Generated ' + String(pages) + ' article(s) in ' + settings.buildDir + '/');
}

/**
 * Build the site.
 *
 * @param {SiteOptions} [options] - Locations and behaviour; every option is optional.
 * @returns {(BuildResult|null)} The published articles, or null when nothing was built
 *   (content directory just created, or no publishable articles).
 * @throws {Error} When a required template is missing, an option is invalid or the build directory is unsafe.
 */
function generateSite(options) {
  const settings = resolveOptions(options);
  checkTemplates(settings.templatesDir);

  if (!fs.existsSync(settings.contentDir)) {
    fs.mkdirSync(settings.contentDir, { recursive: true });
    settings.logger.log('Created ' + settings.contentDir + '/ — add your .md files here.');
    return null;
  }
  if (settings.languages !== null) {
    return generateMultilingualSite(settings);
  }

  const collection = collectArticles(settings.contentDir);
  reportCollection(collection, settings);
  if (collection.articles.length === 0) {
    settings.logger.log('No publishable .md files found in ' + settings.contentDir + '/');
    return null;
  }

  const stats = prepareBuildDirectory(settings);
  const templates = loadTemplates(settings.templatesDir);
  fs.writeFileSync(path.join(settings.buildDir, 'index.html'), renderIndex(collection.articles, settings, templates));

  for (const article of collection.articles) {
    const page = renderArticle(article, settings, templates);
    fs.mkdirSync(path.dirname(page.file), { recursive: true });
    fs.writeFileSync(page.file, page.html);

    const location = articleOutput(article, settings.contentDir);
    for (const name of ARTICLE_ASSET_DIRECTORIES) {
      const source = path.join(location.articleDir, name);
      if (fs.existsSync(source)) {
        copyDirectory(source, path.join(settings.buildDir, location.articleRelativePath, name), settings.stripImageMetadata, stats);
      }
    }
  }

  reportBuild(stats, collection.articles.length, settings);
  return { articles: collection.articles, outputDir: settings.buildDir };
}

// ---------------------------------------------------------------------------
// Multilingual sites
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SectionName
 * @property {string} slug - Address part of the section in this language.
 * @property {string} title - Heading of the section in this language.
 * @property {(number|null)} order - Position among the sections, or null.
 */

/**
 * @typedef {Object} ArticleGroup
 * @property {string} id - `<section folder>/<article folder>`, the same in all languages.
 * @property {string} folder - Name of the article folder (for sorting).
 * @property {string} sourceDir - The article folder in the content directory.
 * @property {Map<string, Article>} translations - Article per language code.
 */

/**
 * @typedef {Object} Section
 * @property {string} folder - Name of the section folder.
 * @property {Map<string, SectionName>} names - Name per language code.
 * @property {Array<ArticleGroup>} groups - Articles of the section, sorted.
 */

/**
 * @typedef {Object} MultilingualCollection
 * @property {Array<Section>} sections - Sections, sorted.
 * @property {Array<string>} drafts - Files marked as drafts.
 * @property {Array<{file: string, reason: string}>} skipped - Files that cannot be published.
 */

/**
 * @typedef {Object} SitePage
 * @property {ArticleGroup} group - The article.
 * @property {Article} article - The translation shown on this page.
 * @property {string} file - Where the page is written.
 */

/**
 * @typedef {Object} MultilingualPlan
 * @property {Array<SitePage>} pages - Article pages to write.
 * @property {Map<string, Map<string, string>>} files - Page file per article id and language code.
 * @property {Map<string, Article>} homes - Home article per language code.
 * @property {Array<{file: string, reason: string}>} skipped - Translations that cannot be published.
 */

/**
 * Language and address part of a content file name such as `de-das-netz.md`.
 *
 * @param {string} name - File name.
 * @param {Array<string>} codes - Configured language codes.
 * @returns {({lang: string, slug: string}|null)} Language and slug, or null when the name does not follow the pattern.
 */
function parseLanguageFileName(name, codes) {
  const match = name.match(/^([a-z]{2,3})-([a-z0-9][a-z0-9-]*)\.md$/);
  if (match === null || !codes.includes(match[1])) {
    return null;
  }
  return { lang: match[1], slug: match[2] };
}

/**
 * Turn the source of a translation file into an article.
 *
 * @param {string} source - File contents.
 * @param {string} filePath - Path of the file.
 * @param {string} lang - Language from the file name.
 * @returns {ParseResult} The article, or why it is not published.
 */
function parseTranslationSource(source, filePath, lang) {
  const text = normalizeNewlines(source.replace(/^﻿/, ''));
  const match = text.match(/^---\n(.*?)\n---(?:\n(.*))?$/s);
  if (match === null) {
    return { article: null, draft: false, skipReason: 'no frontmatter (--- block at the top of the file)' };
  }
  const fields = parseFrontmatter(match[1]);
  if (fieldOrEmpty(fields, 'draft') === 'true') {
    return { article: null, draft: true, skipReason: 'draft' };
  }
  if (fieldOrEmpty(fields, 'title') === '') {
    return { article: null, draft: false, skipReason: 'missing title in frontmatter' };
  }
  let body = '';
  if (match[2] !== undefined) {
    body = match[2].trim();
  }
  return {
    article: {
      category: '',
      title: fields.title,
      authors: fieldOrEmpty(fields, 'authors'),
      image: fieldOrEmpty(fields, 'image'),
      explanation: fieldOrEmpty(fields, 'explanation'),
      lang: lang,
      order: parseOrder(fieldOrEmpty(fields, 'order')),
      toc: fieldOrEmpty(fields, 'toc') !== 'false',
      home: fieldOrEmpty(fields, 'home') === 'true',
      body: body,
      filePath: filePath,
    },
    draft: false,
    skipReason: '',
  };
}

/**
 * Smallest `order:` of several entries, or Infinity when none has one.
 *
 * @param {Array<{order: (number|null)}>} entries - Articles or section names.
 * @returns {number} The smallest order.
 */
function smallestOrder(entries) {
  let smallest = Infinity;
  for (const entry of entries) {
    if (entry.order !== null) {
      smallest = Math.min(smallest, entry.order);
    }
  }
  return smallest;
}

/**
 * @typedef {Object} SortKey
 * @property {string} folder - Folder name.
 * @property {Array<{order: (number|null)}>} entries - Section names or translations, each with an `order:`.
 */

/**
 * Sort comparator for sections and article groups: by smallest `order:`, then by folder name.
 *
 * @param {SortKey} first - One item.
 * @param {SortKey} second - Another item.
 * @returns {number} Negative, zero or positive, as Array#sort expects.
 */
function compareFolders(first, second) {
  const firstOrder = smallestOrder(first.entries);
  const secondOrder = smallestOrder(second.entries);
  if (firstOrder !== secondOrder) {
    return firstOrder - secondOrder;
  }
  if (first.folder < second.folder) {
    return -1;
  }
  if (first.folder > second.folder) {
    return 1;
  }
  return 0;
}

/**
 * Sort key wrapper for a section.
 *
 * @param {Section} section - The section.
 * @returns {SortKey} Folder and names.
 */
function sectionSortKey(section) {
  return { folder: section.folder, entries: Array.from(section.names.values()) };
}

/**
 * Sort key wrapper for an article group.
 *
 * @param {ArticleGroup} group - The article.
 * @returns {SortKey} Folder and translations.
 */
function groupSortKey(group) {
  return { folder: group.folder, entries: Array.from(group.translations.values()) };
}

/**
 * Sort comparator for sections.
 *
 * @param {Section} first - One section.
 * @param {Section} second - Another section.
 * @returns {number} Negative, zero or positive.
 */
function compareSections(first, second) {
  return compareFolders(sectionSortKey(first), sectionSortKey(second));
}

/**
 * Sort comparator for article groups.
 *
 * @param {ArticleGroup} first - One article.
 * @param {ArticleGroup} second - Another article.
 * @returns {number} Negative, zero or positive.
 */
function compareGroups(first, second) {
  return compareFolders(groupSortKey(first), groupSortKey(second));
}

/**
 * Read a multilingual content directory: `<section>/<lang>-<slug>.md` names a
 * section, `<section>/<article>/<lang>-<slug>.md` is one translation of an article.
 *
 * @param {string} contentDir - Content directory.
 * @param {Array<string>} codes - Configured language codes.
 * @returns {MultilingualCollection} Sections with their articles, drafts and skipped files.
 */
function collectMultilingual(contentDir, codes) {
  const collection = { sections: [], drafts: [], skipped: [] };

  /**
   * Note a Markdown file whose name has no configured language prefix.
   *
   * @param {string} file - The file.
   * @returns {void}
   */
  function skipUnnamed(file) {
    collection.skipped.push({ file: file, reason: 'file name does not start with a language code (' + codes.join('-, ') + '-)' });
  }

  for (const sectionFolder of fs.readdirSync(contentDir).sort()) {
    const sectionDir = path.join(contentDir, sectionFolder);
    if (!fs.statSync(sectionDir).isDirectory()) {
      continue;
    }
    const section = { folder: sectionFolder, names: new Map(), groups: [] };
    for (const name of fs.readdirSync(sectionDir).sort()) {
      const entry = path.join(sectionDir, name);
      if (fs.statSync(entry).isDirectory()) {
        const group = { id: path.join(sectionFolder, name), folder: name, sourceDir: entry, translations: new Map() };
        for (const fileName of fs.readdirSync(entry).sort()) {
          if (!fileName.endsWith('.md')) {
            continue;
          }
          const file = path.join(entry, fileName);
          const language = parseLanguageFileName(fileName, codes);
          if (language === null) {
            skipUnnamed(file);
            continue;
          }
          const result = parseTranslationSource(fs.readFileSync(file, 'utf8'), file, language.lang);
          if (result.article !== null) {
            result.article.slug = language.slug;
            group.translations.set(language.lang, result.article);
          } else if (result.draft) {
            collection.drafts.push(file);
          } else {
            collection.skipped.push({ file: file, reason: result.skipReason });
          }
        }
        if (group.translations.size > 0) {
          section.groups.push(group);
        }
      } else if (name.endsWith('.md')) {
        const language = parseLanguageFileName(name, codes);
        if (language === null) {
          skipUnnamed(entry);
          continue;
        }
        const fields = parseFrontmatter(normalizeNewlines(fs.readFileSync(entry, 'utf8')).replace(/^---\n|\n---[\s\S]*$/g, ''));
        if (fieldOrEmpty(fields, 'title') === '') {
          collection.skipped.push({ file: entry, reason: 'missing title in frontmatter' });
          continue;
        }
        section.names.set(language.lang, {
          slug: language.slug,
          title: fields.title,
          order: parseOrder(fieldOrEmpty(fields, 'order')),
        });
      }
    }
    section.groups.sort(compareGroups);
    collection.sections.push(section);
  }
  collection.sections.sort(compareSections);
  return collection;
}

/**
 * Folder of a language in the build directory.
 *
 * @param {Settings} settings - Build settings.
 * @param {string} code - Language code.
 * @returns {string} The folder (the build directory itself for the first language).
 */
function languageDir(settings, code) {
  for (const language of settings.languages) {
    if (language.code === code) {
      return path.join(settings.buildDir, language.path);
    }
  }
  throw new Error('Unknown language ' + code);
}

/**
 * Decide which pages are written where.
 *
 * @param {MultilingualCollection} collection - Result of collectMultilingual.
 * @param {Settings} settings - Build settings.
 * @returns {MultilingualPlan} Pages, page files per article and language, home articles and skipped translations.
 */
function planMultilingual(collection, settings) {
  const plan = { pages: [], files: new Map(), homes: new Map(), skipped: [] };
  for (const section of collection.sections) {
    for (const group of section.groups) {
      const files = new Map();
      for (const entry of group.translations) {
        const lang = entry[0];
        const article = entry[1];
        if (article.home) {
          if (!plan.homes.has(lang)) {
            plan.homes.set(lang, { article: article, group: group });
          }
          continue;
        }
        if (!section.names.has(lang)) {
          plan.skipped.push({
            file: article.filePath,
            reason: 'the section folder ' + section.folder + ' has no ' + lang + '-*.md file with the section name',
          });
          continue;
        }
        const file = path.join(languageDir(settings, lang), section.names.get(lang).slug, article.slug + '.html');
        files.set(lang, file);
        plan.pages.push({ group: group, article: article, file: file });
      }
      plan.files.set(group.id, files);
    }
  }
  return plan;
}

/**
 * Load the texts of one language from `templates/texts/<code>.json`.
 *
 * @param {string} templatesDir - Templates directory.
 * @param {string} code - Language code.
 * @returns {Object<string, string>} Text per key; empty when the file does not exist.
 * @throws {Error} When the file is not valid JSON.
 */
function loadTexts(templatesDir, code) {
  const file = path.join(templatesDir, 'texts', code + '.json');
  if (!fs.existsSync(file)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(file).toString());
}

/**
 * Replace `{{text.key}}` placeholders.
 *
 * @param {string} html - Page.
 * @param {Object<string, string>} texts - Text per key.
 * @returns {string} The page with every known text filled in.
 */
function fillTexts(html, texts) {
  let result = html;
  for (const key of Object.keys(texts)) {
    result = fill(result, 'text.' + key, texts[key]);
  }
  return result;
}

/**
 * Replace `{{link:<section folder>/<article folder>}}` with a link to that
 * article in the page's language. Unknown or untranslated targets stay as
 * they are, so they are reported as unfilled placeholders.
 *
 * @param {string} html - Page.
 * @param {string} pageFile - Where the page is written.
 * @param {string} lang - Language of the page.
 * @param {Map<string, Map<string, string>>} files - Page file per article id and language.
 * @returns {string} The page with links filled in.
 */
function fillLinks(html, pageFile, lang, files) {
  /**
   * Link for one placeholder.
   *
   * @param {string} match - The placeholder.
   * @param {string} id - Article id after `link:`.
   * @returns {string} The relative link, or the placeholder itself.
   */
  function link(match, id) {
    const key = path.join(id);
    if (files.has(key) && files.get(key).has(lang)) {
      return relativeUrl(path.dirname(pageFile), files.get(key).get(lang));
    }
    return match;
  }
  return html.replace(/{{link:([^{}]+)}}/g, link);
}

/**
 * The language switch for a page: the other translations as links, the
 * current language as plain text. Empty when the page has no translation.
 *
 * @param {string} pageFile - Where the page is written.
 * @param {string} lang - Language of the page.
 * @param {Map<string, string>} translations - Page file per language.
 * @param {Array<Language>} languages - Configured languages, in order.
 * @returns {string} HTML.
 */
function languageSwitch(pageFile, lang, translations, languages) {
  if (translations.size < 2) {
    return '';
  }
  const items = [];
  for (const language of languages) {
    if (!translations.has(language.code)) {
      continue;
    }
    const label = language.code.toUpperCase();
    if (language.code === lang) {
      items.push('<span aria-current="page">' + label + '</span>');
    } else {
      const href = relativeUrl(path.dirname(pageFile), translations.get(language.code));
      items.push('<a href="' + href + '" hreflang="' + language.code + '" lang="' + language.code + '">' + label + '</a>');
    }
  }
  return '<nav class="language-switch">' + items.join(' | ') + '</nav>';
}

/**
 * `<link rel="alternate" hreflang>` tags that tell search engines about the
 * translations of a page. Empty when the page has no translation.
 *
 * @param {Map<string, string>} translations - Page file per language.
 * @param {string} defaultFile - Page for visitors whose language is not offered (`x-default`), or an empty string for none.
 * @param {Settings} settings - Build settings.
 * @returns {string} HTML, one tag per line.
 */
function alternateLinks(translations, defaultFile, settings) {
  if (translations.size < 2) {
    return '';
  }
  const tags = [];
  for (const language of settings.languages) {
    if (translations.has(language.code)) {
      const url = absoluteUrl(settings.siteUrl, path.relative(settings.buildDir, translations.get(language.code)));
      tags.push('<link rel="alternate" hreflang="' + language.code + '" href="' + url + '">');
    }
  }
  if (defaultFile !== '') {
    tags.push('<link rel="alternate" hreflang="x-default" href="' + absoluteUrl(settings.siteUrl, path.relative(settings.buildDir, defaultFile)) + '">');
  }
  return tags.join('\n');
}

/**
 * Script for the home page of the first language: visitors who arrive from
 * another site and whose browser does not prefer this language are sent to
 * the home page of their language, or of the second language. Visitors who
 * click through the site are never redirected.
 *
 * @param {Array<Language>} languages - Configured languages, in order.
 * @returns {string} A `<script>` element.
 */
function languageRedirectScript(languages) {
  const targets = {};
  for (const language of languages) {
    let target = '';
    if (language.path !== '') {
      target = language.path + '/index.html';
    }
    targets[language.code] = target;
  }
  return [
    '<script>',
    '(function () {',
    '  var targets = ' + JSON.stringify(targets) + ';',
    '  var site = location.protocol + "//" + location.host + "/";',
    '  if (document.referrer.indexOf(site) === 0) {',
    '    return;',
    '  }',
    '  var wanted = navigator.languages;',
    '  if (wanted === undefined || wanted.length === 0) {',
    '    wanted = [navigator.language];',
    '  }',
    '  for (var index = 0; index < wanted.length; index += 1) {',
    '    var code = String(wanted[index]).toLowerCase().split("-")[0];',
    '    if (Object.prototype.hasOwnProperty.call(targets, code)) {',
    '      if (targets[code] !== "") {',
    '        location.replace(targets[code]);',
    '      }',
    '      return;',
    '    }',
    '  }',
    '  location.replace(' + JSON.stringify(targets[languages[1].code]) + ');',
    '})();',
    '</script>',
  ].join('\n');
}

/**
 * The page for unknown addresses (`404.html`): it forwards to the home page
 * of the language the address belongs to, and links to all home pages when
 * JavaScript is off.
 *
 * @param {Array<Language>} languages - Configured languages, in order.
 * @param {Map<string, Object<string, string>>} texts - Texts per language; `notFound` and `languageName` are used.
 * @returns {string} The complete page.
 */
function notFoundPage(languages, texts) {
  const messages = [];
  const links = [];
  const prefixes = [];
  for (const language of languages) {
    const languageTexts = texts.get(language.code);
    let home = '/';
    if (language.path !== '') {
      home = '/' + language.path + '/';
      prefixes.push('  if (location.pathname.indexOf(' + JSON.stringify(home) + ') === 0) {\n    target = ' + JSON.stringify(home) + ';\n  }');
    }
    let message = 'Page not found';
    if ('notFound' in languageTexts) {
      message = languageTexts.notFound;
    }
    let name = language.code.toUpperCase();
    if ('languageName' in languageTexts) {
      name = languageTexts.languageName;
    }
    messages.push(message);
    links.push('<a href="' + home + '" hreflang="' + language.code + '">' + name + '</a>');
  }
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<meta name="robots" content="noindex">',
    '<title>404</title>',
    '<script>',
    '(function () {',
    '  var target = "/";',
    prefixes.join('\n'),
    '  location.replace(target);',
    '})();',
    '</script>',
    '</head>',
    '<body>',
    '<p>' + messages.join(' / ') + '</p>',
    '<p>' + links.join(' · ') + '</p>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Fill everything that is specific to a page of a multilingual site, then finish it.
 *
 * @param {string} html - Page with its own fields filled.
 * @param {{file: string, lang: string, translations: Map<string, string>, isHome: boolean}} page - The page.
 * @param {{settings: Settings, templates: Templates, texts: Map<string, Object<string, string>>, plan: MultilingualPlan}} context - Build data.
 * @returns {string} The finished page.
 */
function finishMultilingualPage(html, page, context) {
  const settings = context.settings;
  let defaultFile = '';
  let redirect = '';
  if (page.isHome) {
    defaultFile = path.join(settings.buildDir, 'index.html');
    if (page.lang === settings.languages[0].code) {
      redirect = languageRedirectScript(settings.languages);
    }
  }
  let result = fill(html, 'footer', context.templates.footer);
  result = fillTexts(result, context.texts.get(page.lang));
  result = fillLinks(result, page.file, page.lang, context.plan.files);
  result = fill(result, 'languageSwitch', languageSwitch(page.file, page.lang, page.translations, settings.languages));
  result = fill(result, 'alternateLinks', alternateLinks(page.translations, defaultFile, settings));
  result = fill(result, 'languageRedirect', redirect);
  return completePage(result, page.file, settings);
}

/**
 * Table of contents of one language: one section per section folder with
 * articles in this language, articles with `toc: false` left out.
 *
 * @param {MultilingualCollection} collection - Sections and articles.
 * @param {MultilingualPlan} plan - Page files.
 * @param {string} lang - Language.
 * @param {string} indexDir - Directory of the index page.
 * @returns {string} HTML.
 */
function multilingualTableOfContents(collection, plan, lang, indexDir) {
  let html = '';
  for (const section of collection.sections) {
    let items = '';
    for (const group of section.groups) {
      const files = plan.files.get(group.id);
      if (files.has(lang) && group.translations.get(lang).toc) {
        items += '<p><a href="' + relativeUrl(indexDir, files.get(lang)) + '">' + group.translations.get(lang).title + '</a></p>\n';
      }
    }
    if (items !== '') {
      html += '<section>\n<h2>' + section.names.get(lang).title + '</h2>\n' + items + '</section>\n';
    }
  }
  return html;
}

/**
 * Build a multilingual site (see the `languages` option).
 *
 * @param {Settings} settings - Build settings with `languages`.
 * @returns {(BuildResult|null)} The published translations, or null when nothing was published.
 * @throws {Error} When the build directory is unsafe or a texts file is not valid JSON.
 */
function generateMultilingualSite(settings) {
  const codes = [];
  for (const language of settings.languages) {
    codes.push(language.code);
  }
  const collection = collectMultilingual(settings.contentDir, codes);
  const plan = planMultilingual(collection, settings);
  for (const skipped of plan.skipped) {
    collection.skipped.push(skipped);
  }
  reportCollection(collection, settings);
  if (plan.pages.length === 0 && plan.homes.size === 0) {
    settings.logger.log('No publishable .md files found in ' + settings.contentDir + '/');
    return null;
  }

  const stats = prepareBuildDirectory(settings);
  const templates = loadTemplates(settings.templatesDir);
  const texts = new Map();
  for (const code of codes) {
    texts.set(code, loadTexts(settings.templatesDir, code));
  }
  const context = { settings: settings, templates: templates, texts: texts, plan: plan };

  const indexFiles = new Map();
  for (const code of codes) {
    indexFiles.set(code, path.join(languageDir(settings, code), 'index.html'));
  }
  for (const code of codes) {
    const indexFile = indexFiles.get(code);
    const indexDir = path.dirname(indexFile);
    let html = fill(templates.index, 'categories', multilingualTableOfContents(collection, plan, code, indexDir));
    html = fill(fill(html, 'logoHref', 'index.html'), 'lang', code);
    if (plan.homes.has(code)) {
      const home = plan.homes.get(code);
      html = fillHomeArticle(html, home.article, indexDir, path.join(settings.buildDir, 'media', home.group.id));
    }
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(indexFile, finishMultilingualPage(html, { file: indexFile, lang: code, translations: indexFiles, isHome: true }, context));
  }

  const published = [];
  for (const page of plan.pages) {
    const target = {
      file: page.file,
      articleDir: path.join(settings.buildDir, 'media', page.group.id),
      sourceDir: page.group.sourceDir,
      lang: page.article.lang,
      indexFile: indexFiles.get(page.article.lang),
    };
    const html = fillArticleTemplate(templates.article, page.article, target, settings);
    const translations = plan.files.get(page.group.id);
    fs.mkdirSync(path.dirname(page.file), { recursive: true });
    fs.writeFileSync(page.file, finishMultilingualPage(html, { file: page.file, lang: page.article.lang, translations: translations, isHome: false }, context));
    published.push(page.article);
  }

  for (const section of collection.sections) {
    for (const group of section.groups) {
      for (const name of ARTICLE_ASSET_DIRECTORIES) {
        const source = path.join(group.sourceDir, name);
        if (fs.existsSync(source)) {
          copyDirectory(source, path.join(settings.buildDir, 'media', group.id, name), settings.stripImageMetadata, stats);
        }
      }
    }
  }
  fs.writeFileSync(path.join(settings.buildDir, '404.html'), notFoundPage(settings.languages, texts));

  reportBuild(stats, published.length, settings);
  return { articles: published, outputDir: settings.buildDir };
}

/**
 * Command line entry point: builds the site in the current directory.
 *
 * @param {Object<string, (string|undefined)>} environment - Environment variables; `SITE_URL` sets the site URL.
 * @param {Logger} logger - Where messages go.
 * @returns {number} Exit code: 0 on success, 1 on error.
 */
function runCli(environment, logger) {
  try {
    generateSite({ rootDir: process.cwd(), siteUrl: environment.SITE_URL, logger: logger });
  } catch (error) {
    logger.error('Error: ' + error.message);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = runCli(process.env, console);
}

module.exports = {
  MIN_IMAGE_HEIGHT: MIN_IMAGE_HEIGHT,
  MIN_IMAGE_WIDTH: MIN_IMAGE_WIDTH,
  absoluteUrl: absoluteUrl,
  alternateLinks: alternateLinks,
  articleOutput: articleOutput,
  assertSafeBuildDir: assertSafeBuildDir,
  checkLanguages: checkLanguages,
  checkTemplates: checkTemplates,
  closeList: closeList,
  collectArticles: collectArticles,
  collectMultilingual: collectMultilingual,
  compareArticles: compareArticles,
  completePage: completePage,
  compareFolders: compareFolders,
  compareGroups: compareGroups,
  compareSections: compareSections,
  copyDirectory: copyDirectory,
  emphasis: emphasis,
  escapeHtml: escapeHtml,
  escapeQuotes: escapeQuotes,
  exifOrientationSegment: exifOrientationSegment,
  fieldOrEmpty: fieldOrEmpty,
  fill: fill,
  fillArticleTemplate: fillArticleTemplate,
  fillHomeArticle: fillHomeArticle,
  fillLinks: fillLinks,
  fillTexts: fillTexts,
  findJpegOrientation: findJpegOrientation,
  findLeftoverPlaceholders: findLeftoverPlaceholders,
  findMetadataStripper: findMetadataStripper,
  finishMultilingualPage: finishMultilingualPage,
  finishPage: finishPage,
  generateCategoriesHtml: generateCategoriesHtml,
  generateMultilingualSite: generateMultilingualSite,
  generateSite: generateSite,
  getImageDimensions: getImageDimensions,
  getImageSize: getImageSize,
  getJpegInfo: getJpegInfo,
  groupSortKey: groupSortKey,
  inline: inline,
  isExternalUrl: isExternalUrl,
  isJpegMetadataSegment: isJpegMetadataSegment,
  isPng: isPng,
  isStandaloneJpegMarker: isStandaloneJpegMarker,
  isStartOfFrameMarker: isStartOfFrameMarker,
  languageDir: languageDir,
  languageRedirectScript: languageRedirectScript,
  languageSwitch: languageSwitch,
  loadTemplates: loadTemplates,
  loadTexts: loadTexts,
  markdownToHtml: markdownToHtml,
  multilingualTableOfContents: multilingualTableOfContents,
  normalizeNewlines: normalizeNewlines,
  notFoundPage: notFoundPage,
  orderValue: orderValue,
  parseArticleSource: parseArticleSource,
  parseFrontmatter: parseFrontmatter,
  parseLanguageFileName: parseLanguageFileName,
  parseMarkdown: parseMarkdown,
  parseOrder: parseOrder,
  parseTranslationSource: parseTranslationSource,
  planMultilingual: planMultilingual,
  prepareBuildDirectory: prepareBuildDirectory,
  readArticle: readArticle,
  readExifOrientation: readExifOrientation,
  readJpegLayout: readJpegLayout,
  readUInt16: readUInt16,
  readUInt32: readUInt32,
  relativeUrl: relativeUrl,
  renderArticle: renderArticle,
  renderImage: renderImage,
  renderIndex: renderIndex,
  renderMarkdown: renderMarkdown,
  reportBuild: reportBuild,
  reportCollection: reportCollection,
  resolveOptions: resolveOptions,
  runCli: runCli,
  sectionSortKey: sectionSortKey,
  smallestOrder: smallestOrder,
  socialImage: socialImage,
  stripJpegMetadata: stripJpegMetadata,
  stripPngMetadata: stripPngMetadata,
  toPosix: toPosix,
};

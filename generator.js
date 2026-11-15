const fs = require('fs');
const os = require('os');
const path = require('path');

// Minimum recommended dimensions for social media cards
const MIN_IMAGE_WIDTH = 1200;
const MIN_IMAGE_HEIGHT = 627;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Paths written into HTML must always use forward slashes, also on Windows.
const toPosix = p => p.split(path.sep).join('/');

// Replace every {{key}} in a template. split/join is used instead of
// String.replace so that `$&`, `$'`, `$$` etc. in the value are inserted
// literally instead of being interpreted as replacement patterns.
function fill(template, key, value) {
  return template.split(`{{${key}}}`).join(value == null ? '' : String(value));
}

// Frontmatter values end up both in text and in attributes (alt="", content="").
// Entities such as &laquo; are intentionally kept; only quotes are escaped.
const escapeQuotes = s => String(s).replace(/"/g, '&quot;');

const isExternalUrl = s => /^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(s);

// ---------------------------------------------------------------------------
// Images: dimensions and metadata stripping (no dependencies)
// ---------------------------------------------------------------------------

const JPEG_STANDALONE = m => m === 0x01 || (m >= 0xD0 && m <= 0xD7);
const JPEG_SOF = m => m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC;

// Walk the JPEG segments after SOI, in order, calling visit(marker, start, end)
// for each one up to Start Of Scan. visit may return false to stop early.
// Returns the offset of SOS (or of the segment where visit stopped), or -1 if
// the file is not a well-formed JPEG.
function walkJpegSegments(buf, visit) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return -1;
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xFF) return -1;
    const marker = buf[i + 1];
    if (marker === 0xFF) { i++; continue; } // fill byte
    if (JPEG_STANDALONE(marker)) { visit(marker, i, i + 2); i += 2; continue; }
    if (marker === 0xDA) return i; // Start Of Scan: compressed data follows
    if (marker === 0xD9 || i + 4 > buf.length) return -1;
    const end = i + 2 + buf.readUInt16BE(i + 2);
    if (end > buf.length) return -1;
    if (visit(marker, i, end) === false) return i;
    i = end;
  }
  return -1;
}

// Read the EXIF orientation (1-8) from an APP1 segment, or 1 if absent.
function readExifOrientation(seg) {
  try {
    if (seg.toString('latin1', 4, 10) !== 'Exif\0\0') return 1;
    const tiff = 10;
    const le = seg.toString('latin1', tiff, tiff + 2) === 'II';
    const u16 = o => (le ? seg.readUInt16LE(o) : seg.readUInt16BE(o));
    const u32 = o => (le ? seg.readUInt32LE(o) : seg.readUInt32BE(o));
    const ifd = tiff + u32(tiff + 4);
    const count = u16(ifd);
    for (let n = 0; n < count; n++) {
      const entry = ifd + 2 + n * 12;
      if (u16(entry) === 0x0112) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
  } catch (e) {
    // Malformed EXIF: treat as "no rotation".
  }
  return 1;
}

// A minimal APP1/EXIF segment that carries nothing but the orientation, so
// that rotated photos still display upright after their metadata is removed.
function exifOrientationSegment(orientation) {
  const seg = Buffer.alloc(36);
  seg.writeUInt16BE(0xFFE1, 0);
  seg.writeUInt16BE(34, 2); // segment length, excluding the marker
  seg.write('Exif\0\0', 4, 'latin1');
  seg.write('MM', 10, 'latin1'); // big-endian TIFF header
  seg.writeUInt16BE(42, 12);
  seg.writeUInt32BE(8, 14); // offset of IFD0
  seg.writeUInt16BE(1, 18); // one entry
  seg.writeUInt16BE(0x0112, 20); // tag: Orientation
  seg.writeUInt16BE(3, 22); // type: SHORT
  seg.writeUInt32BE(1, 24); // count
  seg.writeUInt16BE(orientation, 28);
  seg.writeUInt32BE(0, 32); // no next IFD
  return seg;
}

function getJpegInfo(buf) {
  let size = null;
  let orientation = 1;
  walkJpegSegments(buf, (marker, start, end) => {
    if (marker === 0xE1) {
      const o = readExifOrientation(buf.subarray(start, end));
      if (o !== 1) orientation = o;
    }
    if (JPEG_SOF(marker) && end - start >= 9) {
      size = { height: buf.readUInt16BE(start + 5), width: buf.readUInt16BE(start + 7) };
      return false;
    }
    return true;
  });
  return size && { ...size, orientation };
}

/**
 * Remove metadata (EXIF incl. GPS, XMP, IPTC/Photoshop, comments) from a JPEG.
 * Keeps JFIF (APP0), the ICC colour profile (APP2 "ICC_PROFILE") and the Adobe
 * colour transform marker (APP14), and re-adds the EXIF orientation if the
 * photo needs rotating. Returns the input unchanged if it cannot be parsed.
 */
function stripJpegMetadata(buf) {
  const kept = [];
  let orientation = 1;
  const sos = walkJpegSegments(buf, (marker, start, end) => {
    const seg = buf.subarray(start, end);
    if (marker === 0xE1) {
      const o = readExifOrientation(seg);
      if (o !== 1) orientation = o;
      return true; // drop EXIF / XMP
    }
    if (marker === 0xE2 && seg.toString('latin1', 4, 16) !== 'ICC_PROFILE\0') return true;
    if (marker >= 0xE3 && marker <= 0xED) return true; // APP3-APP13 (incl. Photoshop/IPTC)
    if (marker === 0xEF || marker === 0xFE) return true; // APP15, comments
    kept.push({ marker, seg });
    return true;
  });
  if (sos < 0) return buf;

  const parts = [buf.subarray(0, 2), ...kept.map(k => k.seg)];
  if (orientation !== 1) {
    // EXIF conventionally follows SOI, or the JFIF segment if there is one.
    const at = kept.length && kept[0].marker === 0xE0 ? 2 : 1;
    parts.splice(at, 0, exifOrientationSegment(orientation));
  }
  parts.push(buf.subarray(sos));
  return Buffer.concat(parts);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

/**
 * Remove text, EXIF and timestamp chunks from a PNG. Returns the input
 * unchanged if it cannot be parsed.
 */
function stripPngMetadata(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return buf;
  const parts = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const length = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + length;
    if (end > buf.length) return buf;
    if (!PNG_METADATA_CHUNKS.has(type)) parts.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  return buf;
}

const METADATA_STRIPPERS = {
  '.jpg': stripJpegMetadata,
  '.jpeg': stripJpegMetadata,
  '.png': stripPngMetadata,
};

/**
 * Width and height of a JPEG or PNG as it is displayed (EXIF rotation applied),
 * or null if unknown.
 */
function getImageDimensions(filePath) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (e) {
    return null;
  }

  const jpeg = getJpegInfo(buffer);
  if (jpeg) {
    // Orientations 5-8 rotate by 90°, which swaps width and height on screen.
    return jpeg.orientation >= 5
      ? { width: jpeg.height, height: jpeg.width }
      : { width: jpeg.width, height: jpeg.height };
  }

  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  return null;
}

// Copy a directory recursively. Images are passed through the metadata
// strippers when stripMetadata is set; everything else is copied as is.
function copyDir(src, dest, { stripMetadata, stats }) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to, { stripMetadata, stats });
      continue;
    }
    const strip = stripMetadata && METADATA_STRIPPERS[path.extname(entry.name).toLowerCase()];
    if (!strip) {
      fs.copyFileSync(from, to);
      continue;
    }
    const input = fs.readFileSync(from);
    const output = strip(input);
    fs.writeFileSync(to, output);
    if (stats && output.length !== input.length) stats.imagesStripped++;
  }
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

// Emphasis. Underscores only count at word boundaries, so snake_case words
// and URLs are left alone; asterisks may also be used inside words.
function emphasis(text) {
  return text
    .replace(/(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, '<strong>$1</strong>')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, '<em>$1</em>')
    .replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, '<em>$1</em>');
}

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Spans that must not be touched by emphasis: `code`, [links](url), raw HTML
// tags and bare URLs. They are matched in a single left-to-right pass.
const INLINE_TOKENS =
  /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|<\/?[a-zA-Z][^>]*>|(?<![\w/"'=])(https?:\/\/[^\s<>"()]*[^\s<>"().,;:!?'])/g;

function inline(text, linkHref = href => href) {
  const stash = [];
  const keep = html => `\u0000${stash.push(html) - 1}\u0000`;

  const protectedText = text.replace(INLINE_TOKENS, (match, code, linkText, href, url) => {
    if (code !== undefined) return keep(`<code>${escapeHtml(code)}</code>`);
    if (linkText !== undefined) return keep(`<a href="${linkHref(href.trim())}">${emphasis(linkText)}</a>`);
    if (url !== undefined) return keep(`<a href="${url}">${url}</a>`);
    return keep(match); // raw HTML tag
  });

  return emphasis(protectedText).replace(/\u0000(\d+)\u0000/g, (m, n) => stash[Number(n)]);
}

function markdownToHtml(markdown, outputDir, articleRelativePath) {
  const articleDir = path.join(path.dirname(outputDir), articleRelativePath);
  const relativeToPage = target => toPosix(path.relative(outputDir, target));

  const linkHref = href =>
    href.startsWith('pdfs/') ? relativeToPage(path.join(articleDir, 'pdfs', href.substring(5))) : href;
  const fmt = text => inline(text, linkHref);

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let list = null; // 'ul' | 'ol' | null

  const closeList = () => {
    if (list) html += `</${list}>\n`;
    list = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html += `<h${level}>${fmt(heading[2])}</h${level}>\n`;
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) {
        closeList();
        html += `<${type}>\n`;
        list = type;
      }
      html += `<li>${fmt((bullet || numbered)[1])}</li>\n`;
      continue;
    }

    closeList();

    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      let src = image[2].trim();
      if (!isExternalUrl(src)) {
        if (src.startsWith('images/')) src = src.substring(7);
        src = relativeToPage(path.join(articleDir, 'images', src));
      }
      html += `<p><img src="${src}" alt="${escapeQuotes(image[1])}" class="article-inline-image"></p>\n`;
      if (image[1]) html += `<p class="article-explanation">${fmt(image[1])}</p>\n`;
      continue;
    }

    html += `<p>${fmt(trimmed)}</p>\n`;
  }

  closeList();
  return html.trim();
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

// Returns the parsed article, or { skipped: reason } if the file is not published.
function readArticle(filePath) {
  const content = fs
    .readFileSync(filePath, 'utf8')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');
  const match = content.match(/^---\n(.*?)\n---(?:\n(.*))?$/s);

  if (!match) {
    return { skipped: 'no frontmatter (--- block at the top of the file)' };
  }

  const fm = {};
  match[1].split('\n').forEach(line => {
    const m = line.match(/^(\w+):\s*(.*)/);
    if (m) fm[m[1]] = m[2].trim();
  });

  if (fm.draft === 'true') {
    return { skipped: 'draft', draft: true };
  }

  const missing = ['category', 'title'].filter(key => !fm[key]);
  if (missing.length) {
    return { skipped: `missing ${missing.join(' and ')} in frontmatter` };
  }

  const order = fm.order ? Number(fm.order) : NaN;

  return {
    category: fm.category,
    title: fm.title,
    authors: fm.authors || '',
    image: fm.image || '',
    explanation: fm.explanation || '',
    lang: fm.lang || '',
    order: Number.isFinite(order) ? order : null,
    toc: fm.toc !== 'false', // default to true unless explicitly set to 'false'
    body: (match[2] || '').trim(),
    filePath,
  };
}

// Kept for compatibility: returns null for files that are not published.
function parseMarkdown(filePath) {
  const result = readArticle(filePath);
  return result.skipped ? null : result;
}

// content/<dir>/<slug>/<file>.md is published as <build>/<dir>/<slug>.html
function articleOutput(article, contentDir) {
  const articleDir = path.dirname(article.filePath);
  return {
    articleDir,
    relativeDir: path.relative(contentDir, path.dirname(articleDir)),
    articleRelativePath: path.relative(contentDir, articleDir),
    folderName: path.basename(articleDir),
  };
}

// Articles with an explicit `order:` come first (ascending); the rest follow,
// sorted by their path in the content directory.
function compareArticles(a, b) {
  const ao = a.order === null ? Infinity : a.order;
  const bo = b.order === null ? Infinity : b.order;
  if (ao !== bo) return ao - bo;
  return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
}

function generateCategoriesHtml(articles, contentDir) {
  const byCategory = new Map();
  articles.forEach(a => {
    // Skip articles with toc: false
    if (a.toc === false) return;
    if (!byCategory.has(a.category)) byCategory.set(a.category, []);
    byCategory.get(a.category).push(a);
  });

  let html = '';
  for (const [category, list] of byCategory) {
    html += `<section>\n<h2>${category}</h2>\n`;
    list.forEach(a => {
      const { relativeDir, folderName } = articleOutput(a, contentDir);
      const href = toPosix(path.join(relativeDir, folderName + '.html'));
      html += `<p><a href="${href}">${a.title}</a></p>\n`;
    });
    html += `</section>\n`;
  }
  return html;
}

// The build directory is deleted before every build. Refuse directories that
// would take sources (or worse) with them.
function assertSafeBuildDir(buildDir, protectedDirs) {
  const target = path.resolve(buildDir);
  if (target === path.parse(target).root || target === os.homedir()) {
    throw new Error(`Refusing to use ${target} as build directory.`);
  }
  for (const dir of protectedDirs) {
    const p = path.resolve(dir);
    if (p === target || p.startsWith(target + path.sep)) {
      throw new Error(`Refusing to use ${target} as build directory: deleting it would delete ${p}.`);
    }
  }
}

function warnLeftoverPlaceholders(html, page) {
  const left = [...new Set(html.match(/{{\s*[\w.]+\s*}}/g) || [])];
  if (left.length) {
    console.warn(`WARNING: Unfilled placeholder(s) ${left.join(', ')} in ${page}`);
  }
}

/**
 * Build the site. All options are optional:
 *
 *   rootDir             project directory (default: current directory)
 *   contentDir          default <rootDir>/content
 *   templatesDir        default <rootDir>/templates
 *   buildDir            default <rootDir>/public — deleted and rebuilt every time
 *   siteUrl             e.g. "https://example.com"; makes og:image / og:url absolute
 *   stripImageMetadata  remove EXIF (incl. GPS), XMP, IPTC and text chunks from
 *                       published JPEG/PNG images (default true)
 *   defaultLang         value of {{lang}} when an article has no `lang:` (default "en")
 */
function generateSite({
  rootDir = process.cwd(),
  contentDir,
  templatesDir,
  buildDir,
  siteUrl = '',
  stripImageMetadata = true,
  defaultLang = 'en',
} = {}) {
  const siteContentDir = contentDir || path.join(rootDir, 'content');
  const siteTemplatesDir = templatesDir || path.join(rootDir, 'templates');
  const siteBuildDir = buildDir || path.join(rootDir, 'public');
  const baseUrl = String(siteUrl || '').replace(/\/+$/, '');

  for (const tpl of ['index.html', 'article.html', 'style.css']) {
    if (!fs.existsSync(path.join(siteTemplatesDir, tpl))) {
      throw new Error(`Template '${tpl}' not found in ${siteTemplatesDir}/`);
    }
  }

  if (!fs.existsSync(siteContentDir)) {
    fs.mkdirSync(siteContentDir, { recursive: true });
    console.log(`Created ${siteContentDir}/ — add your .md files here.`);
    return;
  }

  const articles = [];
  const skippedFiles = [];
  const drafts = [];

  (function readFiles(d) {
    fs.readdirSync(d).sort().forEach(f => {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) {
        readFiles(p);
      } else if (f.endsWith('.md')) {
        const result = readArticle(p);
        if (!result.skipped) articles.push(result);
        else if (result.draft) drafts.push(p);
        else skippedFiles.push({ file: p, reason: result.skipped });
      }
    });
  })(siteContentDir);

  articles.sort(compareArticles);

  if (drafts.length > 0) {
    console.log(`Skipped ${drafts.length} draft(s):`);
    drafts.forEach(f => console.log(`  - ${path.relative(siteContentDir, f)}`));
  }
  if (skippedFiles.length > 0) {
    console.warn(`WARNING: Skipped ${skippedFiles.length} file(s):`);
    skippedFiles.forEach(s => console.warn(`  - ${path.relative(siteContentDir, s.file)}: ${s.reason}`));
  }

  if (articles.length === 0) {
    console.log(`No publishable .md files found in ${siteContentDir}/`);
    return;
  }

  if (!baseUrl) {
    console.warn(
      'WARNING: siteUrl is not set, so og:image and og:url are relative. ' +
        'Social networks need absolute URLs: pass siteUrl: "https://your-domain".'
    );
  }
  const absoluteUrl = relPath => `${baseUrl}/${encodeURI(toPosix(relPath))}`;

  assertSafeBuildDir(siteBuildDir, [rootDir, siteContentDir, siteTemplatesDir, process.cwd()]);
  fs.rmSync(siteBuildDir, { recursive: true, force: true });
  fs.mkdirSync(siteBuildDir, { recursive: true });

  const stats = { imagesStripped: 0 };
  const copyOptions = { stripMetadata: stripImageMetadata, stats };

  fs.copyFileSync(path.join(siteTemplatesDir, 'style.css'), path.join(siteBuildDir, 'style.css'));

  for (const dir of ['images', 'icons']) {
    const src = path.join(siteTemplatesDir, dir);
    if (fs.existsSync(src)) copyDir(src, path.join(siteBuildDir, dir), copyOptions);
  }

  const indexTpl = fs.readFileSync(path.join(siteTemplatesDir, 'index.html'), 'utf8');
  const articleTpl = fs.readFileSync(path.join(siteTemplatesDir, 'article.html'), 'utf8');
  const footerPath = path.join(siteTemplatesDir, 'footer.html');
  const footerTpl = fs.existsSync(footerPath) ? fs.readFileSync(footerPath, 'utf8') : '';

  // Shared parts of every page. {{root}} is the relative path from the page to
  // the site root ("" or "../" ...), so templates and the footer can link to
  // any page regardless of how deep the current page is.
  const finishPage = (html, pageFile) => {
    const root = toPosix(path.relative(path.dirname(pageFile), siteBuildDir));
    html = fill(html, 'footer', footerTpl);
    html = fill(html, 'root', root ? root + '/' : '');
    warnLeftoverPlaceholders(html, path.relative(siteBuildDir, pageFile));
    return html;
  };

  let indexHtml = indexTpl;
  indexHtml = fill(indexHtml, 'categories', generateCategoriesHtml(articles, siteContentDir));
  indexHtml = fill(indexHtml, 'logoHref', 'index.html');
  indexHtml = fill(indexHtml, 'lang', defaultLang);

  // Inject home article content if a "Home" category article exists
  const homeArticle = articles.find(a => a.category === 'Home');
  if (homeArticle) {
    const { articleRelativePath } = articleOutput(homeArticle, siteContentDir);
    const paragraphs = homeArticle.body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const homeLink = href => (href.startsWith('pdfs/') ? toPosix(path.join(articleRelativePath, href)) : href);
    const homeImage = homeArticle.image ? toPosix(path.join(articleRelativePath, homeArticle.image)) : '';
    indexHtml = fill(indexHtml, 'homeTitle', homeArticle.title);
    indexHtml = fill(indexHtml, 'homeImage', homeImage);
    for (let n = 1; n <= 4; n++) {
      const paragraph = paragraphs[n - 1] || '';
      indexHtml = fill(indexHtml, `homeParagraph${n}`, inline(paragraph.replace(/\s*\n\s*/g, ' '), homeLink));
    }
  }

  const indexFile = path.join(siteBuildDir, 'index.html');
  fs.writeFileSync(indexFile, finishPage(indexHtml, indexFile));

  articles.forEach(a => {
    const { articleDir, relativeDir, articleRelativePath, folderName } = articleOutput(a, siteContentDir);
    const outputDir = path.join(siteBuildDir, relativeDir);
    fs.mkdirSync(outputDir, { recursive: true });
    const filename = path.join(outputDir, folderName + '.html');

    let imageRelativeToOutput = '';
    let ogImage = '';
    let ogImageWidth = '';
    let ogImageHeight = '';

    if (a.image) {
      const imageInBuild = path.join(siteBuildDir, articleRelativePath, a.image);
      imageRelativeToOutput = toPosix(path.relative(outputDir, imageInBuild));
      ogImage = absoluteUrl(path.relative(siteBuildDir, imageInBuild));

      const dims = getImageDimensions(path.join(siteContentDir, articleRelativePath, a.image));
      if (dims) {
        if (dims.width < MIN_IMAGE_WIDTH || dims.height < MIN_IMAGE_HEIGHT) {
          console.warn(
            `WARNING: Image '${a.image}' is too small for social media cards. ` +
              `Recommended: at least ${MIN_IMAGE_WIDTH}x${MIN_IMAGE_HEIGHT}px. ` +
              `Actual: ${dims.width}x${dims.height}px. ` +
              `Article: ${a.title}`
          );
        }
        ogImageWidth = dims.width;
        ogImageHeight = dims.height;
      } else {
        console.warn(`WARNING: Could not read dimensions for image '${a.image}'. Article: ${a.title}`);
      }
    }

    let html = articleTpl;
    html = fill(html, 'title', escapeQuotes(a.title));
    html = fill(html, 'logoHref', toPosix(path.relative(outputDir, path.join(siteBuildDir, 'index.html'))));
    html = fill(html, 'ogUrl', absoluteUrl(path.relative(siteBuildDir, filename)));
    html = fill(html, 'lang', a.lang || defaultLang);

    // Optional fields: fill them, or remove the template line that would stay empty.
    if (a.authors) {
      html = fill(html, 'authors', escapeQuotes(a.authors));
    } else {
      html = html.replace(/^[\s]*<p class="article-authors">{{authors}}<\/p>[\s]*$/gm, '');
    }

    if (a.image) {
      html = fill(html, 'image', imageRelativeToOutput);
      html = fill(html, 'ogImage', ogImage);
      html = fill(html, 'ogImageWidth', ogImageWidth);
      html = fill(html, 'ogImageHeight', ogImageHeight);
    } else {
      html = html.replace(/^[\s]*<img[^>]*src="{{image}}"[^>]*>[\s]*$/gm, '');
      html = html.replace(/^[\s]*<meta (property|name)="(og|twitter):image(:\w+)?"[^>]*>[\s]*$/gm, '');
    }

    if (a.explanation) {
      html = fill(html, 'explanation', escapeQuotes(a.explanation));
    } else {
      html = html.replace(/^[\s]*<p class="article-explanation">{{explanation}}<\/p>[\s]*$/gm, '');
      html = html.replace(/^[\s]*<meta (property|name)="(og|twitter):description"[^>]*>[\s]*$/gm, '');
    }

    html = fill(html, 'content', markdownToHtml(a.body, outputDir, articleRelativePath));

    fs.writeFileSync(filename, finishPage(html, filename));

    const articleImagesDir = path.join(articleDir, 'images');
    if (fs.existsSync(articleImagesDir)) {
      copyDir(articleImagesDir, path.join(siteBuildDir, articleRelativePath, 'images'), copyOptions);
    }

    const articlePdfsDir = path.join(articleDir, 'pdfs');
    if (fs.existsSync(articlePdfsDir)) {
      copyDir(articlePdfsDir, path.join(siteBuildDir, articleRelativePath, 'pdfs'), { stripMetadata: false });
    }
  });

  if (stats.imagesStripped > 0) {
    console.log(`Removed metadata (EXIF/GPS/XMP/text) from ${stats.imagesStripped} image(s).`);
  }
  console.log(`Generated ${articles.length} article(s) in ${siteBuildDir}/`);
  return { articles, outputDir: siteBuildDir };
}

if (require.main === module) {
  try {
    generateSite({ rootDir: process.cwd(), siteUrl: process.env.SITE_URL || '' });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  generateSite,
  getImageDimensions,
  markdownToHtml,
  parseMarkdown,
  stripJpegMetadata,
  stripPngMetadata,
};

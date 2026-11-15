// Run with: npm test   (uses Node's built-in test runner, no dependencies)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  generateSite,
  getImageDimensions,
  markdownToHtml,
  stripJpegMetadata,
  stripPngMetadata,
} = require('../generator.js');

// --- fixtures --------------------------------------------------------------

const segment = (marker, payload) => {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xFF00 | marker, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};

// Big-endian EXIF block with an Orientation entry, fake GPS text and an
// embedded thumbnail (which has its own, smaller frame header).
const exifSegment = (orientation, thumbnail = Buffer.alloc(0)) => {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  return segment(0xE1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from('GPS 49.87N 8.65E'), thumbnail]));
};

const sof0 = (width, height) => {
  const p = Buffer.alloc(15);
  p[0] = 8;
  p.writeUInt16BE(height, 1);
  p.writeUInt16BE(width, 3);
  p[5] = 3;
  return segment(0xC0, p);
};

// A structurally valid JPEG: SOI, APP0, [EXIF with embedded thumbnail], SOF0, SOS, data, EOI.
const jpeg = ({ orientation = 1, width = 2048, height = 1536 } = {}) => {
  const thumbnail = Buffer.concat([Buffer.from([0xFF, 0xD8]), sof0(160, 120), Buffer.from([0xFF, 0xD9])]);
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    segment(0xE0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    exifSegment(orientation, thumbnail),
    segment(0xE1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1')),
    segment(0xE2, Buffer.from('ICC_PROFILE\0\x01\x01profile', 'latin1')),
    segment(0xED, Buffer.from('Photoshop 3.0\0IPTC', 'latin1')),
    segment(0xFE, Buffer.from('a comment')),
    sof0(width, height),
    segment(0xDA, Buffer.from([1, 1, 0, 0, 0x3F, 0])),
    Buffer.from([0x12, 0x34, 0xFF, 0x00, 0x56]),
    Buffer.from([0xFF, 0xD9]),
  ]);
};

const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};

const png = () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(300, 0);
  ihdr.writeUInt32BE(200, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from('Author\0secret', 'latin1')),
    pngChunk('eXIf', Buffer.from('MM\0*')),
    pngChunk('IDAT', Buffer.from([1, 2, 3])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const tmpFile = (name, data) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generator-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
};

// --- images ----------------------------------------------------------------

test('JPEG dimensions come from the frame header, not the EXIF thumbnail', () => {
  assert.deepStrictEqual(getImageDimensions(tmpFile('a.jpg', jpeg())), { width: 2048, height: 1536 });
});

test('JPEG dimensions are swapped for rotated photos', () => {
  assert.deepStrictEqual(getImageDimensions(tmpFile('a.jpg', jpeg({ orientation: 6 }))), {
    width: 1536,
    height: 2048,
  });
});

test('PNG dimensions', () => {
  assert.deepStrictEqual(getImageDimensions(tmpFile('a.png', png())), { width: 300, height: 200 });
});

test('stripJpegMetadata removes EXIF/GPS, XMP, IPTC and comments but keeps ICC and image data', () => {
  const input = jpeg();
  const output = stripJpegMetadata(input);
  const text = output.toString('latin1');
  assert.ok(!text.includes('GPS'));
  assert.ok(!text.includes('Exif'));
  assert.ok(!text.includes('ns.adobe.com/xap'));
  assert.ok(!text.includes('IPTC'));
  assert.ok(!text.includes('a comment'));
  assert.ok(text.includes('ICC_PROFILE'));
  assert.ok(text.includes('JFIF'));
  assert.ok(output.subarray(-7).equals(input.subarray(-7)), 'scan data is unchanged');
  assert.deepStrictEqual(getImageDimensions(tmpFile('b.jpg', output)), { width: 2048, height: 1536 });
});

test('stripJpegMetadata keeps only the orientation of rotated photos', () => {
  const output = stripJpegMetadata(jpeg({ orientation: 6 }));
  assert.ok(!output.toString('latin1').includes('GPS'));
  assert.deepStrictEqual(getImageDimensions(tmpFile('c.jpg', output)), { width: 1536, height: 2048 });
});

test('stripJpegMetadata returns unparseable input unchanged', () => {
  const junk = Buffer.from([0xFF, 0xD8, 0x00, 0x01, 0x02]);
  assert.strictEqual(stripJpegMetadata(junk), junk);
});

test('stripPngMetadata removes text and EXIF chunks', () => {
  const output = stripPngMetadata(png());
  const text = output.toString('latin1');
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('eXIf'));
  assert.ok(text.includes('IHDR') && text.includes('IDAT') && text.includes('IEND'));
});

// --- markdown --------------------------------------------------------------

const md = s => markdownToHtml(s, '/site/public/cat', 'cat/article');

test('underscores inside URLs and words are not turned into emphasis', () => {
  const html = md('See https://example.com/getting_access_to_energy/ and snake_case_word.');
  assert.ok(!html.includes('<em>'));
  assert.ok(html.includes('<a href="https://example.com/getting_access_to_energy/">'));
});

test('bare URLs become links without swallowing surrounding punctuation', () => {
  assert.strictEqual(
    md('[1] (https://example.com/a?b=1&c=2), more.'),
    '<p>[1] (<a href="https://example.com/a?b=1&c=2">https://example.com/a?b=1&c=2</a>), more.</p>'
  );
});

test('emphasis and strong with underscores and asterisks', () => {
  assert.strictEqual(
    md('_a_ __b__ *c* **d** x * y * z'),
    '<p><em>a</em> <strong>b</strong> <em>c</em> <strong>d</strong> x * y * z</p>'
  );
});

test('markdown links, pdf links and inline code', () => {
  assert.strictEqual(
    md('[Doc](pdfs/a.pdf) [Site](https://x.org/a_b_c) `a_b <c>`'),
    '<p><a href="article/pdfs/a.pdf">Doc</a> <a href="https://x.org/a_b_c">Site</a> <code>a_b &lt;c&gt;</code></p>'
  );
});

test('dollar signs are inserted literally', () => {
  assert.strictEqual(md("Costs $& and $' and $$"), "<p>Costs $& and $' and $$</p>");
});

test('headings h1-h6, bullet and numbered lists', () => {
  assert.strictEqual(
    md('# A\n#### B\n- x\n- y\n1. one\n2. two\n\ntext'),
    '<h1>A</h1>\n<h4>B</h4>\n<ul>\n<li>x</li>\n<li>y</li>\n</ul>\n<ol>\n<li>one</li>\n<li>two</li>\n</ol>\n<p>text</p>'
  );
});

test('images: local paths are resolved, external URLs are kept', () => {
  assert.strictEqual(
    md('![](images/a.jpg)\n![Caption](https://x.org/b.jpg)'),
    '<p><img src="article/images/a.jpg" alt="" class="article-inline-image"></p>\n' +
      '<p><img src="https://x.org/b.jpg" alt="Caption" class="article-inline-image"></p>\n' +
      '<p class="article-explanation">Caption</p>'
  );
});

// --- whole site ------------------------------------------------------------

const makeSite = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generator-site-'));
  const write = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  };
  write('templates/style.css', 'body{}');
  write('templates/index.html', '<html lang="{{lang}}">{{categories}}{{footer}}</html>');
  write(
    'templates/article.html',
    [
      '<html lang="{{lang}}"><head>',
      '<link rel="stylesheet" href="{{root}}style.css">',
      '<meta property="og:image" content="{{ogImage}}">',
      '<meta property="og:url" content="{{ogUrl}}">',
      '<meta property="og:description" content="{{explanation}}">',
      '</head><body><h1>{{title}}</h1>',
      '<p class="article-explanation">{{explanation}}</p>',
      '{{content}}{{footer}}</body></html>',
    ].join('\n')
  );
  write('templates/footer.html', '<footer><a href="{{root}}legal/impressum.html">Impressum</a></footer>');
  write('content/cat/b-second/b.md', '---\ncategory: Cat\ntitle: Second\n---\nBody $$ text');
  write(
    'content/cat/a-first/a.md',
    '---\r\ncategory: Cat\r\ntitle: First "quoted"\r\nimage: images/p.jpg\r\nexplanation: Ex "1"\r\nlang: de\r\norder: 2\r\n---\r\nHello'
  );
  write('content/cat/a-first/images/p.jpg', jpeg());
  write('content/cat/draft/d.md', '---\ncategory: Cat\ntitle: Draft\ndraft: true\n---\nNot yet');
  write('content/cat/notes/n.md', 'no frontmatter here');
  return root;
};

test('generateSite: absolute OG URLs, footer, {{root}}, lang, drafts, order, stripped images', () => {
  const root = makeSite();
  generateSite({ rootDir: root, siteUrl: 'https://example.com/' });
  const out = rel => fs.readFileSync(path.join(root, 'public', rel), 'utf8');

  const first = out('cat/a-first.html');
  assert.ok(first.includes('<html lang="de">'));
  assert.ok(first.includes('href="../style.css"'));
  assert.ok(first.includes('content="https://example.com/cat/a-first/images/p.jpg"'));
  assert.ok(first.includes('content="https://example.com/cat/a-first.html"'));
  assert.ok(first.includes('<h1>First &quot;quoted&quot;</h1>'));
  assert.ok(first.includes('content="Ex &quot;1&quot;"'));
  assert.ok(first.includes('<a href="../legal/impressum.html">Impressum</a>'));
  assert.ok(!first.includes('{{'));

  assert.ok(out('cat/b-second.html').includes('<html lang="en">'));
  assert.ok(out('cat/b-second.html').includes('Body $$ text'));

  const index = out('index.html');
  assert.ok(index.includes('<a href="legal/impressum.html">Impressum</a>'));
  assert.ok(index.indexOf('a-first.html') < index.indexOf('b-second.html'), 'order: comes first');
  assert.ok(!index.includes('Draft'));
  assert.ok(!fs.existsSync(path.join(root, 'public/cat/draft.html')));

  const image = fs.readFileSync(path.join(root, 'public/cat/a-first/images/p.jpg'), 'latin1');
  assert.ok(!image.includes('GPS'));
});

test('generateSite can keep image metadata when asked to', () => {
  const root = makeSite();
  generateSite({ rootDir: root, siteUrl: 'https://example.com', stripImageMetadata: false });
  const image = fs.readFileSync(path.join(root, 'public/cat/a-first/images/p.jpg'), 'latin1');
  assert.ok(image.includes('GPS'));
});

test('generateSite refuses a build directory that contains the sources', () => {
  const root = makeSite();
  assert.throws(() => generateSite({ rootDir: root, buildDir: root }), /Refusing/);
  assert.ok(fs.existsSync(path.join(root, 'content')));
});

test('generateSite throws instead of exiting when a template is missing', () => {
  const root = makeSite();
  fs.unlinkSync(path.join(root, 'templates/style.css'));
  assert.throws(() => generateSite({ rootDir: root }), /style\.css/);
});

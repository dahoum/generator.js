'use strict';

/**
 * @file Tests for page rendering, options, safety checks, the whole build and the command line.
 */

const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const subject = require('../helpers/subject.js');
const fixtures = require('../helpers/fixtures.js');

const generator = subject.generator;

/**
 * Settings for rendering tests, rooted in `root`.
 *
 * @param {string} root - Site root.
 * @param {Object} changes - Settings to override.
 * @returns {Object} Settings as resolveOptions returns them.
 */
function settingsFor(root, changes) {
  return Object.assign(
    {
      rootDir: root,
      contentDir: path.join(root, 'content'),
      templatesDir: path.join(root, 'templates'),
      buildDir: path.join(root, 'public'),
      siteUrl: 'https://example.com',
      stripImageMetadata: true,
      defaultLang: 'en',
      logger: fixtures.recordingLogger(),
      homeDir: path.join(root, 'home'),
    },
    changes
  );
}

/**
 * An article object for rendering tests.
 *
 * @param {string} root - Site root.
 * @param {Object} changes - Fields to override.
 * @returns {Object} The article.
 */
function articleIn(root, changes) {
  return Object.assign(
    {
      category: 'Cat',
      title: 'T',
      authors: '',
      image: '',
      explanation: '',
      lang: '',
      order: null,
      toc: true,
      body: 'Hello',
      filePath: path.join(root, 'content', 'cat', 'slug', 'slug.md'),
    },
    changes
  );
}

/**
 * Read a file of a built site.
 *
 * @param {string} root - Site root.
 * @param {string} relative - Path inside the build directory.
 * @returns {string} File contents.
 */
function built(root, relative) {
  return fs.readFileSync(path.join(root, 'public', relative), 'utf8');
}

/**
 * Run a function with a different working directory.
 *
 * @param {string} directory - Working directory to use.
 * @param {function(): *} action - Code to run.
 * @returns {*} What the action returns.
 */
function inDirectory(directory, action) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return action();
  } finally {
    process.chdir(previous);
  }
}

/**
 * The build directory may not be the file system root, the home directory or
 * contain a protected directory.
 *
 * @returns {void}
 */
function unsafeBuildDirectories() {
  const protectedDirs = [path.join('/srv', 'site', 'content')];
  assert.throws(
    /**
     * Use the file system root as build directory.
     *
     * @returns {void}
     */
    function rootDirectory() {
      generator.assertSafeBuildDir('/', protectedDirs, '/home/me');
    },
    { message: 'Refusing to use / as build directory.' }
  );
  assert.throws(
    /**
     * Use the home directory as build directory.
     *
     * @returns {void}
     */
    function homeDirectory() {
      generator.assertSafeBuildDir('/home/me/', protectedDirs, '/home/me');
    },
    { message: 'Refusing to use /home/me as build directory.' }
  );
  assert.throws(
    /**
     * Use a protected directory as build directory.
     *
     * @returns {void}
     */
    function sameDirectory() {
      generator.assertSafeBuildDir('/srv/site/content', protectedDirs, '/home/me');
    },
    { message: 'Refusing to use /srv/site/content as build directory: deleting it would delete /srv/site/content.' }
  );
  assert.throws(
    /**
     * Use the parent of a protected directory as build directory.
     *
     * @returns {void}
     */
    function parentDirectory() {
      generator.assertSafeBuildDir('/srv/site', protectedDirs, '/home/me');
    },
    { message: 'Refusing to use /srv/site as build directory: deleting it would delete /srv/site/content.' }
  );
  generator.assertSafeBuildDir('/srv/site/public', protectedDirs, '/home/me');
  generator.assertSafeBuildDir('/srv/site/cont', protectedDirs, '/home/me');
  generator.assertSafeBuildDir('/srv/site/content2', protectedDirs, '/home/me');
  generator.assertSafeBuildDir('/home/me/site', protectedDirs, '/home/me');
}
test('assertSafeBuildDir refuses dangerous build directories', unsafeBuildDirectories);

/**
 * Leftover placeholders are listed once each, in order.
 *
 * @returns {void}
 */
function leftoverPlaceholders() {
  assert.deepStrictEqual(generator.findLeftoverPlaceholders('{{b}} {{ a.b }} {{b}} {{}} {x}'), ['{{b}}', '{{ a.b }}']);
  assert.deepStrictEqual(generator.findLeftoverPlaceholders('none'), []);
}
test('findLeftoverPlaceholders lists unfilled placeholders', leftoverPlaceholders);

/**
 * Each required template is checked by name.
 *
 * @returns {void}
 */
function requiredTemplates() {
  const root = fixtures.makeSite();
  const templates = path.join(root, 'templates');
  generator.checkTemplates(templates);
  for (const name of ['index.html', 'article.html', 'style.css']) {
    const copy = fixtures.tempDir();
    fs.cpSync(templates, copy, { recursive: true });
    fs.unlinkSync(path.join(copy, name));
    assert.throws(
      /**
       * Check a templates folder with one template removed.
       *
       * @returns {void}
       */
      function missingTemplate() {
        generator.checkTemplates(copy);
      },
      { message: "Template '" + name + "' not found in " + copy + '/' }
    );
  }
}
test('checkTemplates names the missing template', requiredTemplates);

/**
 * Defaults are derived from the root directory and the environment.
 *
 * @returns {void}
 */
function optionDefaults() {
  assert.deepStrictEqual(generator.resolveOptions({ rootDir: '/r' }), {
    rootDir: '/r',
    contentDir: path.join('/r', 'content'),
    templatesDir: path.join('/r', 'templates'),
    buildDir: path.join('/r', 'public'),
    siteUrl: '',
    stripImageMetadata: true,
    defaultLang: 'en',
    logger: console,
    homeDir: os.homedir(),
  });
  const fromCwd = generator.resolveOptions(undefined);
  assert.strictEqual(fromCwd.rootDir, process.cwd());
  assert.strictEqual(fromCwd.contentDir, path.join(process.cwd(), 'content'));
}
test('resolveOptions fills in defaults', optionDefaults);

/**
 * Every option can be overridden; trailing slashes are removed from the site URL.
 *
 * @returns {void}
 */
function optionOverrides() {
  const logger = fixtures.recordingLogger();
  assert.deepStrictEqual(
    generator.resolveOptions({
      rootDir: '/r',
      contentDir: '/c',
      templatesDir: '/t',
      buildDir: '/b',
      siteUrl: 'https://example.com//',
      stripImageMetadata: false,
      defaultLang: 'de',
      logger: logger,
      homeDir: '/h',
    }),
    {
      rootDir: '/r',
      contentDir: '/c',
      templatesDir: '/t',
      buildDir: '/b',
      siteUrl: 'https://example.com',
      stripImageMetadata: false,
      defaultLang: 'de',
      logger: logger,
      homeDir: '/h',
    }
  );
  assert.strictEqual(generator.resolveOptions({ siteUrl: 'https://a.b/c' }).siteUrl, 'https://a.b/c');
}
test('resolveOptions applies every option', optionOverrides);

/**
 * Pages get the footer, a working {{root}} at every depth and warnings for leftovers.
 *
 * @returns {void}
 */
function finishingPages() {
  const root = fixtures.tempDir();
  const settings = settingsFor(root, {});
  const footer = '<a href="{{root}}x.html">x</a>';
  assert.strictEqual(generator.finishPage('{{footer}}', path.join(root, 'public', 'index.html'), settings, footer), '<a href="x.html">x</a>');
  assert.strictEqual(generator.finishPage('{{footer}}', path.join(root, 'public', 'a', 'p.html'), settings, footer), '<a href="../x.html">x</a>');
  assert.strictEqual(
    generator.finishPage('{{root}}s.css {{footer}} {{left}} {{over}}', path.join(root, 'public', 'a', 'b', 'p.html'), settings, footer),
    '../../s.css <a href="../../x.html">x</a> {{left}} {{over}}'
  );
  assert.deepStrictEqual(settings.logger.warnings, ['WARNING: Unfilled placeholder(s) {{left}}, {{over}} in ' + path.join('a', 'b', 'p.html')]);
}
test('finishPage inserts the footer, resolves {{root}} and warns about leftovers', finishingPages);

/**
 * The home article fills title, image and up to four paragraphs.
 *
 * @returns {void}
 */
function homeArticleFields() {
  const root = fixtures.tempDir();
  const home = articleIn(root, {
    title: 'Welcome',
    image: 'images/h.jpg',
    body: 'One _a_\n\n  \n\nTwo\n  line\n\n[Doc](pdfs/d.pdf) [Web](https://x.org)\n\nFour\n\nFive',
    filePath: path.join(root, 'content', 'home', 'start', 'start.md'),
  });
  const template = '{{homeTitle}}|{{homeImage}}|{{homeParagraph1}}|{{homeParagraph2}}|{{homeParagraph3}}|{{homeParagraph4}}';
  assert.strictEqual(
    generator.fillHomeArticle(template, home, path.join(root, 'content')),
    'Welcome|home/start/images/h.jpg|One <em>a</em>|Two line|<a href="home/start/pdfs/d.pdf">Doc</a> <a href="https://x.org">Web</a>|Four'
  );
  const short = articleIn(root, { title: 'W', body: 'Only', filePath: path.join(root, 'content', 'home', 'start', 'start.md') });
  assert.strictEqual(generator.fillHomeArticle(template, short, path.join(root, 'content')), 'W||Only|||');
}
test('fillHomeArticle fills the home page fields', homeArticleFields);

/**
 * The index uses the first Home article and the default language.
 *
 * @returns {void}
 */
function indexPage() {
  const root = fixtures.tempDir();
  const settings = settingsFor(root, { defaultLang: 'fr' });
  const templates = { index: '{{lang}}|{{logoHref}}|{{homeTitle}}|{{categories}}|{{footer}}', article: '', footer: 'F{{root}}' };
  const articles = [
    articleIn(root, { title: 'Listed', filePath: path.join(root, 'content', 'cat', 'listed', 'x.md') }),
    articleIn(root, { category: 'Home', title: 'First home', toc: false, filePath: path.join(root, 'content', 'h', 'a', 'x.md') }),
    articleIn(root, { category: 'Home', title: 'Second home', toc: false, filePath: path.join(root, 'content', 'h', 'b', 'x.md') }),
  ];
  assert.strictEqual(
    generator.renderIndex(articles, settings, templates),
    'fr|index.html|First home|<section>\n<h2>Cat</h2>\n<p><a href="cat/listed.html">Listed</a></p>\n</section>\n|F'
  );
}
test('renderIndex renders the home page', indexPage);

/**
 * Social image fields, with warnings for small and unreadable images.
 *
 * @returns {void}
 */
function socialImages() {
  const root = fixtures.tempDir();
  fixtures.writeFiles(root, {
    'content/cat/slug/images/big.jpg': fixtures.cameraJpeg(1),
    'content/cat/slug/images/small.png': Buffer.concat([fixtures.PNG_SIGNATURE, fixtures.pngHeader(1199, 627)]),
    'content/cat/slug/images/short.png': Buffer.concat([fixtures.PNG_SIGNATURE, fixtures.pngHeader(1200, 626)]),
    'content/cat/slug/images/exact.png': Buffer.concat([fixtures.PNG_SIGNATURE, fixtures.pngHeader(1200, 627)]),
  });
  const settings = settingsFor(root, {});
  const location = generator.articleOutput(articleIn(root, {}), settings.contentDir);

  assert.deepStrictEqual(generator.socialImage(articleIn(root, { image: 'images/big.jpg' }), location, settings), {
    url: 'https://example.com/cat/slug/images/big.jpg',
    width: '2048',
    height: '1536',
  });
  assert.deepStrictEqual(generator.socialImage(articleIn(root, { image: 'images/exact.png' }), location, settings), {
    url: 'https://example.com/cat/slug/images/exact.png',
    width: '1200',
    height: '627',
  });
  assert.deepStrictEqual(settings.logger.warnings, []);

  assert.deepStrictEqual(generator.socialImage(articleIn(root, { image: 'images/small.png', title: 'S' }), location, settings), {
    url: 'https://example.com/cat/slug/images/small.png',
    width: '1199',
    height: '627',
  });
  generator.socialImage(articleIn(root, { image: 'images/short.png', title: 'S' }), location, settings);
  assert.deepStrictEqual(generator.socialImage(articleIn(root, { image: 'images/none.jpg', title: 'N' }), location, settings), {
    url: 'https://example.com/cat/slug/images/none.jpg',
    width: '',
    height: '',
  });
  assert.deepStrictEqual(settings.logger.warnings, [
    "WARNING: Image 'images/small.png' is too small for social media cards. Recommended: at least 1200x627px. Actual: 1199x627px. Article: S",
    "WARNING: Image 'images/short.png' is too small for social media cards. Recommended: at least 1200x627px. Actual: 1200x626px. Article: S",
    "WARNING: Could not read dimensions for image 'images/none.jpg'. Article: N",
  ]);
}
test('socialImage returns og:image values and warns about unusable images', socialImages);

/**
 * An article with every optional field.
 *
 * @returns {void}
 */
function fullArticlePage() {
  const root = fixtures.tempDir();
  fixtures.writeFiles(root, { 'content/cat/slug/images/h.jpg': fixtures.cameraJpeg(1) });
  const settings = settingsFor(root, {});
  const templates = { index: '', article: fixtures.ARTICLE_TEMPLATE, footer: '<footer>{{root}}</footer>' };
  const page = generator.renderArticle(
    articleIn(root, { title: 'A "q"', authors: 'Ann "B"', image: 'images/h.jpg', explanation: 'E "x"', lang: 'de', body: '# H' }),
    settings,
    templates
  );
  assert.strictEqual(page.file, path.join(root, 'public', 'cat', 'slug.html'));
  assert.strictEqual(
    page.html,
    [
      '<html lang="de"><head>',
      '<link rel="stylesheet" href="../style.css">',
      '<meta property="og:image" content="https://example.com/cat/slug/images/h.jpg">',
      '<meta property="og:image:width" content="2048">',
      '<meta property="og:image:height" content="1536">',
      '<meta name="twitter:image" content="https://example.com/cat/slug/images/h.jpg">',
      '<meta property="og:url" content="https://example.com/cat/slug.html">',
      '<meta property="og:description" content="E &quot;x&quot;">',
      '<meta name="twitter:description" content="E &quot;x&quot;">',
      '</head><body><a href="../index.html">Home</a><h1>A &quot;q&quot;</h1>',
      '<p class="article-authors">Ann &quot;B&quot;</p>',
      '<img src="slug/images/h.jpg" alt="A &quot;q&quot;" class="article-hero">',
      '<p class="article-explanation">E &quot;x&quot;</p>',
      '<h1>H</h1>',
      '<footer>../</footer></body></html>',
    ].join('\n')
  );
}
test('renderArticle fills every field', fullArticlePage);

/**
 * An article without optional fields loses those lines, including all og:image tags.
 *
 * @returns {void}
 */
function minimalArticlePage() {
  const root = fixtures.tempDir();
  const settings = settingsFor(root, { siteUrl: '', defaultLang: 'it' });
  const templates = { index: '', article: fixtures.ARTICLE_TEMPLATE, footer: '' };
  const page = generator.renderArticle(articleIn(root, {}), settings, templates);
  assert.strictEqual(
    page.html,
    [
      '<html lang="it"><head>',
      '<link rel="stylesheet" href="../style.css">',
      '',
      '',
      '',
      '',
      '<meta property="og:url" content="/cat/slug.html">',
      '',
      '',
      '</head><body><a href="../index.html">Home</a><h1>T</h1>',
      '',
      '<p>Hello</p>',
      '</body></html>',
    ].join('\n')
  );
  assert.deepStrictEqual(settings.logger.warnings, []);
}
test('renderArticle removes lines of empty optional fields', minimalArticlePage);

/**
 * Templates are loaded; the footer is optional.
 *
 * @returns {void}
 */
function loadingTemplates() {
  const root = fixtures.makeSite();
  const templates = generator.loadTemplates(path.join(root, 'templates'));
  assert.strictEqual(templates.index, fixtures.INDEX_TEMPLATE);
  assert.strictEqual(templates.article, fixtures.ARTICLE_TEMPLATE);
  assert.strictEqual(templates.footer, '<footer><a href="{{root}}legal/impressum.html">Impressum</a></footer>');
  fs.unlinkSync(path.join(root, 'templates', 'footer.html'));
  assert.strictEqual(generator.loadTemplates(path.join(root, 'templates')).footer, '');
}
test('loadTemplates reads the templates and an optional footer', loadingTemplates);

/**
 * Drafts are logged, skipped files are warnings; nothing is printed for none.
 *
 * @returns {void}
 */
function reportingCollection() {
  const settings = settingsFor('/site', {});
  generator.reportCollection(
    {
      articles: [],
      drafts: [path.join('/site', 'content', 'a', 'd.md'), path.join('/site', 'content', 'b', 'e.md')],
      skipped: [{ file: path.join('/site', 'content', 'c', 'x.md'), reason: 'why' }],
    },
    settings
  );
  assert.deepStrictEqual(settings.logger.logs, ['Skipped 2 draft(s):', '  - ' + path.join('a', 'd.md'), '  - ' + path.join('b', 'e.md')]);
  assert.deepStrictEqual(settings.logger.warnings, ['WARNING: Skipped 1 file(s):', '  - ' + path.join('c', 'x.md') + ': why']);
  const quiet = settingsFor('/site', {});
  generator.reportCollection({ articles: [], drafts: [], skipped: [] }, quiet);
  assert.deepStrictEqual(quiet.logger.logs, []);
  assert.deepStrictEqual(quiet.logger.warnings, []);
}
test('reportCollection reports drafts and skipped files', reportingCollection);

/**
 * A complete build of the example site, compared with the expected pages.
 *
 * @returns {void}
 */
function completeBuild() {
  const root = fixtures.makeSite();
  const logger = fixtures.recordingLogger();
  const result = generator.generateSite({ rootDir: root, siteUrl: 'https://example.com/', logger: logger });

  const titles = [];
  for (const item of result.articles) {
    titles.push(item.title);
  }
  assert.deepStrictEqual(titles, ['First "quoted"', 'Second', 'Welcome']);
  assert.strictEqual(result.outputDir, path.join(root, 'public'));

  assert.strictEqual(
    built(root, 'index.html'),
    [
      '<html lang="en"><a href="index.html">Home</a>',
      '<h1>Welcome</h1><img src="home/start/images/home.jpg">',
      '<p>First <em>one</em>.</p><p>Second line.</p><p><a href="home/start/pdfs/x.pdf">Doc</a></p><p>Fourth</p>',
      '<section>',
      '<h2>Cat</h2>',
      '<p><a href="cat/a-first.html">First "quoted"</a></p>',
      '<p><a href="cat/b-second.html">Second</a></p>',
      '</section>',
      '',
      '<footer><a href="legal/impressum.html">Impressum</a></footer></html>',
    ].join('\n')
  );
  assert.strictEqual(
    built(root, 'cat/a-first.html'),
    [
      '<html lang="de"><head>',
      '<link rel="stylesheet" href="../style.css">',
      '<meta property="og:image" content="https://example.com/cat/a-first/images/p.jpg">',
      '<meta property="og:image:width" content="1536">',
      '<meta property="og:image:height" content="2048">',
      '<meta name="twitter:image" content="https://example.com/cat/a-first/images/p.jpg">',
      '<meta property="og:url" content="https://example.com/cat/a-first.html">',
      '<meta property="og:description" content="Ex &quot;1&quot;">',
      '<meta name="twitter:description" content="Ex &quot;1&quot;">',
      '</head><body><a href="../index.html">Home</a><h1>First &quot;quoted&quot;</h1>',
      '',
      '<img src="a-first/images/p.jpg" alt="First &quot;quoted&quot;" class="article-hero">',
      '<p class="article-explanation">Ex &quot;1&quot;</p>',
      '<p>Hello</p>',
      '<footer><a href="../legal/impressum.html">Impressum</a></footer></body></html>',
    ].join('\n')
  );
  assert.ok(built(root, 'cat/b-second.html').includes('<p>Body $$ text</p>'));
  assert.ok(built(root, 'cat/b-second.html').includes('<p class="article-authors">Ann</p>'));
  assert.ok(built(root, 'home/start.html').includes('<h1>Welcome</h1>'));
  assert.strictEqual(fs.existsSync(path.join(root, 'public', 'cat', 'draft.html')), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'public', 'cat', 'notes.html')), false);

  // Assets: style, template images (stripped), fonts, article images (stripped, rotation kept), PDFs.
  assert.strictEqual(built(root, 'style.css'), 'body{}');
  assert.strictEqual(built(root, 'fonts/font.woff2'), 'font-bytes');
  assert.strictEqual(
    fs.readFileSync(path.join(root, 'public', 'images', 'logo.jpg')).toString('hex'),
    generator.stripJpegMetadata(fixtures.cameraJpeg(1)).toString('hex')
  );
  assert.strictEqual(fs.readFileSync(path.join(root, 'public', 'images', 'nested', 'icon.png')).toString('hex'), fixtures.cleanPng().toString('hex'));
  assert.strictEqual(
    fs.readFileSync(path.join(root, 'public', 'cat', 'a-first', 'images', 'p.jpg')).toString('hex'),
    generator.stripJpegMetadata(fixtures.cameraJpeg(6)).toString('hex')
  );
  assert.strictEqual(built(root, 'cat/a-first/pdfs/doc.pdf'), 'pdf-bytes');
  assert.strictEqual(
    fs.readFileSync(path.join(root, 'public', 'cat', 'a-first', 'pdfs', 'scan.jpg')).toString('hex'),
    generator.stripJpegMetadata(fixtures.cameraJpeg(1)).toString('hex')
  );
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'public')).sort(), ['cat', 'fonts', 'home', 'images', 'index.html', 'style.css']);

  assert.deepStrictEqual(logger.logs, [
    'Skipped 1 draft(s):',
    '  - ' + path.join('cat', 'draft', 'd.md'),
    'Removed metadata (EXIF/GPS/XMP/text) from 5 image(s).',
    'Generated 3 article(s) in ' + path.join(root, 'public') + '/',
  ]);
  assert.deepStrictEqual(logger.warnings, [
    'WARNING: Skipped 1 file(s):',
    '  - ' + path.join('cat', 'notes', 'n.md') + ': no frontmatter (--- block at the top of the file)',
  ]);
}
test('generateSite builds the complete example site', completeBuild);

/**
 * Building again replaces the previous output; stripping can be switched off;
 * the build directory may be nested; a missing icons directory is fine.
 *
 * @returns {void}
 */
function rebuildAndOptions() {
  const root = fixtures.makeSite();
  const buildDir = path.join(root, 'out', 'site');
  const logger = fixtures.recordingLogger();
  generator.generateSite({ rootDir: root, buildDir: buildDir, siteUrl: 'https://example.com', logger: logger, stripImageMetadata: false });
  fs.writeFileSync(path.join(buildDir, 'stale.html'), 'old');
  generator.generateSite({ rootDir: root, buildDir: buildDir, siteUrl: 'https://example.com', logger: logger, stripImageMetadata: false });
  assert.strictEqual(fs.existsSync(path.join(buildDir, 'stale.html')), false);
  assert.strictEqual(fs.readFileSync(path.join(buildDir, 'images', 'logo.jpg')).toString('hex'), fixtures.cameraJpeg(1).toString('hex'));
  assert.strictEqual(fs.existsSync(path.join(buildDir, 'icons')), false);
  for (const message of logger.logs) {
    assert.strictEqual(message.startsWith('Removed metadata'), false);
  }
}
test('generateSite rebuilds cleanly and honours stripImageMetadata: false', rebuildAndOptions);

/**
 * Without a site URL, social URLs are root-relative and a warning explains why.
 *
 * @returns {void}
 */
function warnsWithoutSiteUrl() {
  const root = fixtures.makeSite();
  const logger = fixtures.recordingLogger();
  generator.generateSite({ rootDir: root, logger: logger });
  assert.ok(logger.warnings.includes(
    'WARNING: siteUrl is not set, so og:image and og:url are relative. Social networks need absolute URLs: pass siteUrl: "https://your-domain".'
  ));
  assert.ok(built(root, 'cat/a-first.html').includes('<meta property="og:url" content="/cat/a-first.html">'));
}
test('generateSite warns when siteUrl is missing', warnsWithoutSiteUrl);

/**
 * A missing content directory is created (also nested) and nothing is built.
 *
 * @returns {void}
 */
function createsContentDirectory() {
  const root = fixtures.makeSite();
  const contentDir = path.join(root, 'new', 'content');
  const logger = fixtures.recordingLogger();
  assert.strictEqual(generator.generateSite({ rootDir: root, contentDir: contentDir, logger: logger }), null);
  assert.strictEqual(fs.statSync(contentDir).isDirectory(), true);
  assert.deepStrictEqual(logger.logs, ['Created ' + contentDir + '/ — add your .md files here.']);
  assert.strictEqual(fs.existsSync(path.join(root, 'public')), false);
}
test('generateSite creates a missing content directory', createsContentDirectory);

/**
 * Without publishable articles nothing is built and nothing is deleted.
 *
 * @returns {void}
 */
function nothingToPublish() {
  const root = fixtures.makeSite();
  fs.rmSync(path.join(root, 'content'), { recursive: true });
  fixtures.writeFiles(root, { 'content/a/b/b.md': 'no frontmatter', 'public/keep.txt': 'keep' });
  const logger = fixtures.recordingLogger();
  assert.strictEqual(generator.generateSite({ rootDir: root, logger: logger }), null);
  assert.deepStrictEqual(logger.logs, ['No publishable .md files found in ' + path.join(root, 'content') + '/']);
  assert.strictEqual(built(root, 'keep.txt'), 'keep');
}
test('generateSite builds nothing when no article can be published', nothingToPublish);

/**
 * A missing template or an unsafe build directory stops the build before anything is deleted.
 *
 * @returns {void}
 */
function refusesToBuild() {
  const root = fixtures.makeSite();
  const logger = fixtures.recordingLogger();
  assert.throws(
    /**
     * Build into the site root.
     *
     * @returns {void}
     */
    function buildIntoRoot() {
      generator.generateSite({ rootDir: root, buildDir: root, logger: logger });
    },
    { message: 'Refusing to use ' + root + ' as build directory: deleting it would delete ' + root + '.' }
  );
  assert.throws(
    /**
     * Build into the (fake) home directory.
     *
     * @returns {void}
     */
    function buildIntoHome() {
      generator.generateSite({ rootDir: root, buildDir: path.join(root, 'home'), homeDir: path.join(root, 'home'), logger: logger });
    },
    { message: 'Refusing to use ' + path.join(root, 'home') + ' as build directory.' }
  );
  assert.throws(
    /**
     * Build into the templates directory.
     *
     * @returns {void}
     */
    function buildIntoTemplates() {
      generator.generateSite({ rootDir: root, buildDir: path.join(root, 'templates'), logger: logger });
    },
    { message: 'Refusing to use ' + path.join(root, 'templates') + ' as build directory: deleting it would delete ' + path.join(root, 'templates') + '.' }
  );
  assert.throws(
    /**
     * Build into the content directory.
     *
     * @returns {void}
     */
    function buildIntoContent() {
      generator.generateSite({ rootDir: root, buildDir: path.join(root, 'content'), logger: logger });
    },
    { message: 'Refusing to use ' + path.join(root, 'content') + ' as build directory: deleting it would delete ' + path.join(root, 'content') + '.' }
  );
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  assert.throws(
    /**
     * Build into the working directory.
     *
     * @returns {void}
     */
    function buildIntoWorkingDirectory() {
      inDirectory(work,
        /**
         * Build the site.
         *
         * @returns {*} What generateSite returns.
         */
        function build() {
          return generator.generateSite({ rootDir: root, buildDir: work, logger: logger });
        }
      );
    },
    { message: 'Refusing to use ' + fs.realpathSync(work) + ' as build directory: deleting it would delete ' + fs.realpathSync(work) + '.' }
  );
  assert.strictEqual(fs.existsSync(path.join(root, 'content', 'cat', 'a-first', 'a.md')), true);
  fs.unlinkSync(path.join(root, 'templates', 'style.css'));
  assert.throws(
    /**
     * Build without style.css.
     *
     * @returns {void}
     */
    function buildWithoutStyle() {
      generator.generateSite({ rootDir: root, logger: logger });
    },
    { message: "Template 'style.css' not found in " + path.join(root, 'templates') + '/' }
  );
}
test('generateSite refuses unsafe build directories and missing templates', refusesToBuild);

/**
 * Called without options, the site in the working directory is built and messages go to the console.
 *
 * @returns {void}
 */
function defaultsToWorkingDirectory() {
  const root = fixtures.makeSite();
  const original = { log: console.log, warn: console.warn };
  const printed = [];

  /**
   * Record a console message instead of printing it.
   *
   * @param {string} message - The message.
   * @returns {void}
   */
  function record(message) {
    printed.push(message);
  }

  console.log = record;
  console.warn = record;
  try {
    inDirectory(root,
      /**
       * Build the site.
       *
       * @returns {*} What generateSite returns.
       */
      function build() {
        return generator.generateSite();
      }
    );
  } finally {
    console.log = original.log;
    console.warn = original.warn;
  }
  assert.ok(built(root, 'index.html').includes('<h1>Welcome</h1>'));
  assert.ok(printed.includes('Generated 3 article(s) in ' + path.join(fs.realpathSync(root), 'public') + '/'));
}
test('generateSite without options builds the working directory', defaultsToWorkingDirectory);

/**
 * runCli builds the working directory with SITE_URL and returns 0, or reports errors and returns 1.
 *
 * @returns {void}
 */
function commandLineFunction() {
  const root = fixtures.makeSite();
  const logger = fixtures.recordingLogger();
  const code = inDirectory(root,
    /**
     * Run the command line function.
     *
     * @returns {number} The exit code.
     */
    function run() {
      return generator.runCli({ SITE_URL: 'https://cli.example' }, logger);
    }
  );
  assert.strictEqual(code, 0);
  assert.ok(built(root, 'cat/a-first.html').includes('content="https://cli.example/cat/a-first.html"'));

  const withoutUrl = fixtures.makeSite();
  const quietLogger = fixtures.recordingLogger();
  inDirectory(withoutUrl,
    /**
     * Run the command line function.
     *
     * @returns {number} The exit code.
     */
    function run() {
      return generator.runCli({}, quietLogger);
    }
  );
  assert.ok(built(withoutUrl, 'cat/a-first.html').includes('content="/cat/a-first.html"'));

  const empty = fixtures.tempDir();
  const errorLogger = fixtures.recordingLogger();
  const failed = inDirectory(empty,
    /**
     * Run the command line function.
     *
     * @returns {number} The exit code.
     */
    function run() {
      return generator.runCli({}, errorLogger);
    }
  );
  assert.strictEqual(failed, 1);
  assert.deepStrictEqual(errorLogger.errors, ["Error: Template 'index.html' not found in " + path.join(fs.realpathSync(empty), 'templates') + '/']);
}
test('runCli returns an exit code and passes SITE_URL', commandLineFunction);

/**
 * Running the file with node builds the site and sets the exit code.
 *
 * @returns {void}
 */
function commandLineProcess() {
  const root = fixtures.makeSite();
  const success = childProcess.spawnSync(process.execPath, [subject.subjectPath()], {
    cwd: root,
    env: Object.assign({}, process.env, { SITE_URL: 'https://spawn.example' }),
    encoding: 'utf8',
  });
  assert.strictEqual(success.status, 0);
  assert.ok(built(root, 'cat/a-first.html').includes('content="https://spawn.example/cat/a-first.html"'));

  const failure = childProcess.spawnSync(process.execPath, [subject.subjectPath()], { cwd: fixtures.tempDir(), encoding: 'utf8' });
  assert.strictEqual(failure.status, 1);
  assert.ok(failure.stderr.startsWith("Error: Template 'index.html' not found"));
}
test('node generator.js builds the site in the working directory', commandLineProcess);

/**
 * Requiring the module does not build anything.
 *
 * @returns {void}
 */
function requiringHasNoSideEffects() {
  const empty = fixtures.tempDir();
  const result = childProcess.spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(subject.subjectPath()) + ')'], {
    cwd: empty,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stderr, '');
  assert.deepStrictEqual(fs.readdirSync(empty), []);
}
test('requiring generator.js has no side effects', requiringHasNoSideEffects);

'use strict';

/**
 * @file Tests for multilingual sites (the `languages` option).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const generator = require('../helpers/subject.js').generator;
const fixtures = require('../helpers/fixtures.js');

/**
 * German at the top level, English under /english/.
 * @type {Array<{code: string, path: string}>}
 */
const LANGUAGES = [
  { code: 'de', path: '' },
  { code: 'en', path: 'english' },
];

/**
 * Article template with every multilingual placeholder.
 * @type {string}
 */
const ARTICLE_TEMPLATE = [
  '<html lang="{{lang}}"><head><title>{{title}}</title>',
  '{{alternateLinks}}',
  '<link rel="stylesheet" href="{{root}}style.css"></head>',
  '<body>{{languageSwitch}}<a href="{{logoHref}}">Ij</a>',
  '<img src="{{image}}" alt="{{title}}">',
  '{{content}}',
  '{{footer}}</body></html>',
].join('\n');

/**
 * Index template with every multilingual placeholder.
 * @type {string}
 */
const INDEX_TEMPLATE = [
  '<html lang="{{lang}}"><head>{{alternateLinks}}{{languageRedirect}}</head>',
  '<body>{{languageSwitch}}<a href="{{logoHref}}">Ij</a><h1>{{text.hero}}</h1>',
  '<h2>{{homeTitle}}</h2><img src="{{homeImage}}"><p>{{homeParagraph1}}</p><p>{{homeParagraph2}}</p><p>{{homeParagraph3}}</p><p>{{homeParagraph4}}</p>',
  '{{categories}}',
  '{{footer}}</body></html>',
].join('\n');

/**
 * Create an example bilingual site in a temporary directory.
 *
 * @returns {string} The site's root directory.
 */
function makeBilingualSite() {
  const root = fixtures.tempDir();
  fixtures.writeFiles(root, {
    'templates/style.css': 'body{}',
    'templates/index.html': INDEX_TEMPLATE,
    'templates/article.html': ARTICLE_TEMPLATE,
    'templates/footer.html': '<footer>{{text.imprint}} <a href="{{link:legal/privacy}}">{{text.privacy}}</a></footer>',
    'templates/texts/de.json': JSON.stringify({ hero: 'Willkommen', imprint: 'Impressum', privacy: 'Datenschutz', notFound: 'Seite nicht gefunden', languageName: 'Deutsch' }),
    'templates/texts/en.json': JSON.stringify({ hero: 'Welcome', imprint: 'Imprint', privacy: 'Privacy', notFound: 'Page not found', languageName: 'English' }),
    'content/energy/de-energie.md': '---\ntitle: Energie\n---\n',
    'content/energy/en-energy.md': '---\ntitle: Energy\norder: 2\n---\nArticles about *energy*\n  in industry.\n\n  \n\nSee [the grid](energy/the-grid.html).\n',
    'content/energy/grid/de-das-netz.md': '---\ntitle: Das Netz\nimage: images/p.jpg\n---\nSiehe [PDF](pdfs/a.pdf).',
    'content/energy/grid/en-the-grid.md': '---\ntitle: The Grid\nimage: images/p.jpg\n---\nSee [PDF](pdfs/a.pdf).',
    'content/energy/grid/images/p.jpg': fixtures.cameraJpeg(1),
    'content/energy/grid/pdfs/a.pdf': 'pdf',
    'content/energy/grid/notes.md': 'not published',
    'content/energy/only-english/en-solo.md': '---\ntitle: Solo\n---\nOnly in English.',
    'content/energy/draft/de-entwurf.md': '---\ntitle: Entwurf\ndraft: true\n---\n',
    'content/legal/de-recht.md': '---\ntitle: Recht\norder: 1\n---\n',
    'content/legal/en-legal.md': '---\ntitle: Legal\n---',
    'content/legal/privacy/de-datenschutz.md': '---\ntitle: Datenschutz\ntoc: false\n---\nDE',
    'content/legal/privacy/en-privacy.md': '---\ntitle: Privacy\ntoc: false\n---\nEN',
    'content/home/start/de-start.md': '---\ntitle: Start\nhome: true\nimage: images/h.jpg\n---\nHallo.',
    'content/home/start/en-start.md': '---\ntitle: Home\nhome: true\n---\nHello.',
    'content/home/start/images/h.jpg': fixtures.cameraJpeg(1),
    'content/README.md': 'ignored, not in a section folder',
  });
  return root;
}

/**
 * Introduction of the English section "Energy" in the bilingual test site.
 *
 * @type {string}
 */
const ENERGY_TEXT =
  '<p class="section-text">Articles about <em>energy</em> in industry.</p>\n' +
  '<p class="section-text">See <a href="energy/the-grid.html">the grid</a>.</p>';

/**
 * Read a built file.
 *
 * @param {string} root - Site root.
 * @param {string} relative - Path inside the build directory.
 * @returns {string} Contents.
 */
function built(root, relative) {
  return fs.readFileSync(path.join(root, 'public', relative), 'utf8');
}

/**
 * Settings for a bilingual site.
 *
 * @param {string} root - Site root.
 * @returns {Object} Settings as resolveOptions returns them.
 */
function settingsFor(root) {
  return generator.resolveOptions({
    rootDir: root,
    siteUrl: 'https://example.com',
    logger: fixtures.recordingLogger(),
    languages: LANGUAGES,
  });
}

/**
 * Run a generated `<script>` element with a fake browser.
 *
 * @param {string} script - The `<script>` element.
 * @param {Object} browser - `referrer`, `languages`, `language` and `pathname` of the fake browser.
 * @returns {Array<string>} Addresses passed to location.replace.
 */
function runScript(script, browser) {
  const replaced = [];

  /**
   * Record a redirect.
   *
   * @param {string} url - Target.
   * @returns {void}
   */
  function replace(url) {
    replaced.push(url);
  }

  const code = script.replace('<script>', '').replace('</script>', '');
  vm.runInNewContext(code, {
    location: { protocol: 'https:', host: 'example.com', pathname: browser.pathname, replace: replace },
    document: { referrer: browser.referrer },
    navigator: { languages: browser.languages, language: browser.language },
  });
  return replaced;
}

/**
 * Valid language lists pass; invalid ones are rejected with a clear message.
 *
 * @returns {void}
 */
function checkingLanguages() {
  generator.checkLanguages(LANGUAGES);
  generator.checkLanguages([{ code: 'deu', path: '' }, { code: 'en', path: 'en-2' }, { code: 'fr', path: '0fr' }]);
  const cases = [
    ['de', 'languages needs at least two entries.'],
    [[{ code: 'de', path: '' }], 'languages needs at least two entries.'],
    [[{ code: 'd', path: '' }, { code: 'en', path: 'en' }], 'Invalid or repeated language code: d'],
    [[{ code: 'deut', path: '' }, { code: 'en', path: 'en' }], 'Invalid or repeated language code: deut'],
    [[{ code: 'DE', path: '' }, { code: 'en', path: 'en' }], 'Invalid or repeated language code: DE'],
    [[{ code: 'de', path: '' }, { code: 'de', path: 'de' }], 'Invalid or repeated language code: de'],
    [[{ code: 'de', path: 'de' }, { code: 'en', path: 'en' }], 'The first language is published at the top level; its path must be empty.'],
    [[{ code: 'de', path: '' }, { code: 'en', path: '' }], 'Invalid path for language en: '],
    [[{ code: 'de', path: '' }, { code: 'en', path: 'En' }], 'Invalid path for language en: En'],
    [[{ code: 'de', path: '' }, { code: 'en', path: '-en' }], 'Invalid path for language en: -en'],
    [[{ code: 'de', path: '' }, { code: 'en', path: 'e/n' }], 'Invalid path for language en: e/n'],
  ];
  for (const entry of cases) {
    assert.throws(
      /**
       * Check one invalid list.
       *
       * @returns {void}
       */
      function invalid() {
        generator.checkLanguages(entry[0]);
      },
      { message: entry[1] }
    );
  }
  assert.throws(
    /**
     * Pass an invalid list through the options.
     *
     * @returns {void}
     */
    function throughOptions() {
      generator.resolveOptions({ languages: [] });
    },
    { message: 'languages needs at least two entries.' }
  );
}
test('checkLanguages accepts valid and rejects invalid language lists', checkingLanguages);

/**
 * File names give language and address part.
 *
 * @returns {void}
 */
function languageFileNames() {
  assert.deepStrictEqual(generator.parseLanguageFileName('de-das-netz.md', ['de', 'en']), { lang: 'de', slug: 'das-netz' });
  assert.deepStrictEqual(generator.parseLanguageFileName('deu-x1.md', ['deu']), { lang: 'deu', slug: 'x1' });
  assert.deepStrictEqual(generator.parseLanguageFileName('en-2.md', ['en']), { lang: 'en', slug: '2' });
  for (const name of ['fr-x.md', 'de-Das.md', 'de-.md', 'de--x.md', 'de-x.txt', 'dex.md', 'notes.md', 'xde-x.md', 'de-x.md.bak', 'de-ä.md']) {
    assert.strictEqual(generator.parseLanguageFileName(name, ['de', 'en']), null, name);
  }
}
test('parseLanguageFileName reads <lang>-<slug>.md', languageFileNames);

/**
 * Translation files: all fields, defaults, drafts and errors.
 *
 * @returns {void}
 */
function translationSources() {
  const full = generator.parseTranslationSource(
    '﻿---\r\ntitle: T\r\nauthors: A\r\nimage: i.jpg\r\nexplanation: E\r\norder: 2\r\ntoc: false\r\nhome: true\r\n---\r\n  Body  ',
    '/c/x.md',
    'de'
  );
  assert.deepStrictEqual(full, {
    article: {
      category: '',
      title: 'T',
      authors: 'A',
      image: 'i.jpg',
      explanation: 'E',
      lang: 'de',
      order: 2,
      toc: false,
      home: true,
      body: 'Body',
      filePath: '/c/x.md',
    },
    draft: false,
    skipReason: '',
  });
  const minimal = generator.parseTranslationSource('---\ntitle: T\nhome: yes\ntoc: no\n---', 'f.md', 'en').article;
  assert.deepStrictEqual([minimal.authors, minimal.image, minimal.explanation, minimal.order, minimal.toc, minimal.home, minimal.body], ['', '', '', null, true, false, '']);
  assert.deepStrictEqual(generator.parseTranslationSource('plain', 'f.md', 'de'), {
    article: null,
    draft: false,
    skipReason: 'no frontmatter (--- block at the top of the file)',
  });
  assert.deepStrictEqual(generator.parseTranslationSource('---\ntitle: T\ndraft: true\n---\n', 'f.md', 'de'), {
    article: null,
    draft: true,
    skipReason: 'draft',
  });
  assert.strictEqual(generator.parseTranslationSource('---\ntitle: T\ndraft: no\n---\n', 'f.md', 'de').draft, false);
  assert.deepStrictEqual(generator.parseTranslationSource('---\nauthors: A\n---\n', 'f.md', 'de'), {
    article: null,
    draft: false,
    skipReason: 'missing title in frontmatter',
  });
}
test('parseTranslationSource reads a translation file', translationSources);

/**
 * Sorting by the smallest order, then by folder name.
 *
 * @returns {void}
 */
function sortingFolders() {
  assert.strictEqual(generator.smallestOrder([]), Infinity);
  assert.strictEqual(generator.smallestOrder([{ order: null }, { order: 3 }, { order: 1 }, { order: 2 }]), 1);
  assert.strictEqual(generator.smallestOrder([{ order: 0 }, { order: null }]), 0);
  const a = { folder: 'a', entries: [{ order: null }] };
  const b = { folder: 'b', entries: [{ order: null }] };
  const first = { folder: 'z', entries: [{ order: 1 }] };
  const second = { folder: 'y', entries: [{ order: 5 }] };
  assert.strictEqual(generator.compareFolders(first, second), -4);
  assert.strictEqual(generator.compareFolders(second, first), 4);
  assert.strictEqual(generator.compareFolders(second, a), -Infinity);
  assert.strictEqual(generator.compareFolders(a, b), -1);
  assert.strictEqual(generator.compareFolders(b, a), 1);
  assert.strictEqual(generator.compareFolders(a, { folder: 'a', entries: [] }), 0);

  const sectionA = { folder: 'a', names: new Map([['de', { slug: 's', title: 'S', order: 2 }]]), groups: [] };
  const sectionB = { folder: 'b', names: new Map([['de', { slug: 's', title: 'S', order: 1 }]]), groups: [] };
  assert.deepStrictEqual(generator.sectionSortKey(sectionA), { folder: 'a', entries: [{ slug: 's', title: 'S', order: 2 }] });
  assert.strictEqual(generator.compareSections(sectionA, sectionB), 1);
  const groupA = { id: 'x/a', folder: 'a', sourceDir: '', translations: new Map([['de', { order: 3 }]]) };
  const groupB = { id: 'x/b', folder: 'b', sourceDir: '', translations: new Map([['de', { order: 4 }]]) };
  assert.deepStrictEqual(generator.groupSortKey(groupA), { folder: 'a', entries: [{ order: 3 }] });
  assert.strictEqual(generator.compareGroups(groupA, groupB), -1);
}
test('compareFolders sorts by order, then by folder', sortingFolders);

/**
 * Collecting finds sections, articles, drafts and files that cannot be published.
 *
 * @returns {void}
 */
function collecting() {
  const root = makeBilingualSite();
  fixtures.writeFiles(root, {
    'content/legal/notes.md': 'no language',
    'content/legal/fr-droit.md': '---\ntitle: Droit\n---\n',
    'content/legal/de-ohne.md': '---\norder: 1\n---\n',
    'content/legal/readme.txt': 'not markdown',
    'content/legal/empty/en-broken.md': 'no frontmatter',
  });
  const collection = generator.collectMultilingual(path.join(root, 'content'), ['de', 'en']);
  const summary = [];
  for (const section of collection.sections) {
    const names = [];
    for (const entry of section.names) {
      names.push(entry[0] + ':' + entry[1].slug + ':' + entry[1].title + ':' + String(entry[1].order) + ':' + entry[1].text.length);
    }
    const groups = [];
    for (const group of section.groups) {
      const translations = [];
      for (const entry of group.translations) {
        translations.push(entry[0] + ':' + entry[1].slug);
      }
      groups.push(group.id + '=' + translations.join(','));
    }
    summary.push(section.folder + ' [' + names.join(' ') + '] ' + groups.join(' '));
  }
  assert.deepStrictEqual(summary, [
    'legal [de:recht:Recht:1:0 en:legal:Legal:null:0] ' + path.join('legal', 'privacy') + '=de:datenschutz,en:privacy',
    'energy [de:energie:Energie:null:0 en:energy:Energy:2:' + ENERGY_TEXT.length + '] ' +
      path.join('energy', 'grid') + '=de:das-netz,en:the-grid ' + path.join('energy', 'only-english') + '=en:solo',
    'home [] ' + path.join('home', 'start') + '=de:start,en:start',
  ]);
  const content = path.join(root, 'content');
  assert.strictEqual(collection.sections[1].groups[0].sourceDir, path.join(content, 'energy', 'grid'));
  assert.strictEqual(collection.sections[1].groups[0].folder, 'grid');
  assert.deepStrictEqual(collection.drafts, [path.join(content, 'energy', 'draft', 'de-entwurf.md')]);
  assert.deepStrictEqual(collection.skipped, [
    { file: path.join(content, 'energy', 'grid', 'notes.md'), reason: 'file name does not start with a language code (de-, en-)' },
    { file: path.join(content, 'legal', 'de-ohne.md'), reason: 'missing title in frontmatter' },
    { file: path.join(content, 'legal', 'empty', 'en-broken.md'), reason: 'no frontmatter (--- block at the top of the file)' },
    { file: path.join(content, 'legal', 'fr-droit.md'), reason: 'file name does not start with a language code (de-, en-)' },
    { file: path.join(content, 'legal', 'notes.md'), reason: 'file name does not start with a language code (de-, en-)' },
  ]);
}
test('collectMultilingual reads sections, translations, drafts and problems', collecting);

/**
 * The introduction of a section is the Markdown below its frontmatter.
 *
 * @returns {void}
 */
function sectionIntroduction() {
  assert.strictEqual(generator.sectionText('---\ntitle: A\n---\n'), '');
  assert.strictEqual(generator.sectionText('---\ntitle: A\n---'), '');
  assert.strictEqual(generator.sectionText('title: A\nText'), '');
  assert.strictEqual(generator.sectionText('---\ntitle: A\n---\n\n  \n'), '');
  assert.strictEqual(
    generator.sectionText('---\ntitle: A\norder: 1\n---\n\nOne\ntwo.\n---\nThree [x](y.html).\n\nFour.'),
    '<p class="section-text">One two. --- Three <a href="y.html">x</a>.</p>\n<p class="section-text">Four.</p>'
  );
}
test('sectionText turns the text below the frontmatter into paragraphs', sectionIntroduction);

/**
 * Language folders in the build directory.
 *
 * @returns {void}
 */
function languageFolders() {
  const settings = settingsFor('/site');
  assert.strictEqual(generator.languageDir(settings, 'de'), path.join('/site', 'public'));
  assert.strictEqual(generator.languageDir(settings, 'en'), path.join('/site', 'public', 'english'));
  assert.throws(
    /**
     * Ask for a language that is not configured.
     *
     * @returns {void}
     */
    function unknown() {
      generator.languageDir(settings, 'fr');
    },
    { message: 'Unknown language fr' }
  );
}
test('languageDir maps languages to build folders', languageFolders);

/**
 * The plan lists pages, page files, home articles and translations without a section name.
 *
 * @returns {void}
 */
function planning() {
  const root = makeBilingualSite();
  fixtures.writeFiles(root, {
    'content/home/zweite/de-zweite.md': '---\ntitle: Zweite\nhome: true\n---\n',
    'content/legal/imprint/fr-x.md': 'ignored',
    'content/other/page/de-seite.md': '---\ntitle: Seite\n---\n',
  });
  const settings = settingsFor(root);
  const plan = generator.planMultilingual(generator.collectMultilingual(settings.contentDir, ['de', 'en']), settings);
  const pages = [];
  for (const page of plan.pages) {
    pages.push(page.group.id + ' ' + page.article.lang + ' ' + path.relative(settings.buildDir, page.file));
  }
  assert.deepStrictEqual(pages, [
    path.join('legal', 'privacy') + ' de ' + path.join('recht', 'datenschutz.html'),
    path.join('legal', 'privacy') + ' en ' + path.join('english', 'legal', 'privacy.html'),
    path.join('energy', 'grid') + ' de ' + path.join('energie', 'das-netz.html'),
    path.join('energy', 'grid') + ' en ' + path.join('english', 'energy', 'the-grid.html'),
    path.join('energy', 'only-english') + ' en ' + path.join('english', 'energy', 'solo.html'),
  ]);
  assert.deepStrictEqual(Array.from(plan.files.get(path.join('energy', 'only-english')).keys()), ['en']);
  assert.deepStrictEqual(Array.from(plan.files.get(path.join('home', 'start')).keys()), []);
  assert.strictEqual(plan.homes.get('de').article.title, 'Start');
  assert.strictEqual(plan.homes.get('de').group.id, path.join('home', 'start'));
  assert.strictEqual(plan.homes.get('en').article.title, 'Home');
  assert.deepStrictEqual(plan.skipped, [
    {
      file: path.join(root, 'content', 'other', 'page', 'de-seite.md'),
      reason: 'the section folder other has no de-*.md file with the section name',
    },
  ]);
}
test('planMultilingual decides where every page goes', planning);

/**
 * Texts come from templates/texts/<code>.json and fill {{text.key}}.
 *
 * @returns {void}
 */
function texts() {
  const root = makeBilingualSite();
  const templates = path.join(root, 'templates');
  assert.deepStrictEqual(generator.loadTexts(templates, 'en').hero, 'Welcome');
  assert.deepStrictEqual(generator.loadTexts(templates, 'fr'), {});
  fs.writeFileSync(path.join(templates, 'texts', 'it.json'), '{ broken');
  assert.throws(
    /**
     * Load a broken texts file.
     *
     * @returns {void}
     */
    function broken() {
      generator.loadTexts(templates, 'it');
    },
    SyntaxError
  );
  assert.strictEqual(generator.fillTexts('{{text.a}} {{text.b}} {{text.a}} {{text.c}}', { a: 'A', b: "$&" }), "A $& A {{text.c}}");
}
test('loadTexts and fillTexts handle per-language texts', texts);

/**
 * {{link:...}} points to the article in the page's language.
 *
 * @returns {void}
 */
function links() {
  const files = new Map([[path.join('legal', 'privacy'), new Map([['de', '/b/recht/datenschutz.html'], ['en', '/b/english/legal/privacy.html']])]]);
  assert.strictEqual(
    generator.fillLinks('<a href="{{link:legal/privacy}}"> {{link:legal/privacy}}', '/b/english/energy/x.html', 'en', files),
    '<a href="../legal/privacy.html"> ../legal/privacy.html'
  );
  assert.strictEqual(generator.fillLinks('{{link:legal/privacy}}', '/b/index.html', 'de', files), 'recht/datenschutz.html');
  assert.strictEqual(generator.fillLinks('{{link:legal/privacy}}', '/b/index.html', 'fr', files), '{{link:legal/privacy}}');
  assert.strictEqual(generator.fillLinks('{{link:legal/nothing}}', '/b/index.html', 'de', files), '{{link:legal/nothing}}');
}
test('fillLinks links articles in the page language', links);

/**
 * The switch lists translations in configured order, the current one without a link.
 *
 * @returns {void}
 */
function switches() {
  const three = [{ code: 'de', path: '' }, { code: 'fr', path: 'fr' }, { code: 'en', path: 'en' }];
  const translations = new Map([['en', '/b/en/a.html'], ['de', '/b/a.html']]);
  const names = new Map([['de', { languageName: 'Deutsch' }], ['fr', {}], ['en', {}]]);
  assert.strictEqual(
    generator.languageSwitch('/b/a.html', 'de', translations, three, names),
    '<nav class="language-switch"><span aria-current="page">Deutsch</span><a href="en/a.html" hreflang="en" lang="en">EN</a></nav>'
  );
  assert.strictEqual(
    generator.languageSwitch('/b/en/a.html', 'en', translations, three, names),
    '<nav class="language-switch"><a href="../a.html" hreflang="de" lang="de">Deutsch</a><span aria-current="page">EN</span></nav>'
  );
  assert.strictEqual(generator.languageSwitch('/b/a.html', 'de', new Map([['de', '/b/a.html']]), three, names), '');
  assert.strictEqual(generator.languageLabel('de', names), 'Deutsch');
  assert.strictEqual(generator.languageLabel('en', names), 'EN');
}
test('languageSwitch links the other translations', switches);

/**
 * hreflang tags for translations, with x-default only when given.
 *
 * @returns {void}
 */
function alternates() {
  const settings = settingsFor('/site');
  const translations = new Map([['en', path.join('/site', 'public', 'english', 'a.html')], ['de', path.join('/site', 'public', 'a.html')]]);
  assert.strictEqual(
    generator.alternateLinks(translations, '', settings),
    '<link rel="alternate" hreflang="de" href="https://example.com/a.html">\n<link rel="alternate" hreflang="en" href="https://example.com/english/a.html">'
  );
  assert.strictEqual(
    generator.alternateLinks(translations, path.join('/site', 'public', 'index.html'), settings),
    '<link rel="alternate" hreflang="de" href="https://example.com/a.html">\n<link rel="alternate" hreflang="en" href="https://example.com/english/a.html">\n' +
      '<link rel="alternate" hreflang="x-default" href="https://example.com/index.html">'
  );
  assert.strictEqual(generator.alternateLinks(new Map([['de', '/site/public/a.html']]), '/site/public/index.html', settings), '');
  const three = generator.resolveOptions({
    rootDir: '/site',
    siteUrl: 'https://example.com',
    languages: [{ code: 'de', path: '' }, { code: 'fr', path: 'fr' }, { code: 'en', path: 'english' }],
  });
  assert.strictEqual(
    generator.alternateLinks(translations, '', three),
    '<link rel="alternate" hreflang="de" href="https://example.com/a.html">\n<link rel="alternate" hreflang="en" href="https://example.com/english/a.html">'
  );
}
test('alternateLinks lists translations for search engines', alternates);

/**
 * The redirect script keeps visitors on the site's language, sends others to theirs.
 *
 * @returns {void}
 */
function redirectScript() {
  const script = generator.languageRedirectScript(LANGUAGES);
  assert.ok(script.startsWith('<script>\n(function () {\n  var targets = {"de":"","en":"english/index.html"};'));
  assert.ok(script.endsWith('})();\n</script>'));
  const cases = [
    [{ referrer: '', languages: ['de-DE', 'en'] }, []],
    [{ referrer: '', languages: ['en-US'] }, ['english/index.html']],
    [{ referrer: '', languages: ['EN-gb'] }, ['english/index.html']],
    [{ referrer: '', languages: ['fr', 'de'] }, []],
    [{ referrer: '', languages: ['fr', 'it'] }, ['english/index.html']],
    [{ referrer: '', languages: undefined, language: 'de-AT' }, []],
    [{ referrer: '', languages: [], language: 'en' }, ['english/index.html']],
    [{ referrer: 'https://example.com/english/index.html', languages: ['en'] }, []],
    [{ referrer: 'https://other.org/', languages: ['en'] }, ['english/index.html']],
    [{ referrer: 'https://example.com.evil.org/', languages: ['en'] }, ['english/index.html']],
  ];
  for (const entry of cases) {
    assert.deepStrictEqual(runScript(script, entry[0]), entry[1], JSON.stringify(entry[0]));
  }
  const three = generator.languageRedirectScript([{ code: 'de', path: '' }, { code: 'fr', path: 'francais' }, { code: 'en', path: 'english' }]);
  assert.deepStrictEqual(runScript(three, { referrer: '', languages: ['fr-CH'] }), ['francais/index.html']);
  assert.deepStrictEqual(runScript(three, { referrer: '', languages: ['es'] }), ['francais/index.html']);
}
test('languageRedirectScript chooses the visitor language on the first visit', redirectScript);

/**
 * The 404 page forwards to the home page of the address's language.
 *
 * @returns {void}
 */
function notFound() {
  const texts = new Map([['de', { notFound: 'Nicht gefunden', languageName: 'Deutsch' }], ['en', {}]]);
  const page = generator.notFoundPage(LANGUAGES, texts);
  assert.strictEqual(
    page,
    [
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
      '  if (location.pathname.indexOf("/english/") === 0) {',
      '    target = "/english/";',
      '  }',
      '  location.replace(target);',
      '})();',
      '</script>',
      '</head>',
      '<body>',
      '<p>Nicht gefunden / Page not found</p>',
      '<p><a href="/" hreflang="de">Deutsch</a> · <a href="/english/" hreflang="en">EN</a></p>',
      '</body>',
      '</html>',
      '',
    ].join('\n')
  );
  const script = page.slice(page.indexOf('<script>'), page.indexOf('</script>') + 9);
  assert.deepStrictEqual(runScript(script, { pathname: '/english/x/y.html' }), ['/english/']);
  assert.deepStrictEqual(runScript(script, { pathname: '/energie/x.html' }), ['/']);
  assert.deepStrictEqual(runScript(script, { pathname: '/englishman.html' }), ['/']);

  const three = generator.notFoundPage(
    [{ code: 'de', path: '' }, { code: 'fr', path: 'francais' }, { code: 'en', path: 'english' }],
    new Map([['de', {}], ['fr', {}], ['en', {}]])
  );
  assert.ok(
    three.includes(
      '  var target = "/";\n' +
        '  if (location.pathname.indexOf("/francais/") === 0) {\n    target = "/francais/";\n  }\n' +
        '  if (location.pathname.indexOf("/english/") === 0) {\n    target = "/english/";\n  }\n' +
        '  location.replace(target);'
    )
  );
  assert.ok(three.includes('<p>Page not found / Page not found / Page not found</p>'));
  assert.ok(three.includes('<p><a href="/" hreflang="de">DE</a> · <a href="/francais/" hreflang="fr">FR</a> · <a href="/english/" hreflang="en">EN</a></p>'));
  const threeScript = three.slice(three.indexOf('<script>'), three.indexOf('</script>') + 9);
  assert.deepStrictEqual(runScript(threeScript, { pathname: '/francais/x.html' }), ['/francais/']);
}
test('notFoundPage forwards unknown addresses to the right home page', notFound);

/**
 * A complete bilingual build.
 *
 * @returns {void}
 */
function bilingualBuild() {
  const root = makeBilingualSite();
  const logger = fixtures.recordingLogger();
  const result = generator.generateSite({ rootDir: root, siteUrl: 'https://example.com', logger: logger, languages: LANGUAGES });

  const titles = [];
  for (const article of result.articles) {
    titles.push(article.lang + ':' + article.title);
  }
  assert.deepStrictEqual(titles, ['de:Datenschutz', 'en:Privacy', 'de:Das Netz', 'en:The Grid', 'en:Solo']);
  assert.strictEqual(result.outputDir, path.join(root, 'public'));

  const redirect = generator.languageRedirectScript(LANGUAGES);
  assert.strictEqual(
    built(root, 'index.html'),
    [
      '<html lang="de"><head><link rel="alternate" hreflang="de" href="https://example.com/index.html">',
      '<link rel="alternate" hreflang="en" href="https://example.com/english/index.html">',
      '<link rel="alternate" hreflang="x-default" href="https://example.com/index.html">' + redirect + '</head>',
      '<body><nav class="language-switch"><span aria-current="page">Deutsch</span><a href="english/index.html" hreflang="en" lang="en">English</a></nav><a href="index.html">Ij</a><h1>Willkommen</h1>',
      '<h2>Start</h2><img src="media/home/start/images/h.jpg"><p>Hallo.</p><p></p><p></p><p></p>',
      '<section>\n<h2>Energie</h2>\n<p><a href="energie/das-netz.html">Das Netz</a></p>\n</section>\n',
      '<footer>Impressum <a href="recht/datenschutz.html">Datenschutz</a></footer></body></html>',
    ].join('\n')
  );
  assert.strictEqual(
    built(root, 'english/index.html'),
    [
      '<html lang="en"><head><link rel="alternate" hreflang="de" href="https://example.com/index.html">',
      '<link rel="alternate" hreflang="en" href="https://example.com/english/index.html">',
      '<link rel="alternate" hreflang="x-default" href="https://example.com/index.html"></head>',
      '<body><nav class="language-switch"><a href="../index.html" hreflang="de" lang="de">Deutsch</a><span aria-current="page">English</span></nav><a href="index.html">Ij</a><h1>Welcome</h1>',
      '<h2>Home</h2><img src=""><p>Hello.</p><p></p><p></p><p></p>',
      '<section>\n<h2>Energy</h2>\n' + ENERGY_TEXT + '\n<p><a href="energy/the-grid.html">The Grid</a></p>\n<p><a href="energy/solo.html">Solo</a></p>\n</section>\n',
      '<footer>Imprint <a href="legal/privacy.html">Privacy</a></footer></body></html>',
    ].join('\n')
  );
  assert.strictEqual(
    built(root, 'english/energy/the-grid.html'),
    [
      '<html lang="en"><head><title>The Grid</title>',
      '<link rel="alternate" hreflang="de" href="https://example.com/energie/das-netz.html">',
      '<link rel="alternate" hreflang="en" href="https://example.com/english/energy/the-grid.html">',
      '<link rel="stylesheet" href="../../style.css"></head>',
      '<body><nav class="language-switch"><a href="../../energie/das-netz.html" hreflang="de" lang="de">Deutsch</a><span aria-current="page">English</span></nav><a href="../index.html">Ij</a>',
      '<img src="../../media/energy/grid/images/p.jpg" alt="The Grid">',
      '<p>See <a href="../../media/energy/grid/pdfs/a.pdf">PDF</a>.</p>',
      '<footer>Imprint <a href="../legal/privacy.html">Privacy</a></footer></body></html>',
    ].join('\n')
  );
  assert.strictEqual(
    built(root, 'english/energy/solo.html'),
    [
      '<html lang="en"><head><title>Solo</title>',
      '',
      '<link rel="stylesheet" href="../../style.css"></head>',
      '<body><a href="../index.html">Ij</a>',
      '',
      '<p>Only in English.</p>',
      '<footer>Imprint <a href="../legal/privacy.html">Privacy</a></footer></body></html>',
    ].join('\n')
  );
  assert.ok(built(root, 'energie/das-netz.html').includes('<a href="../media/energy/grid/pdfs/a.pdf">PDF</a>'));
  assert.ok(built(root, 'recht/datenschutz.html').includes('<p>DE</p>'));
  assert.strictEqual(built(root, '404.html'), generator.notFoundPage(LANGUAGES, new Map([
    ['de', { hero: 'Willkommen', imprint: 'Impressum', privacy: 'Datenschutz', notFound: 'Seite nicht gefunden', languageName: 'Deutsch' }],
    ['en', { hero: 'Welcome', imprint: 'Imprint', privacy: 'Privacy', notFound: 'Page not found', languageName: 'English' }],
  ])));
  assert.strictEqual(
    fs.readFileSync(path.join(root, 'public', 'media', 'energy', 'grid', 'images', 'p.jpg')).toString('hex'),
    generator.stripJpegMetadata(fixtures.cameraJpeg(1)).toString('hex')
  );
  assert.strictEqual(built(root, 'media/energy/grid/pdfs/a.pdf'), 'pdf');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'public')).sort(), ['404.html', 'energie', 'english', 'index.html', 'media', 'recht', 'style.css']);
  assert.strictEqual(fs.existsSync(path.join(root, 'public', 'home')), false);

  const content = path.join(root, 'content');
  assert.deepStrictEqual(logger.logs, [
    'Skipped 1 draft(s):',
    '  - ' + path.join('energy', 'draft', 'de-entwurf.md'),
    'Removed metadata (EXIF/GPS/XMP/text) from 2 image(s).',
    'Generated 5 article(s) in ' + path.join(root, 'public') + '/',
  ]);
  assert.deepStrictEqual(logger.warnings, [
    'WARNING: Skipped 1 file(s):',
    '  - ' + path.relative(content, path.join(content, 'energy', 'grid', 'notes.md')) + ': file name does not start with a language code (de-, en-)',
  ]);
}
test('generateSite builds a bilingual site', bilingualBuild);

/**
 * Skipped translations are reported, pages without home article work, and
 * nothing is built without publishable content.
 *
 * @returns {void}
 */
function edgeCases() {
  const root = fixtures.tempDir();
  fixtures.writeFiles(root, {
    'templates/style.css': '',
    'templates/index.html': '{{homeTitle}}|{{categories}}',
    'templates/article.html': '{{content}}',
    'content/sec/de-sek.md': '---\ntitle: Sek\n---\n',
    'content/sec/page/en-page.md': '---\ntitle: Page\n---\nX',
    'content/sec/page/de-seite.md': '---\ntitle: Seite\n---\nY',
  });
  const logger = fixtures.recordingLogger();
  const result = generator.generateSite({ rootDir: root, logger: logger, languages: LANGUAGES });
  assert.strictEqual(result.articles.length, 1);
  assert.deepStrictEqual(logger.warnings.slice(0, 2), [
    'WARNING: Skipped 1 file(s):',
    '  - ' + path.join('sec', 'page', 'en-page.md') + ': the section folder sec has no en-*.md file with the section name',
  ]);
  assert.strictEqual(built(root, 'index.html'), '{{homeTitle}}|<section>\n<h2>Sek</h2>\n<p><a href="sek/seite.html">Seite</a></p>\n</section>\n');
  assert.strictEqual(built(root, 'english/index.html'), '{{homeTitle}}|');
  assert.ok(logger.warnings.includes('WARNING: Unfilled placeholder(s) {{homeTitle}} in index.html'));
  assert.strictEqual(built(root, '404.html').includes('<p>Page not found / Page not found</p>'), true);

  const homeOnly = fixtures.tempDir();
  fixtures.writeFiles(homeOnly, {
    'templates/style.css': '',
    'templates/index.html': '{{homeTitle}}',
    'templates/article.html': '',
    'content/home/start/de-start.md': '---\ntitle: Start\nhome: true\n---\n',
  });
  const homeResult = generator.generateSite({ rootDir: homeOnly, logger: fixtures.recordingLogger(), languages: LANGUAGES });
  assert.deepStrictEqual(homeResult.articles, []);
  assert.strictEqual(built(homeOnly, 'index.html'), 'Start');

  const empty = fixtures.tempDir();
  fixtures.writeFiles(empty, {
    'templates/style.css': '',
    'templates/index.html': '',
    'templates/article.html': '',
    'content/sec/page/notes.md': 'x',
    'public/keep.txt': 'keep',
  });
  const emptyLogger = fixtures.recordingLogger();
  assert.strictEqual(generator.generateSite({ rootDir: empty, logger: emptyLogger, languages: LANGUAGES }), null);
  assert.deepStrictEqual(emptyLogger.logs, ['No publishable .md files found in ' + path.join(empty, 'content') + '/']);
  assert.strictEqual(built(empty, 'keep.txt'), 'keep');
}
test('generateSite handles missing section names, home-only sites and empty content', edgeCases);

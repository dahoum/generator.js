'use strict';

/**
 * @file Tests for frontmatter parsing, article collection, sorting and the table of contents.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const generator = require('../helpers/subject.js').generator;
const fixtures = require('../helpers/fixtures.js');

/**
 * A complete article with the given changes.
 *
 * @param {Object} changes - Fields to override.
 * @returns {Object} The article.
 */
function article(changes) {
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
      body: '',
      filePath: '/c/cat/x/x.md',
    },
    changes
  );
}

/**
 * Frontmatter lines are split into trimmed fields; other lines are ignored.
 *
 * @returns {void}
 */
function frontmatterFields() {
  const fields = generator.parseFrontmatter('title:  The: Grid  \nempty:\n not: indented\n# comment\nkey_2: v');
  assert.deepStrictEqual(Object.assign({}, fields), { title: 'The: Grid', empty: '', key_2: 'v' });
  assert.strictEqual(Object.getPrototypeOf(fields), null);
}
test('parseFrontmatter reads key: value lines', frontmatterFields);

/**
 * Missing fields read as empty strings, also names of Object.prototype members.
 *
 * @returns {void}
 */
function emptyFields() {
  const fields = generator.parseFrontmatter('a: 1');
  assert.strictEqual(generator.fieldOrEmpty(fields, 'a'), '1');
  assert.strictEqual(generator.fieldOrEmpty(fields, 'b'), '');
  assert.strictEqual(generator.fieldOrEmpty(fields, 'toString'), '');
}
test('fieldOrEmpty returns an empty string for missing fields', emptyFields);

/**
 * order: accepts finite numbers only.
 *
 * @returns {void}
 */
function orderValues() {
  assert.strictEqual(generator.parseOrder(''), null);
  assert.strictEqual(generator.parseOrder('2'), 2);
  assert.strictEqual(generator.parseOrder('-1.5'), -1.5);
  assert.strictEqual(generator.parseOrder('0'), 0);
  assert.strictEqual(generator.parseOrder('first'), null);
  assert.strictEqual(generator.parseOrder('Infinity'), null);
}
test('parseOrder accepts finite numbers', orderValues);

/**
 * A complete article with every field, a BOM and Windows line endings.
 *
 * @returns {void}
 */
function completeArticle() {
  const source =
    '﻿---\r\ncategory: Cat\r\ntitle: T\r\nauthors: A\r\nimage: images/a.jpg\r\nexplanation: E\r\nlang: de\r\norder: 3\r\ntoc: false\r\n---\r\n\r\n  Body\r\nline  \r\n';
  assert.deepStrictEqual(generator.parseArticleSource(source, '/c/a.md'), {
    article: {
      category: 'Cat',
      title: 'T',
      authors: 'A',
      image: 'images/a.jpg',
      explanation: 'E',
      lang: 'de',
      order: 3,
      toc: false,
      body: 'Body\nline',
      filePath: '/c/a.md',
    },
    draft: false,
    skipReason: '',
  });
}
test('parseArticleSource reads every field', completeArticle);

/**
 * Optional fields default to empty; toc defaults to true; a body is optional.
 *
 * @returns {void}
 */
function minimalArticle() {
  assert.deepStrictEqual(generator.parseArticleSource('---\ncategory: C\ntitle: T\ntoc: no\n---', 'f.md'), {
    article: article({ category: 'C', filePath: 'f.md', toc: true }),
    draft: false,
    skipReason: '',
  });
}
test('parseArticleSource fills defaults and accepts files without body', minimalArticle);

/**
 * Files that are not published say why.
 *
 * @returns {void}
 */
function skippedFiles() {
  assert.deepStrictEqual(generator.parseArticleSource('no frontmatter', 'f.md'), {
    article: null,
    draft: false,
    skipReason: 'no frontmatter (--- block at the top of the file)',
  });
  assert.deepStrictEqual(generator.parseArticleSource('---\ncategory: C\ntitle: T\ndraft: true\n---\nx', 'f.md'), {
    article: null,
    draft: true,
    skipReason: 'draft',
  });
  assert.strictEqual(generator.parseArticleSource('---\ncategory: C\ntitle: T\ndraft: yes\n---\nx', 'f.md').draft, false);
  assert.deepStrictEqual(generator.parseArticleSource('---\nauthors: A\n---\nx', 'f.md'), {
    article: null,
    draft: false,
    skipReason: 'missing category and title in frontmatter',
  });
  assert.strictEqual(generator.parseArticleSource('---\ntitle: T\n---\nx', 'f.md').skipReason, 'missing category in frontmatter');
  assert.strictEqual(generator.parseArticleSource('---\ncategory: C\n---\nx', 'f.md').skipReason, 'missing title in frontmatter');
  assert.strictEqual(generator.parseArticleSource('---\ncategory: C\ntitle:\n---\nx', 'f.md').skipReason, 'missing title in frontmatter');
}
test('parseArticleSource explains skipped files', skippedFiles);

/**
 * Files are read from disk; parseMarkdown keeps the 1.0 interface.
 *
 * @returns {void}
 */
function readsFiles() {
  const root = fixtures.tempDir();
  fixtures.writeFiles(root, { 'a.md': '---\ncategory: C\ntitle: Ü\n---\nBody', 'b.md': 'plain' });
  assert.strictEqual(generator.readArticle(path.join(root, 'a.md')).article.title, 'Ü');
  assert.strictEqual(generator.parseMarkdown(path.join(root, 'a.md')).body, 'Body');
  assert.strictEqual(generator.parseMarkdown(path.join(root, 'b.md')), null);
}
test('readArticle and parseMarkdown read Markdown files', readsFiles);

/**
 * Output locations are derived from the article folder.
 *
 * @returns {void}
 */
function outputLocation() {
  assert.deepStrictEqual(generator.articleOutput(article({ filePath: path.join('/c', 'sec', 'slug', 'x.md') }), '/c'), {
    articleDir: path.join('/c', 'sec', 'slug'),
    relativeDir: 'sec',
    articleRelativePath: path.join('sec', 'slug'),
    folderName: 'slug',
  });
}
test('articleOutput maps content/<dir>/<slug>/ to <dir>/<slug>.html', outputLocation);

/**
 * Articles with order: come first, then by file path.
 *
 * @returns {void}
 */
function sorting() {
  assert.strictEqual(generator.orderValue(article({ order: null })), Infinity);
  assert.strictEqual(generator.orderValue(article({ order: 0 })), 0);
  const first = article({ order: 1, filePath: 'z' });
  const second = article({ order: 2, filePath: 'a' });
  const third = article({ filePath: 'b' });
  const fourth = article({ filePath: 'c' });
  assert.strictEqual(generator.compareArticles(first, second), -1);
  assert.strictEqual(generator.compareArticles(second, first), 1);
  assert.strictEqual(generator.compareArticles(second, third), -Infinity);
  assert.strictEqual(generator.compareArticles(third, fourth), -1);
  assert.strictEqual(generator.compareArticles(fourth, third), 1);
  assert.strictEqual(generator.compareArticles(third, article({ filePath: 'b' })), 0);
}
test('compareArticles sorts by order, then by path', sorting);

/**
 * Collecting walks folders in a stable order and separates drafts and skipped files.
 *
 * @returns {void}
 */
function collecting() {
  const root = fixtures.tempDir();
  fixtures.writeFiles(root, {
    'b/two/two.md': '---\ncategory: C\ntitle: Two\n---\n',
    'a/one/one.md': '---\ncategory: C\ntitle: One\n---\n',
    'a/first/first.md': '---\ncategory: C\ntitle: First\norder: 1\n---\n',
    'a/draft/d.md': '---\ncategory: C\ntitle: D\ndraft: true\n---\n',
    'a/broken/x.md': 'nothing',
    'a/one/notes.txt': 'ignored',
  });
  const collection = generator.collectArticles(root);
  const titles = [];
  for (const item of collection.articles) {
    titles.push(item.title);
  }
  assert.deepStrictEqual(titles, ['First', 'One', 'Two']);
  assert.deepStrictEqual(collection.drafts, [path.join(root, 'a/draft/d.md')]);
  assert.deepStrictEqual(collection.skipped, [
    { file: path.join(root, 'a/broken/x.md'), reason: 'no frontmatter (--- block at the top of the file)' },
  ]);
}
test('collectArticles finds, sorts and classifies Markdown files', collecting);

/**
 * The table of contents groups by category in article order and skips toc: false.
 *
 * @returns {void}
 */
function tableOfContents() {
  const articles = [
    article({ category: 'B', title: 'B1', filePath: path.join('/c', 'b', 'one', 'x.md') }),
    article({ category: 'A', title: 'A1', filePath: path.join('/c', 'a', 'one', 'x.md') }),
    article({ category: 'B', title: 'Hidden', toc: false, filePath: path.join('/c', 'b', 'hidden', 'x.md') }),
    article({ category: 'B', title: 'B2', filePath: path.join('/c', 'b', 'two', 'x.md') }),
    article({ category: 'H', title: 'H', toc: false, filePath: path.join('/c', 'h', 'x', 'x.md') }),
  ];
  assert.strictEqual(
    generator.generateCategoriesHtml(articles, '/c'),
    '<section>\n<h2>B</h2>\n<p><a href="b/one.html">B1</a></p>\n<p><a href="b/two.html">B2</a></p>\n</section>\n' +
      '<section>\n<h2>A</h2>\n<p><a href="a/one.html">A1</a></p>\n</section>\n'
  );
  assert.strictEqual(generator.generateCategoriesHtml([], '/c'), '');
}
test('generateCategoriesHtml builds the table of contents', tableOfContents);

/**
 * Content read from a real file system keeps UTF-8 characters.
 *
 * @returns {void}
 */
function utf8Content() {
  const root = fixtures.tempDir();
  fs.writeFileSync(path.join(root, 'u.md'), '---\ncategory: C\ntitle: Grüße\n---\n«x»');
  assert.strictEqual(generator.readArticle(path.join(root, 'u.md')).article.body, '«x»');
}
test('readArticle reads UTF-8', utf8Content);

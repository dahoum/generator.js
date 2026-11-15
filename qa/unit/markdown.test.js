'use strict';

/**
 * @file Tests for the Markdown renderer.
 */

const assert = require('node:assert');
const test = require('node:test');

const generator = require('../helpers/subject.js').generator;

/**
 * Link resolver that marks resolved targets, so tests can see it was used.
 *
 * @param {string} href - Link target.
 * @returns {string} The target with a `resolved:` prefix.
 */
function markLink(href) {
  return 'resolved:' + href;
}

/**
 * Render a body for a page in `/site/public/cat` whose article lives in `cat/article`.
 *
 * @param {string} markdown - Article body.
 * @returns {string} HTML.
 */
function render(markdown) {
  return generator.markdownToHtml(markdown, '/site/public/cat', 'cat/article');
}

/**
 * Strong and emphasis with underscores and asterisks.
 *
 * @returns {void}
 */
function emphasisForms() {
  assert.strictEqual(
    generator.emphasis('_a_ __b__ *c* **d** x * y * z'),
    '<em>a</em> <strong>b</strong> <em>c</em> <strong>d</strong> x * y * z'
  );
  assert.strictEqual(generator.emphasis('snake_case_word and __init__x'), 'snake_case_word and __init__x');
  assert.strictEqual(generator.emphasis('in**side**word'), 'in<strong>side</strong>word');
  assert.strictEqual(generator.emphasis('_ a _ and ** b **'), '_ a _ and ** b **');
}
test('emphasis handles _em_, __strong__, *em* and **strong** at word boundaries', emphasisForms);

/**
 * Code spans are escaped and protected from emphasis.
 *
 * @returns {void}
 */
function codeSpans() {
  assert.strictEqual(generator.inline('use `a_b <c> & d`', markLink), 'use <code>a_b &lt;c&gt; &amp; d</code>');
}
test('inline escapes and protects code spans', codeSpans);

/**
 * Links go through the resolver, keep emphasis in their text and are protected.
 *
 * @returns {void}
 */
function markdownLinks() {
  assert.strictEqual(
    generator.inline('see [the _doc_]( a_b.pdf ) now', markLink),
    'see <a href="resolved:a_b.pdf">the <em>doc</em></a> now'
  );
}
test('inline resolves Markdown links', markdownLinks);

/**
 * Bare URLs become links; surrounding punctuation stays outside.
 *
 * @returns {void}
 */
function bareUrls() {
  assert.strictEqual(
    generator.inline('[1] (https://example.com/a_b?c=1&d=2), more.', markLink),
    '[1] (<a href="https://example.com/a_b?c=1&d=2">https://example.com/a_b?c=1&d=2</a>), more.'
  );
  assert.strictEqual(
    generator.inline('Go to http://x.org/y_z.', markLink),
    'Go to <a href="http://x.org/y_z">http://x.org/y_z</a>.'
  );
}
test('inline links bare URLs without swallowing punctuation', bareUrls);

/**
 * Raw HTML tags pass through untouched, including underscores in attributes,
 * and URLs inside attributes are not linked again.
 *
 * @returns {void}
 */
function rawHtml() {
  assert.strictEqual(
    generator.inline('<a href="https://x.org/a_b_c">x</a> and _y_', markLink),
    '<a href="https://x.org/a_b_c">x</a> and <em>y</em>'
  );
}
test('inline passes raw HTML through', rawHtml);

/**
 * Several protected spans keep their own positions.
 *
 * @returns {void}
 */
function manyProtectedSpans() {
  assert.strictEqual(
    generator.inline('`a` `b` `c` [d](e) `f` `g` `h` `i` `j` `k` `l`', markLink),
    '<code>a</code> <code>b</code> <code>c</code> <a href="resolved:e">d</a> <code>f</code> <code>g</code> <code>h</code> ' +
      '<code>i</code> <code>j</code> <code>k</code> <code>l</code>'
  );
}
test('inline restores many protected spans in place', manyProtectedSpans);

/**
 * Dollar signs in text are inserted literally.
 *
 * @returns {void}
 */
function dollarSigns() {
  assert.strictEqual(render("Costs $& and $' and $$"), "<p>Costs $& and $' and $$</p>");
}
test('markdownToHtml keeps $ patterns literal', dollarSigns);

/**
 * closeList closes only an open list.
 *
 * @returns {void}
 */
function closesLists() {
  const state = { html: [], openList: 'ol' };
  generator.closeList(state);
  generator.closeList(state);
  assert.deepStrictEqual(state, { html: ['</ol>'], openList: '' });
}
test('closeList closes an open list exactly once', closesLists);

/**
 * Headings h1 to h6 with inline formatting; seven hashes are a paragraph.
 *
 * @returns {void}
 */
function headings() {
  assert.strictEqual(
    render('# A _b_\n## B\n### C\n#### D\n##### E\n###### F\n####### G\n#NoSpace'),
    '<h1>A <em>b</em></h1>\n<h2>B</h2>\n<h3>C</h3>\n<h4>D</h4>\n<h5>E</h5>\n<h6>F</h6>\n<p>####### G</p>\n<p>#NoSpace</p>'
  );
}
test('markdownToHtml renders headings h1-h6', headings);

/**
 * Bullet and numbered lists, switching type, closed by blank lines, headings and paragraphs.
 *
 * @returns {void}
 */
function lists() {
  assert.strictEqual(
    render('- a\n* b\n1. one\n2) two\n- c\n\n- d\n# H\n- e\ntext\n- f'),
    [
      '<ul>', '<li>a</li>', '<li>b</li>', '</ul>',
      '<ol>', '<li>one</li>', '<li>two</li>', '</ol>',
      '<ul>', '<li>c</li>', '</ul>',
      '<ul>', '<li>d</li>', '</ul>',
      '<h1>H</h1>',
      '<ul>', '<li>e</li>', '</ul>',
      '<p>text</p>',
      '<ul>', '<li>f</li>', '</ul>',
    ].join('\n')
  );
  assert.strictEqual(render('-not a list\n1.not either'), '<p>-not a list</p>\n<p>1.not either</p>');
}
test('markdownToHtml renders bullet and numbered lists', lists);

/**
 * Every non-empty line is its own paragraph; CRLF and surrounding blanks are handled.
 *
 * @returns {void}
 */
function paragraphs() {
  assert.strictEqual(render('\r\n  one  \r\ntwo\r\n\r\n'), '<p>one</p>\n<p>two</p>');
  assert.strictEqual(render(''), '');
}
test('markdownToHtml turns every line into a paragraph', paragraphs);

/**
 * Links to `pdfs/` are resolved to the article's PDF folder; other links stay.
 *
 * @returns {void}
 */
function pdfLinks() {
  assert.strictEqual(
    render('[Doc](pdfs/a.pdf) [Site](https://x.org) [Rel](other/pdfs/b.pdf)'),
    '<p><a href="article/pdfs/a.pdf">Doc</a> <a href="https://x.org">Site</a> <a href="other/pdfs/b.pdf">Rel</a></p>'
  );
}
test('markdownToHtml resolves pdfs/ links', pdfLinks);

/**
 * Images: `images/` prefix and bare names resolve to the article folder,
 * external URLs stay, captions come from the alt text.
 *
 * @returns {void}
 */
function images() {
  assert.strictEqual(
    render('![](images/a.jpg)\n![](b.jpg)\n![A "c" _d_]( https://x.org/c.jpg )\n  ![](/d.jpg)  \n![x](y.jpg) trailing'),
    [
      '<p><img src="article/images/a.jpg" alt="" class="article-inline-image"></p>',
      '<p><img src="article/images/b.jpg" alt="" class="article-inline-image"></p>',
      '<p><img src="https://x.org/c.jpg" alt="A &quot;c&quot; _d_" class="article-inline-image"></p>',
      '<p class="article-explanation">A "c" <em>d</em></p>',
      '<p><img src="/d.jpg" alt="" class="article-inline-image"></p>',
      '<p>!<a href="y.jpg">x</a> trailing</p>',
    ].join('\n')
  );
}
test('markdownToHtml renders images', images);

/**
 * renderImage escapes quotes in the alt text and renders the caption with inline formatting.
 *
 * @returns {void}
 */
function imageCaptions() {
  assert.strictEqual(
    generator.renderImage('A "_c_"', 'https://x.org/c.jpg', '/out', '/out/images', markLink),
    '<p><img src="https://x.org/c.jpg" alt="A &quot;_c_&quot;" class="article-inline-image"></p>\n' +
      '<p class="article-explanation">A "<em>c</em>"</p>'
  );
  assert.strictEqual(
    generator.renderImage('', 'images/sub/x.png', '/out/cat', '/out/cat/art/images', markLink),
    '<p><img src="art/images/sub/x.png" alt="" class="article-inline-image"></p>'
  );
  assert.strictEqual(
    generator.renderImage('', 'pictures/images/x.png', '/out/cat', '/out/cat/art/images', markLink),
    '<p><img src="art/images/pictures/images/x.png" alt="" class="article-inline-image"></p>'
  );
}
test('renderImage resolves paths and renders captions', imageCaptions);

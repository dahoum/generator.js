'use strict';

/**
 * @file Tests for the small string and path helpers.
 */

const assert = require('node:assert');
const path = require('node:path');
const test = require('node:test');

const generator = require('../helpers/subject.js').generator;

/**
 * toPosix replaces the given separator, also when it is a Windows backslash.
 *
 * @returns {void}
 */
function toPosixReplacesSeparators() {
  assert.strictEqual(generator.toPosix('a\\b\\c.html', '\\'), 'a/b/c.html');
  assert.strictEqual(generator.toPosix('a/b', '/'), 'a/b');
  assert.strictEqual(generator.toPosix('plain', '\\'), 'plain');
}
test('toPosix replaces every separator with a slash', toPosixReplacesSeparators);

/**
 * relativeUrl walks up and down directories with forward slashes.
 *
 * @returns {void}
 */
function relativeUrlBetweenDirectories() {
  assert.strictEqual(generator.relativeUrl('/site/a', '/site/b/c.jpg'), '../b/c.jpg');
  assert.strictEqual(generator.relativeUrl('/site', '/site'), '');
}
test('relativeUrl gives a relative link between two locations', relativeUrlBetweenDirectories);

/**
 * fill replaces every occurrence and inserts `$` patterns literally.
 *
 * @returns {void}
 */
function fillReplacesAllOccurrencesLiterally() {
  assert.strictEqual(generator.fill('{{a}}-{{a}}-{{b}}', 'a', 'x'), 'x-x-{{b}}');
  assert.strictEqual(generator.fill('[{{v}}]', 'v', "$& $' $$ $1"), "[$& $' $$ $1]");
  assert.strictEqual(generator.fill('{{n}}px', 'n', 42), '42px');
  assert.strictEqual(generator.fill('{a}', 'a', 'x'), '{a}');
}
test('fill replaces every placeholder and keeps $ patterns literal', fillReplacesAllOccurrencesLiterally);

/**
 * escapeQuotes escapes double quotes only.
 *
 * @returns {void}
 */
function escapeQuotesOnlyQuotes() {
  assert.strictEqual(generator.escapeQuotes('say "hi" &laquo; <b>'), 'say &quot;hi&quot; &laquo; <b>');
}
test('escapeQuotes escapes double quotes and nothing else', escapeQuotesOnlyQuotes);

/**
 * escapeHtml escapes ampersands first, then angle brackets.
 *
 * @returns {void}
 */
function escapeHtmlEscapesSpecialCharacters() {
  assert.strictEqual(generator.escapeHtml('a < b && c > "d"'), 'a &lt; b &amp;&amp; c &gt; "d"');
  assert.strictEqual(generator.escapeHtml('&lt;'), '&amp;lt;');
}
test('escapeHtml escapes &, < and >', escapeHtmlEscapesSpecialCharacters);

/**
 * isExternalUrl recognises schemes, protocol-relative, root-relative and fragment links.
 *
 * @returns {void}
 */
function isExternalUrlRecognisesAbsoluteTargets() {
  assert.strictEqual(generator.isExternalUrl('https://x.org/a.jpg'), true);
  assert.strictEqual(generator.isExternalUrl('mailto:a@b.c'), true);
  assert.strictEqual(generator.isExternalUrl('//cdn.org/a.jpg'), true);
  assert.strictEqual(generator.isExternalUrl('/images/a.jpg'), true);
  assert.strictEqual(generator.isExternalUrl('#top'), true);
  assert.strictEqual(generator.isExternalUrl('images/a.jpg'), false);
  assert.strictEqual(generator.isExternalUrl('a.jpg'), false);
}
test('isExternalUrl tells absolute from relative targets', isExternalUrlRecognisesAbsoluteTargets);

/**
 * normalizeNewlines converts CRLF and CR to LF.
 *
 * @returns {void}
 */
function normalizeNewlinesConvertsLineEndings() {
  assert.strictEqual(generator.normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
}
test('normalizeNewlines converts Windows and old Mac line endings', normalizeNewlinesConvertsLineEndings);

/**
 * absoluteUrl prefixes the site URL and percent-encodes the path.
 *
 * @returns {void}
 */
function absoluteUrlBuildsEncodedUrls() {
  assert.strictEqual(generator.absoluteUrl('https://example.com', path.join('a b', 'c.html')), 'https://example.com/a%20b/c.html');
  assert.strictEqual(generator.absoluteUrl('', 'c.html'), '/c.html');
}
test('absoluteUrl prefixes the site URL and encodes the path', absoluteUrlBuildsEncodedUrls);

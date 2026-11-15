'use strict';

/**
 * @file Checks every JavaScript file of the project against the style rules in
 * qa/tools/style.js (long JavaScript, complete JSDoc).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const style = require('./tools/style.js');

/**
 * Repository root.
 * @type {string}
 */
const ROOT = path.join(__dirname, '..');

/**
 * All JavaScript files of the project, except dependencies.
 *
 * @param {string} directory - Directory to search.
 * @returns {Array<string>} Absolute paths, sorted.
 */
function javascriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const file of javascriptFiles(full)) {
        files.push(file);
      }
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files.sort();
}

/**
 * Every file follows the rules; the report lists all violations at once.
 *
 * @returns {void}
 */
function everyFileFollowsTheRules() {
  const violations = [];
  for (const file of javascriptFiles(ROOT)) {
    for (const violation of style.checkSource(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file))) {
      violations.push(violation);
    }
  }
  assert.strictEqual(style.formatViolations(violations), '');
}
test('all JavaScript files use long syntax and complete JSDoc', everyFileFollowsTheRules);

/**
 * The checker itself reports each kind of violation.
 *
 * @returns {void}
 */
function checkerReportsViolations() {
  const source = [
    "'use strict';",
    'const a = b ? 1 : 2; const c = d?.e; const f = g ?? 1;',
    'const h = (x) => x; i++; j--; const k = [...l]; if (a == b) {} if (a != b) {}',
    'var m = 1; if (a) b(); else c(); for (;;) d(); while (a) e(); do { f(); } while (a);',
    'const { n } = o; const [p] = q; const r = s || t; const u = { v, w: 1 };',
    'function noDoc(x) { return x; }',
    '/** Bad. */ function badParams(a = 1, { b }) { return a; }',
    '/**\n * Described.\n *\n * @param {number} y - Why.\n * @returns {number}\n */\nfunction wrongNames(x) { return x; }',
    '/**\n *\n * @param {number} x - Why.\n */\nfunction noDescription(x) { return x; }',
    '/**\n * Fine.\n *\n * @param {{a: number}} x - Nested type.\n * @returns {void}\n */\nfunction fine(x) { if (x && x.a) { return; } return x || 0; }',
  ].join('\n');
  const rules = [];
  for (const violation of style.checkSource(source, 'example.js')) {
    rules.push(violation.line + ':' + violation.rule);
  }
  assert.deepStrictEqual(rules, [
    '2:no-question-mark-operators',
    '2:no-question-mark-operators',
    '2:no-question-mark-operators',
    '3:no-arrow-functions',
    '3:no-increment-decrement',
    '3:no-increment-decrement',
    '3:no-spread',
    '3:strict-equality',
    '3:strict-equality',
    '4:no-var',
    '4:braces',
    '4:braces',
    '4:braces',
    '4:braces',
    '5:no-destructuring',
    '5:no-destructuring',
    '5:logical-in-conditions',
    '5:no-shorthand-properties',
    '6:jsdoc',
    '7:simple-parameters',
    '7:simple-parameters',
    '7:simple-parameters',
    '7:simple-parameters',
    '7:jsdoc',
    '7:jsdoc',
    '7:no-shorthand-properties',
    '14:jsdoc',
    '14:jsdoc',
    '19:jsdoc',
    '19:jsdoc',
  ]);
  assert.deepStrictEqual(style.checkSource('const a = 1;', 'no-strict.js')[0].rule, 'strict-mode');
}
test('the style checker reports every rule', checkerReportsViolations);

'use strict';

/**
 * @file Tests for the QA tools: tokenizer, mutation operators and mutation runner helpers.
 */

const assert = require('node:assert');
const test = require('node:test');

const tokenizer = require('./tokenizer.js');
const mutators = require('./mutators.js');
const mutation = require('./mutation.js');

/**
 * Compact form of tokens for comparisons.
 *
 * @param {string} source - Source text.
 * @returns {Array<string>} `type:value` for every token.
 */
function compact(source) {
  const result = [];
  for (const token of tokenizer.tokenize(source)) {
    result.push(token.type + ':' + token.value);
  }
  return result;
}

/**
 * Division and regular expressions are told apart by the previous token.
 *
 * @returns {void}
 */
function divisionAndRegex() {
  assert.deepStrictEqual(compact('a = b / c / d;'), [
    'identifier:a', 'punctuator:=', 'identifier:b', 'punctuator:/', 'identifier:c', 'punctuator:/', 'identifier:d', 'punctuator:;',
  ]);
  assert.deepStrictEqual(compact('x = /a[/]b\\//gi; return /y/;'), [
    'identifier:x', 'punctuator:=', 'regex:/a[/]b\\//gi', 'punctuator:;', 'identifier:return', 'regex:/y/', 'punctuator:;',
  ]);
  assert.deepStrictEqual(compact('(a) / 2'), ['punctuator:(', 'identifier:a', 'punctuator:)', 'punctuator:/', 'number:2']);
}
test('tokenize tells division from regular expressions', divisionAndRegex);

/**
 * Strings, templates with nested expressions, comments and numbers.
 *
 * @returns {void}
 */
function literalsAndComments() {
  assert.deepStrictEqual(compact("'a\\'b' \"c\" `d${ {e: `f${g}`}.e }h` // x\n/* y */ 0xFF 1.5e3 .5"), [
    "string:'a\\'b'", 'string:"c"', 'template:`d${ {e: `f${g}`}.e }h`', 'comment:// x', 'comment:/* y */',
    'number:0xFF', 'number:1.5e3', 'number:.5',
  ]);
  assert.deepStrictEqual(compact('a === b !== c ?. d ?? e => f ... g'), [
    'identifier:a', 'punctuator:===', 'identifier:b', 'punctuator:!==', 'identifier:c', 'punctuator:?.', 'identifier:d',
    'punctuator:??', 'identifier:e', 'punctuator:=>', 'identifier:f', 'punctuator:...', 'identifier:g',
  ]);
}
test('tokenize reads literals, comments and long punctuators', literalsAndComments);

/**
 * Line numbers are 1-based and unreadable input is reported.
 *
 * @returns {void}
 */
function linesAndErrors() {
  const tokens = tokenizer.tokenize('a\n\nb\n  c');
  assert.deepStrictEqual([tokens[0].line, tokens[1].line, tokens[2].line], [1, 3, 4]);
  assert.throws(
    /**
     * Tokenize a string without closing quote.
     *
     * @returns {void}
     */
    function unterminatedString() {
    tokenizer.tokenize("'abc");
  }, /Unterminated string at offset 0/);
  assert.throws(
    /**
     * Tokenize a comment without end.
     *
     * @returns {void}
     */
    function unterminatedComment() {
    tokenizer.tokenize('/* abc');
  }, /Unterminated comment/);
  assert.throws(
    /**
     * Tokenize a character that is not JavaScript.
     *
     * @returns {void}
     */
    function unexpectedCharacter() {
    tokenizer.tokenize('a § b');
  }, /Unexpected character/);
}
test('tokenize reports line numbers and errors', linesAndErrors);

/**
 * matchingBracket finds the partner across nesting.
 *
 * @returns {void}
 */
function brackets() {
  const tokens = tokenizer.significant(tokenizer.tokenize('f(a, [b, (c)], {d: e}) /* x */ ;'));
  assert.strictEqual(tokenizer.matchingBracket(tokens, 1), 17);
  assert.strictEqual(tokenizer.matchingBracket(tokenizer.significant(tokenizer.tokenize('(a')), 0), -1);
}
test('matchingBracket finds the closing bracket', brackets);

/**
 * Describe every mutant of a snippet.
 *
 * @param {string} source - Source text.
 * @returns {Array<string>} `operator: original -> replacement` for each mutant.
 */
function describeMutants(source) {
  const result = [];
  for (const mutant of mutators.generateMutants(source)) {
    result.push(mutant.operator + ': ' + mutant.original + ' -> ' + mutant.replacement);
  }
  return result;
}

/**
 * Each operator produces the expected mutants.
 *
 * @returns {void}
 */
function operators() {
  assert.deepStrictEqual(describeMutants("'use strict';\nconst f = require('fs');\nif (a < b && !c) { x += 1; } else { y = -z * 2; }"), [
    'ConditionalExpression: a < b && !c -> true',
    'ConditionalExpression: a < b && !c -> false',
    'EqualityOperator: < -> <=',
    'EqualityOperator: < -> >=',
    'LogicalOperator: && -> ||',
    'UnaryOperator: ! -> ',
    'BlockStatement: { x += 1; } -> {}',
    'AssignmentOperator: += -> -=',
    'BlockStatement: { y = -z * 2; } -> {}',
    'UnaryOperator: - -> +',
    'ArithmeticOperator: * -> /',
  ]);
  assert.deepStrictEqual(describeMutants("'use strict';\nconst o = { a: [1], b: [], c: '', d: 'x', e: true };\nwhile (false) { g(); }"), [
    "ObjectLiteral: { a: [1], b: [], c: '', d: 'x', e: true } -> {}",
    'ArrayDeclaration: [1] -> []',
    "ArrayDeclaration: [] -> ['Stryker was here']",
    "StringLiteral: '' -> 'Stryker was here!'",
    "StringLiteral: 'x' -> ''",
    'BooleanLiteral: true -> false',
    'ConditionalExpression: false -> false',
    'BooleanLiteral: false -> true',
    'BlockStatement: { g(); } -> {}',
  ]);
  assert.deepStrictEqual(describeMutants("'use strict';\nfor (let i = 0; i < n; i += 1) { a(); }\nfor (const x of y) { b(); }"), [
    'ConditionalExpression: i < n -> false',
    'EqualityOperator: < -> <=',
    'EqualityOperator: < -> >=',
    'AssignmentOperator: += -> -=',
    'BlockStatement: { a(); } -> {}',
    'BlockStatement: { b(); } -> {}',
  ]);
}
test('generateMutants applies every operator', operators);

/**
 * Mutants are applied by replacing exactly their range.
 *
 * @returns {void}
 */
function applying() {
  const source = "'use strict';\nconst a = b === c;";
  const mutant = mutators.generateMutants(source)[0];
  assert.strictEqual(mutators.applyMutant(source, mutant), "'use strict';\nconst a = b !== c;");
  assert.strictEqual(mutant.line, 2);
  assert.strictEqual(mutant.lineText, 'const a = b === c;');
  assert.strictEqual(mutant.id, 1);
}
test('applyMutant replaces the mutated range', applying);

/**
 * Mutants are identified by operator, texts and line content; arguments are parsed.
 *
 * @returns {void}
 */
function runnerHelpers() {
  assert.strictEqual(
    mutation.mutantKey({ operator: 'O', original: 'a', replacement: 'b', lineText: 'x' }),
    'O\u0000a\u0000b\u0000x'
  );
  assert.deepStrictEqual(mutation.parseArguments([]), { rerun: false, firstLine: 1, lastLine: Infinity });
  assert.deepStrictEqual(mutation.parseArguments(['--rerun', '--lines', '10-20']), { rerun: true, firstLine: 10, lastLine: 20 });
  assert.throws(
    /**
     * Parse an unknown argument.
     *
     * @returns {void}
     */
    function unknownArgument() {
    mutation.parseArguments(['--nope']);
  }, /Unknown argument --nope/);
}
test('mutation runner helpers', runnerHelpers);

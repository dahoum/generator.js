'use strict';

/**
 * @file Style checker for the "long JavaScript" rules of this project.
 *
 * Rules (each violation names its rule):
 * - strict-mode: every file starts with 'use strict'.
 * - no-question-mark-operators: no `a ? b : c`, `?.`, `??` or `??=`.
 * - no-arrow-functions: no `=>`.
 * - no-increment-decrement: no `++` or `--`; write `+= 1` / `-= 1`.
 * - no-spread: no `...`.
 * - strict-equality: no `==` or `!=`.
 * - no-var: no `var`.
 * - braces: the body of `if`, `else`, `for`, `while` and `do` is always a block.
 * - simple-parameters: parameters are plain names (no defaults, destructuring or rest).
 * - no-destructuring: no `const {` / `let [` declarations.
 * - logical-in-conditions: `&&` and `||` only inside `if`/`while`/`for`
 *   conditions or `return` statements, never to pick default values.
 * - no-shorthand-properties: object literals spell out `key: value`.
 * - jsdoc: every function has a JSDoc comment with a description, an `@param`
 *   with type and description for every parameter (in order) and an `@returns`.
 */

const tokenizer = require('./tokenizer.js');

/**
 * @typedef {Object} Violation
 * @property {string} file - File name as passed to checkSource.
 * @property {number} line - 1-based line number.
 * @property {string} rule - Rule name.
 * @property {string} message - Explanation.
 */

/**
 * Keywords whose parenthesised expression is a condition.
 * @type {Set<string>}
 */
const CONDITION_KEYWORDS = new Set(['if', 'while', 'for']);

/**
 * Tokens after which `{` or `[` starts a literal value rather than a block.
 * @type {Set<string>}
 */
const LITERAL_CONTEXT = new Set(['=', '(', ',', ':', '[', 'return']);

/**
 * Check the JSDoc comment of a function.
 *
 * @param {string} comment - The comment text including `/**` and `*\/`.
 * @param {Array<string>} parameters - Parameter names in order.
 * @returns {Array<string>} Problems found; empty when the comment is complete.
 */
function checkJsdoc(comment, parameters) {
  const problems = [];
  const text = comment.replace(/^\/\*\*/, '').replace(/\*\/$/, '').replace(/^\s*\* ?/gm, '');
  const description = text.split(/^@/m)[0].trim();
  if (description === '') {
    problems.push('missing description');
  }
  const documented = [];
  const parameterPattern = /^@param\s+\{(?:[^{}]|\{[^{}]*\})+\}\s+\[?([A-Za-z_$][\w$]*)(?:[^\s\]]*)\]?\s+-\s+\S/gm;
  let match = parameterPattern.exec(text);
  while (match !== null) {
    if (!documented.includes(match[1])) {
      documented.push(match[1]);
    }
    match = parameterPattern.exec(text);
  }
  if (documented.join(',') !== parameters.join(',')) {
    problems.push('@param tags (' + documented.join(', ') + ') must match the parameters (' + parameters.join(', ') + ') in order, each with {type} and "- description"');
  }
  const returns = text.match(/^@returns\s+\{((?:[^{}]|\{[^{}]*\})+)\}(.*)$/m);
  if (returns === null) {
    problems.push('missing @returns {type}');
  } else if (returns[1] !== 'void' && returns[2].trim() === '') {
    problems.push('@returns needs a description');
  }
  return problems;
}

/**
 * Check one source file against all rules.
 *
 * @param {string} source - File contents.
 * @param {string} file - File name used in the report.
 * @returns {Array<Violation>} Violations in source order.
 */
function checkSource(source, file) {
  const violations = [];
  const allTokens = tokenizer.tokenize(source);
  const tokens = tokenizer.significant(allTokens);

  /**
   * Record a violation.
   *
   * @param {{line: number}} token - Where it happened.
   * @param {string} rule - Rule name.
   * @param {string} message - Explanation.
   * @returns {void}
   */
  function report(token, rule, message) {
    violations.push({ file: file, line: token.line, rule: rule, message: message });
  }

  if (tokens.length === 0 || tokens[0].type !== 'string' || tokens[0].value.slice(1, -1) !== 'use strict') {
    report({ line: 1 }, 'strict-mode', "the file must start with 'use strict'");
  }

  // Each open bracket remembers whether it is a condition, an object literal or something else.
  const brackets = [];
  let returnDepth = -1;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let previous = null;
    if (index > 0) {
      previous = tokens[index - 1];
    }
    let next = null;
    if (index + 1 < tokens.length) {
      next = tokens[index + 1];
    }
    const value = token.value;

    if (token.type === 'punctuator') {
      if (value.includes('?')) {
        report(token, 'no-question-mark-operators', '"' + value + '" is not allowed; use if/else');
      }
      if (value === '=>') {
        report(token, 'no-arrow-functions', 'use a documented function declaration');
      }
      if (value === '++' || value === '--') {
        report(token, 'no-increment-decrement', 'write "' + value[0] + '= 1"');
      }
      if (value === '...') {
        report(token, 'no-spread', 'spread/rest syntax is not allowed');
      }
      if (value === '==' || value === '!=') {
        report(token, 'strict-equality', 'use "' + value + '="');
      }
      if (value === '&&' || value === '||') {
        let inCondition = false;
        for (const bracket of brackets) {
          if (bracket.kind === 'condition') {
            inCondition = true;
          }
        }
        if (!inCondition && returnDepth === -1) {
          report(token, 'logical-in-conditions', '"' + value + '" outside a condition or return statement; use if/else');
        }
      }
      if (brackets.length > 0 && brackets[brackets.length - 1].kind === 'object' && (value === ',' || value === '}')) {
        // `{ a, b }` shorthand: an identifier directly between `{`/`,` and `,`/`}`.
        if (previous !== null && previous.type === 'identifier' && index >= 2) {
          const beforePrevious = tokens[index - 2].value;
          if (beforePrevious === '{' || beforePrevious === ',') {
            report(previous, 'no-shorthand-properties', 'write "' + previous.value + ': ' + previous.value + '"');
          }
        }
      }
      if (value === '(' || value === '[' || value === '{') {
        let kind = 'other';
        if (value === '(' && previous !== null && CONDITION_KEYWORDS.has(previous.value)) {
          kind = 'condition';
        }
        if (value === '{' && (previous === null || LITERAL_CONTEXT.has(previous.value))) {
          kind = 'object';
        }
        brackets.push({ kind: kind, value: value });
      }
      if (value === ')' || value === ']' || value === '}') {
        brackets.pop();
      }
      if (value === ';' && returnDepth === brackets.length) {
        returnDepth = -1;
      }
    }

    if (token.type === 'identifier') {
      if (value === 'return') {
        returnDepth = brackets.length;
      }
      if (value === 'var') {
        report(token, 'no-var', 'use const or let');
      }
      if ((value === 'const' || value === 'let') && next !== null && (next.value === '{' || next.value === '[')) {
        report(token, 'no-destructuring', 'destructuring is not allowed');
      }
      if ((value === 'if' || value === 'for' || value === 'while') && next !== null && next.value === '(') {
        const close = tokenizer.matchingBracket(tokens, index + 1);
        let closesDoLoop = false;
        if (value === 'while' && previous !== null && previous.value === '}' && close + 1 < tokens.length && tokens[close + 1].value === ';') {
          closesDoLoop = true;
        }
        if (!closesDoLoop && (close === -1 || close + 1 >= tokens.length || tokens[close + 1].value !== '{')) {
          report(token, 'braces', 'the body of "' + value + '" must be a block');
        }
      }
      if ((value === 'else' || value === 'do') && next !== null && next.value !== '{' && next.value !== 'if') {
        report(token, 'braces', 'the body of "' + value + '" must be a block');
      }
      if (value === 'function') {
        checkFunction(index);
      }
    }
  }

  /**
   * Check the parameters and the JSDoc comment of the function at a token index.
   *
   * @param {number} functionIndex - Index of the `function` keyword in `tokens`.
   * @returns {void}
   */
  function checkFunction(functionIndex) {
    const keyword = tokens[functionIndex];
    let open = functionIndex + 1;
    let name = '(anonymous)';
    if (tokens[open].type === 'identifier') {
      name = tokens[open].value;
      open += 1;
    }
    const close = tokenizer.matchingBracket(tokens, open);
    const parameters = [];
    for (let index = open + 1; index < close; index += 1) {
      const parameter = tokens[index];
      if (parameter.type === 'identifier') {
        parameters.push(parameter.value);
      } else if (parameter.value !== ',') {
        report(parameter, 'simple-parameters', 'parameters of ' + name + ' must be plain names');
      }
    }

    let position = allTokens.indexOf(keyword);
    if (position > 0 && allTokens[position - 1].value === 'async') {
      position -= 1;
    }
    let comment = null;
    if (position > 0 && allTokens[position - 1].type === 'comment' && allTokens[position - 1].value.startsWith('/**')) {
      comment = allTokens[position - 1].value;
    }
    if (comment === null) {
      report(keyword, 'jsdoc', 'function ' + name + ' needs a JSDoc comment directly before it');
      return;
    }
    for (const problem of checkJsdoc(comment, parameters)) {
      report(keyword, 'jsdoc', 'function ' + name + ': ' + problem);
    }
  }

  return violations;
}

/**
 * Format violations for display.
 *
 * @param {Array<Violation>} violations - Result of checkSource.
 * @returns {string} One line per violation.
 */
function formatViolations(violations) {
  const lines = [];
  for (const violation of violations) {
    lines.push(violation.file + ':' + String(violation.line) + ' [' + violation.rule + '] ' + violation.message);
  }
  return lines.join('\n');
}

module.exports = {
  checkJsdoc: checkJsdoc,
  checkSource: checkSource,
  formatViolations: formatViolations,
};

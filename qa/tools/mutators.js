'use strict';

/**
 * @file Mutation operators. Each operator makes one small change to the source
 * code (a "mutant"); a good test suite fails for every mutant ("kills" it).
 *
 * The operators follow Stryker's mutator set for JavaScript:
 * - EqualityOperator: `===` <-> `!==`; `<` -> `<=` / `>=`; `<=` -> `<` / `>`; `>` -> `>=` / `<=`; `>=` -> `>` / `<`.
 * - LogicalOperator: `&&` <-> `||`.
 * - ArithmeticOperator: binary `+` <-> `-`, `*` <-> `/`, `%` -> `*`.
 * - AssignmentOperator: `+=` <-> `-=`, `*=` <-> `/=`.
 * - UnaryOperator: `!x` -> `x`, unary `-` <-> `+`.
 * - BooleanLiteral: `true` <-> `false`.
 * - StringLiteral: non-empty -> `''`, empty -> `'Stryker was here!'`, template -> empty template.
 * - ConditionalExpression: `if (c)` -> `if (true)` / `if (false)`; `while (c)` and `for (...; c; ...)` -> `false`.
 * - BlockStatement: non-empty `{ ... }` block -> `{}`.
 * - ArrayDeclaration: `[a, b]` -> `[]`, `[]` -> `['Stryker was here']`.
 * - ObjectLiteral: `{ a: 1 }` -> `{}`.
 * Not included: regular expression and method-call mutations.
 */

const tokenizer = require('./tokenizer.js');

/**
 * @typedef {Object} Mutant
 * @property {number} id - Sequential number, stable for unchanged source.
 * @property {string} operator - Mutation operator name.
 * @property {number} start - Offset of the replaced text.
 * @property {number} end - Offset just after the replaced text.
 * @property {string} original - The replaced text.
 * @property {string} replacement - The new text.
 * @property {number} line - 1-based line of the change.
 * @property {string} lineText - The trimmed source line of the change.
 */

/**
 * Identifiers that end an operand, so that a following `+` or `-` is binary.
 * Keywords such as `return` are not operands.
 * @type {Set<string>}
 */
const NON_OPERAND_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'of',
]);

/**
 * Tokens after which `[` starts an array literal and `{` an object literal.
 * @type {Set<string>}
 */
const LITERAL_CONTEXT = new Set(['=', '(', ',', ':', '[', 'return']);

/**
 * Tokens after which `{` starts a block statement.
 * @type {Set<string>}
 */
const BLOCK_CONTEXT = new Set([')', 'else', 'try', 'finally', 'do']);

/**
 * Replacements for comparison and equality operators.
 * @type {Object<string, Array<string>>}
 */
const EQUALITY_REPLACEMENTS = {
  '===': ['!=='],
  '!==': ['==='],
  '<': ['<=', '>='],
  '<=': ['<', '>'],
  '>': ['>=', '<='],
  '>=': ['>', '<'],
};

/**
 * Replacements for binary arithmetic operators.
 * @type {Object<string, string>}
 */
const ARITHMETIC_REPLACEMENTS = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' };

/**
 * Replacements for compound assignment operators.
 * @type {Object<string, string>}
 */
const ASSIGNMENT_REPLACEMENTS = { '+=': '-=', '-=': '+=', '*=': '/=', '/=': '*=' };

/**
 * Whether a token ends an operand (so that a following `+`/`-` is binary).
 *
 * @param {(tokenizer.Token|undefined)} token - The previous significant token.
 * @returns {boolean} True when the token ends an operand.
 */
function endsOperand(token) {
  if (token === undefined) {
    return false;
  }
  if (token.type === 'identifier') {
    return !NON_OPERAND_KEYWORDS.has(token.value);
  }
  if (token.type === 'punctuator') {
    return token.value === ')' || token.value === ']';
  }
  return true;
}

/**
 * Whether a string token is a module name in `require('...')` or the `'use strict'` directive.
 * Mutating those only produces crashes, not useful information.
 *
 * @param {Array<tokenizer.Token>} tokens - Tokens without comments.
 * @param {number} index - Index of the string token.
 * @returns {boolean} True when the string must not be mutated.
 */
function isIgnoredString(tokens, index) {
  if (index === 0) {
    return true;
  }
  return index >= 2 && tokens[index - 1].value === '(' && tokens[index - 2].value === 'require';
}

/**
 * Whether a `for (...)` header is a `for...of` / `for...in` loop.
 *
 * @param {Array<tokenizer.Token>} tokens - Tokens without comments.
 * @param {number} open - Index of `(`.
 * @param {number} close - Index of the matching `)`.
 * @returns {boolean} True for for-of and for-in loops.
 */
function isForOfOrIn(tokens, open, close) {
  let depth = 0;
  for (let index = open + 1; index < close; index += 1) {
    const value = tokens[index].value;
    if (value === '(' || value === '[' || value === '{') {
      depth += 1;
    } else if (value === ')' || value === ']' || value === '}') {
      depth -= 1;
    } else if (depth === 0 && tokens[index].type === 'identifier' && (value === 'of' || value === 'in')) {
      return true;
    }
  }
  return false;
}

/**
 * Index of the first `;` at bracket depth zero between two tokens.
 *
 * @param {Array<tokenizer.Token>} tokens - Tokens without comments.
 * @param {number} from - Index to start after.
 * @param {number} to - Index to stop before.
 * @returns {number} Index of the semicolon, or -1.
 */
function topLevelSemicolon(tokens, from, to) {
  let depth = 0;
  for (let index = from + 1; index < to; index += 1) {
    const value = tokens[index].value;
    if (value === '(' || value === '[' || value === '{') {
      depth += 1;
    } else if (value === ')' || value === ']' || value === '}') {
      depth -= 1;
    } else if (depth === 0 && value === ';') {
      return index;
    }
  }
  return -1;
}

/**
 * Create every mutant for a source file.
 *
 * @param {string} source - File contents.
 * @returns {Array<Mutant>} Mutants in source order.
 */
function generateMutants(source) {
  const tokens = tokenizer.significant(tokenizer.tokenize(source));
  const lines = source.split('\n');
  const mutants = [];

  /**
   * Record a mutant.
   *
   * @param {string} operator - Operator name.
   * @param {number} start - Offset of the replaced text.
   * @param {number} end - End offset of the replaced text.
   * @param {string} replacement - New text.
   * @param {number} line - Line of the change.
   * @returns {void}
   */
  function add(operator, start, end, replacement, line) {
    mutants.push({
      id: 0,
      operator: operator,
      start: start,
      end: end,
      original: source.slice(start, end),
      replacement: replacement,
      line: line,
      lineText: lines[line - 1].trim(),
    });
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const value = token.value;
    let previous;
    if (index > 0) {
      previous = tokens[index - 1];
    }

    if (token.type === 'punctuator') {
      if (value in EQUALITY_REPLACEMENTS) {
        for (const replacement of EQUALITY_REPLACEMENTS[value]) {
          add('EqualityOperator', token.start, token.end, replacement, token.line);
        }
      }
      if (value === '&&') {
        add('LogicalOperator', token.start, token.end, '||', token.line);
      }
      if (value === '||') {
        add('LogicalOperator', token.start, token.end, '&&', token.line);
      }
      if (value in ARITHMETIC_REPLACEMENTS && endsOperand(previous)) {
        add('ArithmeticOperator', token.start, token.end, ARITHMETIC_REPLACEMENTS[value], token.line);
      }
      if (value in ASSIGNMENT_REPLACEMENTS) {
        add('AssignmentOperator', token.start, token.end, ASSIGNMENT_REPLACEMENTS[value], token.line);
      }
      if (value === '!') {
        add('UnaryOperator', token.start, token.end, '', token.line);
      }
      if ((value === '-' || value === '+') && !endsOperand(previous)) {
        let other = '-';
        if (value === '-') {
          other = '+';
        }
        add('UnaryOperator', token.start, token.end, other, token.line);
      }
      if (value === '{' && previous !== undefined && BLOCK_CONTEXT.has(previous.value)) {
        const close = tokenizer.matchingBracket(tokens, index);
        if (close > index + 1) {
          add('BlockStatement', token.start, tokens[close].end, '{}', token.line);
        }
      }
      if (value === '{' && previous !== undefined && LITERAL_CONTEXT.has(previous.value)) {
        const close = tokenizer.matchingBracket(tokens, index);
        if (close > index + 1) {
          add('ObjectLiteral', token.start, tokens[close].end, '{}', token.line);
        }
      }
      if (value === '[' && previous !== undefined && LITERAL_CONTEXT.has(previous.value)) {
        const close = tokenizer.matchingBracket(tokens, index);
        if (close > index + 1) {
          add('ArrayDeclaration', token.start, tokens[close].end, '[]', token.line);
        } else {
          add('ArrayDeclaration', token.start, tokens[close].end, "['Stryker was here']", token.line);
        }
      }
    }

    if (token.type === 'identifier') {
      if (value === 'true') {
        add('BooleanLiteral', token.start, token.end, 'false', token.line);
      }
      if (value === 'false') {
        add('BooleanLiteral', token.start, token.end, 'true', token.line);
      }
      const next = tokens[index + 1];
      if ((value === 'if' || value === 'while' || value === 'for') && next !== undefined && next.value === '(') {
        const close = tokenizer.matchingBracket(tokens, index + 1);
        let first = index + 2;
        let last = close - 1;
        if (value === 'for') {
          if (isForOfOrIn(tokens, index + 1, close)) {
            continue;
          }
          const firstSemicolon = topLevelSemicolon(tokens, index + 1, close);
          const secondSemicolon = topLevelSemicolon(tokens, firstSemicolon, close);
          first = firstSemicolon + 1;
          last = secondSemicolon - 1;
        }
        if (last >= first) {
          const start = tokens[first].start;
          const end = tokens[last].end;
          if (value === 'if') {
            add('ConditionalExpression', start, end, 'true', tokens[first].line);
          }
          add('ConditionalExpression', start, end, 'false', tokens[first].line);
        }
      }
    }

    if (token.type === 'string' && !isIgnoredString(tokens, index)) {
      if (value.length === 2) {
        add('StringLiteral', token.start, token.end, "'Stryker was here!'", token.line);
      } else {
        add('StringLiteral', token.start, token.end, "''", token.line);
      }
    }
    if (token.type === 'template' && value.length > 2) {
      add('StringLiteral', token.start, token.end, '``', token.line);
    }
  }

  for (let index = 0; index < mutants.length; index += 1) {
    mutants[index].id = index + 1;
  }
  return mutants;
}

/**
 * Apply a mutant to the source code.
 *
 * @param {string} source - Original file contents.
 * @param {Mutant} mutant - The change.
 * @returns {string} The mutated source.
 */
function applyMutant(source, mutant) {
  return source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end);
}

module.exports = {
  applyMutant: applyMutant,
  endsOperand: endsOperand,
  generateMutants: generateMutants,
  isForOfOrIn: isForOfOrIn,
  isIgnoredString: isIgnoredString,
  topLevelSemicolon: topLevelSemicolon,
};

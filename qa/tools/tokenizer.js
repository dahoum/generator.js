'use strict';

/**
 * @file A small JavaScript tokenizer used by the style checker and the
 * mutation tester. It understands everything the project's code uses:
 * comments, strings, template literals (including nested `${}`), regular
 * expression literals, numbers, identifiers and punctuators.
 */

/**
 * Punctuators, longest first, so that `===` is matched before `==` and `=`.
 * @type {Array<string>}
 */
const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~',
  '?', ':', '=', '.', '@', '#',
];

/**
 * Keywords after which a `/` starts a regular expression rather than a division.
 * @type {Set<string>}
 */
const REGEX_AFTER_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'of',
]);

/**
 * Punctuators after which a `/` is a division (they end an operand).
 * @type {Set<string>}
 */
const DIVISION_AFTER_PUNCTUATORS = new Set([')', ']', '}']);

/**
 * @typedef {Object} Token
 * @property {string} type - One of `comment`, `string`, `template`, `regex`, `number`, `identifier`, `punctuator`.
 * @property {string} value - The exact source text of the token.
 * @property {number} start - Offset of the first character.
 * @property {number} end - Offset just after the last character.
 * @property {number} line - 1-based line number of the first character.
 */

/**
 * Create the error raised for source text the tokenizer cannot read.
 *
 * @param {string} message - What went wrong.
 * @param {number} offset - Where it went wrong.
 * @returns {Error} The error, with the offset in its message.
 */
function tokenizeError(message, offset) {
  return new Error(message + ' at offset ' + String(offset));
}

/**
 * Offsets at which each line starts.
 *
 * @param {string} source - Source text.
 * @returns {Array<number>} Start offset of line 1, line 2, ...
 */
function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/**
 * 1-based line number of an offset.
 *
 * @param {Array<number>} starts - Result of lineStarts.
 * @param {number} offset - Offset in the source.
 * @returns {number} The line number.
 */
function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
}

/**
 * Find the end of a quoted string.
 *
 * @param {string} source - Source text.
 * @param {number} start - Offset of the opening quote.
 * @returns {number} Offset just after the closing quote.
 * @throws {Error} When the string is not closed on the same line.
 */
function scanString(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) {
      return index + 1;
    }
    if (character === '\n') {
      break;
    }
    index += 1;
  }
  throw tokenizeError('Unterminated string', start);
}

/**
 * Find the end of a regular expression literal, including its flags.
 *
 * @param {string} source - Source text.
 * @param {number} start - Offset of the opening `/`.
 * @returns {number} Offset just after the last flag.
 * @throws {Error} When the literal is not closed on the same line.
 */
function scanRegex(source, start) {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '\n') {
      break;
    }
    if (character === '[') {
      inClass = true;
    } else if (character === ']') {
      inClass = false;
    } else if (character === '/' && !inClass) {
      index += 1;
      while (index < source.length && /[a-z]/.test(source[index])) {
        index += 1;
      }
      return index;
    }
    index += 1;
  }
  throw tokenizeError('Unterminated regular expression', start);
}

/**
 * Find the end of a template literal, skipping nested `${ ... }` expressions.
 *
 * @param {string} source - Source text.
 * @param {number} start - Offset of the opening backtick.
 * @returns {number} Offset just after the closing backtick.
 * @throws {Error} When the template is not closed.
 */
function scanTemplate(source, start) {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '`') {
      return index + 1;
    }
    if (character === '$' && source[index + 1] === '{') {
      index = tokenizeRange(source, index + 2, true).end + 1;
      continue;
    }
    index += 1;
  }
  throw tokenizeError('Unterminated template literal', start);
}

/**
 * Whether a `/` at the current position starts a regular expression.
 *
 * @param {(Token|null)} previous - The previous token that is not a comment, or null at the start.
 * @returns {boolean} True for a regular expression, false for a division.
 */
function slashStartsRegex(previous) {
  if (previous === null) {
    return true;
  }
  if (previous.type === 'punctuator') {
    return !DIVISION_AFTER_PUNCTUATORS.has(previous.value);
  }
  if (previous.type === 'identifier') {
    return REGEX_AFTER_KEYWORDS.has(previous.value);
  }
  return false;
}

/**
 * Tokenize source text from an offset, optionally stopping at the `}` that
 * closes a template expression.
 *
 * @param {string} source - Source text.
 * @param {number} from - Offset to start at.
 * @param {boolean} stopAtClosingBrace - Stop at an unmatched `}` (for `${}` in templates).
 * @returns {{tokens: Array<Token>, end: number}} Tokens (lines not yet assigned) and the offset where reading stopped.
 * @throws {Error} On unreadable input.
 */
function tokenizeRange(source, from, stopAtClosingBrace) {
  const tokens = [];
  let previous = null;
  let depth = 0;
  let index = from;

  /**
   * Record a token.
   *
   * @param {string} type - Token type.
   * @param {number} start - Start offset.
   * @param {number} end - End offset.
   * @returns {void}
   */
  function push(type, start, end) {
    const token = { type: type, value: source.slice(start, end), start: start, end: end, line: 0 };
    tokens.push(token);
    if (type !== 'comment') {
      previous = token;
    }
  }

  while (index < source.length) {
    const character = source[index];
    const rest = source.slice(index, index + 4);

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (rest.startsWith('//')) {
      let end = source.indexOf('\n', index);
      if (end === -1) {
        end = source.length;
      }
      push('comment', index, end);
      index = end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const close = source.indexOf('*/', index + 2);
      if (close === -1) {
        throw tokenizeError('Unterminated comment', index);
      }
      push('comment', index, close + 2);
      index = close + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const end = scanString(source, index);
      push('string', index, end);
      index = end;
      continue;
    }
    if (character === '`') {
      const end = scanTemplate(source, index);
      push('template', index, end);
      index = end;
      continue;
    }
    if (character === '/' && slashStartsRegex(previous)) {
      const end = scanRegex(source, index);
      push('regex', index, end);
      index = end;
      continue;
    }
    const number = source.slice(index).match(/^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(\.\d*)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)n?/);
    if (number !== null) {
      push('number', index, index + number[0].length);
      index += number[0].length;
      continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/);
    if (identifier !== null) {
      push('identifier', index, index + identifier[0].length);
      index += identifier[0].length;
      continue;
    }
    let matched = '';
    for (const punctuator of PUNCTUATORS) {
      if (source.startsWith(punctuator, index)) {
        matched = punctuator;
        break;
      }
    }
    if (matched === '') {
      throw tokenizeError('Unexpected character ' + JSON.stringify(character), index);
    }
    if (matched === '{') {
      depth += 1;
    } else if (matched === '}') {
      if (depth === 0 && stopAtClosingBrace) {
        return { tokens: tokens, end: index };
      }
      depth -= 1;
    }
    push('punctuator', index, index + matched.length);
    index += matched.length;
  }
  if (stopAtClosingBrace) {
    throw tokenizeError('Unterminated template expression', from);
  }
  return { tokens: tokens, end: index };
}

/**
 * Split JavaScript source text into tokens. Whitespace is dropped; comments are kept.
 *
 * @param {string} source - Source text.
 * @returns {Array<Token>} Tokens in source order, with line numbers.
 * @throws {Error} On unreadable input.
 */
function tokenize(source) {
  const starts = lineStarts(source);
  const tokens = tokenizeRange(source, 0, false).tokens;
  for (const token of tokens) {
    token.line = lineOf(starts, token.start);
  }
  return tokens;
}

/**
 * The tokens that are not comments.
 *
 * @param {Array<Token>} tokens - Result of tokenize.
 * @returns {Array<Token>} Tokens without comments.
 */
function significant(tokens) {
  const result = [];
  for (const token of tokens) {
    if (token.type !== 'comment') {
      result.push(token);
    }
  }
  return result;
}

/**
 * Index of the bracket that closes the one at `openIndex`.
 *
 * @param {Array<Token>} tokens - Tokens without comments.
 * @param {number} openIndex - Index of `(`, `[` or `{`.
 * @returns {number} Index of the matching closing bracket, or -1 if there is none.
 */
function matchingBracket(tokens, openIndex) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const open = tokens[openIndex].value;
  const close = pairs[open];
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (tokens[index].type === 'punctuator' && value === open) {
      depth += 1;
    } else if (tokens[index].type === 'punctuator' && value === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

module.exports = {
  lineOf: lineOf,
  lineStarts: lineStarts,
  matchingBracket: matchingBracket,
  significant: significant,
  slashStartsRegex: slashStartsRegex,
  tokenize: tokenize,
};

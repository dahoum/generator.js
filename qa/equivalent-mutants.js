'use strict';

/**
 * @file Mutants that survive because they do not change the generator's
 * behaviour ("equivalent mutants"). No test can kill them, so each one is
 * listed here with the reason. The mutation tester fails on any survivor that
 * is not listed, and on any entry here that no longer survives.
 *
 * Each entry identifies a mutant by its operator, the original and replacement
 * text and the trimmed source line, so entries survive changes elsewhere in the file.
 *
 * @type {Array<{operator: string, original: string, replacement: string, lineText: string, reason: string}>}
 */
module.exports = [];

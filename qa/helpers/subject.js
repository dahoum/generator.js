'use strict';

/**
 * @file Loads the generator under test. The mutation tester points
 * GENERATOR_UNDER_TEST at a mutated copy; otherwise the real generator.js is used.
 */

const path = require('path');

/**
 * Path of the generator module to test.
 *
 * @returns {string} GENERATOR_UNDER_TEST when set, otherwise the repository's generator.js.
 */
function subjectPath() {
  const fromEnvironment = process.env.GENERATOR_UNDER_TEST;
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    return fromEnvironment;
  }
  return path.join(__dirname, '..', '..', 'generator.js');
}

module.exports = {
  generator: require(subjectPath()),
  subjectPath: subjectPath,
};

'use strict';

/**
 * @file Mutation tester for generator.js, in plain JavaScript without dependencies.
 *
 * For every mutant (see mutators.js) the unit tests in qa/unit/ are run
 * against a mutated copy of generator.js. A mutant is "killed" when the tests
 * fail and "survives" when they still pass. Every surviving mutant shows a
 * change the tests do not notice; it must either get a test or be listed in
 * qa/equivalent-mutants.js with the reason why no test can tell it apart.
 *
 * Usage:
 *   node qa/tools/mutation.js            run all mutants
 *   node qa/tools/mutation.js --rerun    only the survivors of the previous run
 *   node qa/tools/mutation.js --lines 100-200   only mutants on these lines
 *
 * Mutants run in a scratch directory with HOME and the working directory
 * pointing there, so a mutant that breaks a safety check cannot touch real files.
 * Exit code 0 when every mutant is killed or explained, 1 otherwise.
 */

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const mutators = require('./mutators.js');
const equivalentMutants = require('../equivalent-mutants.js');

/**
 * Repository root.
 * @type {string}
 */
const ROOT = path.join(__dirname, '..', '..');

/**
 * The file under test.
 * @type {string}
 */
const SUBJECT = path.join(ROOT, 'generator.js');

/**
 * Where the results of the last run are kept (for --rerun). Not committed.
 * @type {string}
 */
const REPORT_FILE = path.join(ROOT, 'qa', '.mutation-report.json');

/**
 * Longest time one test run may take before the mutant counts as killed by timeout.
 * @type {number}
 */
const TIMEOUT_MILLISECONDS = 60000;

/**
 * @typedef {Object} RunOptions
 * @property {boolean} rerun - Only run the survivors of the previous run.
 * @property {number} firstLine - Lowest line to mutate.
 * @property {number} lastLine - Highest line to mutate.
 */

/**
 * @typedef {Object} MutantResult
 * @property {mutators.Mutant} mutant - The mutant.
 * @property {string} status - `killed`, `timeout` or `survived`.
 */

/**
 * Key that identifies a mutant independently of line numbers.
 *
 * @param {{operator: string, original: string, replacement: string, lineText: string}} mutant - Mutant or allowlist entry.
 * @returns {string} The key.
 */
function mutantKey(mutant) {
  return [mutant.operator, mutant.original, mutant.replacement, mutant.lineText].join('\u0000');
}

/**
 * Parse command line arguments.
 *
 * @param {Array<string>} argv - Arguments after the script name.
 * @returns {RunOptions} Options.
 * @throws {Error} For unknown arguments.
 */
function parseArguments(argv) {
  const options = { rerun: false, firstLine: 1, lastLine: Infinity };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--rerun') {
      options.rerun = true;
    } else if (argv[index] === '--lines') {
      const range = argv[index + 1].split('-');
      options.firstLine = Number(range[0]);
      options.lastLine = Number(range[1]);
      index += 1;
    } else {
      throw new Error('Unknown argument ' + argv[index]);
    }
  }
  return options;
}

/**
 * Unit test files that run against each mutant.
 *
 * @returns {Array<string>} Absolute paths, sorted.
 */
function unitTestFiles() {
  const directory = path.join(ROOT, 'qa', 'unit');
  const files = [];
  for (const name of fs.readdirSync(directory).sort()) {
    if (name.endsWith('.test.js')) {
      files.push(path.join(directory, name));
    }
  }
  return files;
}

/**
 * Run the unit tests against one version of generator.js.
 *
 * @param {string} subjectFile - The generator file to test.
 * @param {string} sandbox - Scratch directory used as working and home directory.
 * @param {Array<string>} testFiles - Test files.
 * @returns {Promise<string>} `passed`, `failed` or `timeout`.
 */
function runTests(subjectFile, sandbox, testFiles) {
  /**
   * Start the test process and resolve when it ends.
   *
   * @param {function(string): void} resolve - Receives the outcome.
   * @returns {void}
   */
  function start(resolve) {
    const environment = Object.assign({}, process.env, {
      GENERATOR_UNDER_TEST: subjectFile,
      HOME: sandbox,
      USERPROFILE: sandbox,
    });
    const child = childProcess.spawn(process.execPath, ['--test', '--test-reporter=dot'].concat(testFiles), {
      cwd: sandbox,
      env: environment,
      stdio: 'ignore',
    });
    let timedOut = false;
    const timer = setTimeout(stopChild, TIMEOUT_MILLISECONDS);

    /**
     * Kill a test run that takes too long (for example an endless loop).
     *
     * @returns {void}
     */
    function stopChild() {
      timedOut = true;
      child.kill('SIGKILL');
    }

    /**
     * Report the outcome when the process exits.
     *
     * @param {(number|null)} code - Exit code.
     * @returns {void}
     */
    function finished(code) {
      clearTimeout(timer);
      if (timedOut) {
        resolve('timeout');
      } else if (code === 0) {
        resolve('passed');
      } else {
        resolve('failed');
      }
    }

    child.on('exit', finished);
  }

  return new Promise(start);
}

/**
 * Run one mutant in its own sandbox.
 *
 * @param {string} source - Original generator source.
 * @param {mutators.Mutant} mutant - The mutant.
 * @param {string} workRoot - Directory for sandboxes.
 * @param {Array<string>} testFiles - Test files.
 * @returns {Promise<MutantResult>} The outcome.
 */
async function runMutant(source, mutant, workRoot, testFiles) {
  const sandbox = path.join(workRoot, 'mutant-' + String(mutant.id));
  fs.mkdirSync(sandbox, { recursive: true });
  const subjectFile = path.join(sandbox, 'generator.js');
  fs.writeFileSync(subjectFile, mutators.applyMutant(source, mutant));
  const outcome = await runTests(subjectFile, sandbox, testFiles);
  fs.rmSync(sandbox, { recursive: true, force: true });
  let status = 'killed';
  if (outcome === 'passed') {
    status = 'survived';
  } else if (outcome === 'timeout') {
    status = 'timeout';
  }
  return { mutant: mutant, status: status };
}

/**
 * Run tasks with limited parallelism.
 *
 * @param {Array<mutators.Mutant>} mutants - Mutants to run.
 * @param {number} parallel - Number of simultaneous test runs.
 * @param {function(mutators.Mutant): Promise<MutantResult>} run - Runs one mutant.
 * @returns {Promise<Array<MutantResult>>} Results in the order of `mutants`.
 */
async function runPool(mutants, parallel, run) {
  const results = new Array(mutants.length);
  let nextIndex = 0;

  /**
   * Take mutants from the queue until it is empty.
   *
   * @returns {Promise<void>} Resolves when the queue is empty.
   */
  async function worker() {
    while (nextIndex < mutants.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await run(mutants[index]);
      let mark = '.';
      if (results[index].status === 'survived') {
        mark = 'S';
      } else if (results[index].status === 'timeout') {
        mark = 'T';
      }
      process.stdout.write(mark);
    }
  }

  const workers = [];
  for (let count = 0; count < parallel; count += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  process.stdout.write('\n');
  return results;
}

/**
 * Select the mutants for this run.
 *
 * @param {Array<mutators.Mutant>} mutants - All mutants.
 * @param {RunOptions} options - Command line options.
 * @returns {Array<mutators.Mutant>} The mutants to run.
 */
function selectMutants(mutants, options) {
  let previousSurvivors = null;
  if (options.rerun) {
    previousSurvivors = new Set(JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')).survivors);
  }
  const selected = [];
  for (const mutant of mutants) {
    if (mutant.line < options.firstLine || mutant.line > options.lastLine) {
      continue;
    }
    if (previousSurvivors !== null && !previousSurvivors.has(mutantKey(mutant))) {
      continue;
    }
    selected.push(mutant);
  }
  return selected;
}

/**
 * Describe a mutant for the report.
 *
 * @param {mutators.Mutant} mutant - The mutant.
 * @returns {string} One line.
 */
function describe(mutant) {
  return 'generator.js:' + String(mutant.line) + ' ' + mutant.operator + ': ' + JSON.stringify(mutant.original) +
    ' -> ' + JSON.stringify(mutant.replacement) + '\n    ' + mutant.lineText;
}

/**
 * Run the mutation test.
 *
 * @param {Array<string>} argv - Command line arguments after the script name.
 * @returns {Promise<number>} Exit code.
 */
async function main(argv) {
  const options = parseArguments(argv);
  const source = fs.readFileSync(SUBJECT, 'utf8');
  const testFiles = unitTestFiles();
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'generator-mutation-'));

  const baselineSandbox = path.join(workRoot, 'baseline');
  fs.mkdirSync(baselineSandbox);
  const baseline = await runTests(SUBJECT, baselineSandbox, testFiles);
  if (baseline !== 'passed') {
    process.stdout.write('The unit tests fail without any mutation; fix them first.\n');
    return 1;
  }

  const valid = [];
  let invalid = 0;
  for (const mutant of mutators.generateMutants(source)) {
    try {
      new vm.Script(mutators.applyMutant(source, mutant), { filename: 'mutant.js' });
      valid.push(mutant);
    } catch (error) {
      invalid += 1;
    }
  }
  const selected = selectMutants(valid, options);
  const parallel = Math.max(1, os.cpus().length);
  process.stdout.write('Running ' + String(selected.length) + ' mutants (' + String(invalid) + ' skipped as invalid syntax), ' + String(parallel) + ' at a time.\n');

  /**
   * Run one mutant.
   *
   * @param {mutators.Mutant} mutant - The mutant.
   * @returns {Promise<MutantResult>} The outcome.
   */
  function run(mutant) {
    return runMutant(source, mutant, workRoot, testFiles);
  }

  const results = await runPool(selected, parallel, run);
  fs.rmSync(workRoot, { recursive: true, force: true });

  const allowed = new Map();
  for (const entry of equivalentMutants) {
    allowed.set(mutantKey(entry), entry);
  }
  const used = new Set();
  const survivors = [];
  const unexplained = [];
  let killed = 0;
  for (const result of results) {
    if (result.status !== 'survived') {
      killed += 1;
      continue;
    }
    const key = mutantKey(result.mutant);
    survivors.push(key);
    if (allowed.has(key)) {
      used.add(key);
    } else {
      unexplained.push(result.mutant);
    }
  }

  fs.writeFileSync(REPORT_FILE, JSON.stringify({ survivors: survivors }, null, 2) + '\n');

  const explained = survivors.length - unexplained.length;
  let score = 100;
  if (results.length > 0) {
    score = Math.floor(((killed + explained) / results.length) * 10000) / 100;
  }
  process.stdout.write(
    'Killed: ' + String(killed) + ', survived: ' + String(survivors.length) +
      ' (' + String(explained) + ' documented as equivalent), mutation score: ' + String(score) + '%\n'
  );
  for (const mutant of unexplained) {
    process.stdout.write('SURVIVED ' + describe(mutant) + '\n');
  }

  let stale = 0;
  if (!options.rerun && options.firstLine === 1 && options.lastLine === Infinity) {
    for (const entry of equivalentMutants) {
      if (!used.has(mutantKey(entry))) {
        stale += 1;
        process.stdout.write('STALE equivalent-mutants entry (no longer survives or no longer exists): ' + entry.lineText + '\n');
      }
    }
  }

  if (unexplained.length > 0 || stale > 0) {
    return 1;
  }
  return 0;
}

/**
 * Set the exit code once main has finished.
 *
 * @param {number} code - Exit code.
 * @returns {void}
 */
function exitWith(code) {
  process.exitCode = code;
}

/**
 * Report an unexpected error and exit with code 1.
 *
 * @param {Error} error - The error.
 * @returns {void}
 */
function crash(error) {
  process.stderr.write(String(error.stack) + '\n');
  process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(exitWith, crash);
}

module.exports = {
  mutantKey: mutantKey,
  parseArguments: parseArguments,
  selectMutants: selectMutants,
};

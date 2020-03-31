import { CliServiceProvider, NodeOptions } from '@mongosh/service-provider-server';
import { changeHistory } from '@mongosh/history';
import formatOutput from './format-output';
import repl, { REPLServer } from 'repl';
import CliOptions from './cli-options';
import Mapper from '@mongosh/mapper';
import completer from './completer';
import i18n from '@mongosh/i18n';
import Nanobus from 'nanobus';
import logger from './logger';
import mkdirp from 'mkdirp';
import path from 'path';
import util from 'util';
import read from 'read';
import os from 'os';

/**
 * Connecting text key.
 */
const CONNECTING = 'cli-repl.cli-repl.connecting';

/**
 * The REPL used from the terminal.
 */
class CliRepl {
  readonly useAsync?: boolean;
  private serviceProvider: CliServiceProvider;
  private mapper: Mapper;
  private mdbVersion: any;
  private repl: REPLServer;
  private bus: Nanobus;
  private options: CliOptions;
  private mongoshDir: string;

  /**
   * Connect to the cluster.
   *
   * @param {string} driverUrl - The driver URI.
   * @param {NodeOptions} driverOptions - The driver options.
   */
  async connect(driverUri: string, driverOptions: NodeOptions): Promise<void> {
    console.log(i18n.__(CONNECTING), driverUri);
    this.bus.emit('connect', driverUri);

    this.serviceProvider = await CliServiceProvider.connect(driverUri, driverOptions);
    this.mapper = new Mapper(this.serviceProvider, this.bus);
    this.mdbVersion = await this.serviceProvider.getServerVersion();
    this.start();
  }

  /**
   * Instantiate the new CLI Repl.
   */
  constructor(driverUri: string, driverOptions: NodeOptions, options: CliOptions) {
    this.useAsync = !!options.async;
    console.log(`cli-repl async=${this.useAsync}`);
    this.options = options;
    this.mongoshDir = '.mongodb/mongosh/';

    this.createMongoshDir();

    this.bus = new Nanobus('mongosh');
    const log = logger(this.bus, this.mongoshDir);

    if (this.isPasswordMissing(driverOptions)) {
      this.requirePassword(driverUri, driverOptions);
    } else {
      this.connect(driverUri, driverOptions);
    }
  }
  /**
   * Returns true if a value is a shell api type
   *
   * @param {any} evaluationResult - The result of evaluation
   */
  private isShellApiType(evaluationResult: any): boolean {
    return evaluationResult &&
      typeof evaluationResult.shellApiType === 'function' &&
      typeof evaluationResult.toReplString === 'function'
  }

  /**
   * The custom evaluation function. Evaluates the provided input and further
   * resolves the the result with
   *
   * @param {} originalEval - The original eval function.
   * @param {} input - The input.
   * @param {} context - The context.
   * @param {} filename - The filename.
   */
  async evaluateAndResolveApiType(originalEval: any, input: string, context: any, filename: string) {
    const evaluationResult = await this.evaluate(
      originalEval,
      input,
      context,
      filename
    )

    if (this.isShellApiType(evaluationResult)) {
      return {
        type: evaluationResult.shellApiType(),
        value: await evaluationResult.toReplString()
      };
    }

    return {
      value: evaluationResult
    };
  }

  /**
   * Format the result to a string so it can be written to the output stream.
   */
  writer = (result: any): string => {
    // This checks for error instances.
    // The writer gets called immediately by the internal `this.repl.eval`
    // in case of errors.
    if (result && result.message && typeof result.stack === 'string') {
      this.bus.emit('error', result);
      return formatOutput({type: 'Error', value: result});
    }

    return formatOutput(result);
  }

  /**
   * Evaluates the provided input
   */
  async evaluate(originalEval: any, input: string, context: any, filename: string) {
    const argv = input.trim().split(' ');
    const cmd = argv[0];
    argv.shift();
    switch(cmd) {
      case 'use':
        return this.repl.context.use(argv[0]);
      case 'show':
        return this.repl.context.show(argv[0]);
      case 'it':
        return this.repl.context.it();
      case 'help':
        this.bus.emit('cmd:help')
        return this.repl.context.help();
      case 'var':
        this.mapper.cursorAssigned = true;
      default:
        return originalEval(input, context, filename);
    }
  }

  /** 
  * Creaates a directory to store all mongosh logs & history
  */
  createMongoshDir(): void {
    try {
      mkdirp.sync(path.join(os.homedir(), this.mongoshDir));
    } catch(e) {
      this.bus.emit('error', e)
      throw e;
    }
  }

  /**
   * The greeting for the shell.
   */
  greet(): void {
    console.log(`Using MongoDB: ${this.mdbVersion} \n`);
  }

  /**
   * Is the password missing from the options?
   *
   * @param {NodeOptions} driverOptions - The driver options.
   *
   * @returns {boolean} If the password is missing.
   */
  isPasswordMissing(driverOptions: NodeOptions): boolean {
    return driverOptions.auth &&
      driverOptions.auth.user &&
      !driverOptions.auth.password
  }

  /**
   * Require the user to enter a password.
   *
   * @param {string} driverUrl - The driver URI.
   * @param {NodeOptions} driverOptions - The driver options.
   */
  requirePassword(driverUri: string, driverOptions: NodeOptions): void {
    const readOptions = {
      prompt: 'Enter password: ',
      silent: true,
      replace: '*'
    };
    read(readOptions, (error, password) => {
      driverOptions.auth.password = password;
      this.connect(driverUri, driverOptions);
    });
  }

  /**
   * Start the REPL.
   */
  start(): void {
    this.greet();

    const version = this.mdbVersion;
    const bus = this.bus;

    this.repl = repl.start({
      prompt: `$ mongosh > `,
      ignoreUndefined: true,
      writer: this.writer,
      completer: completer.bind(null, version),
    });

    const originalEval = util.promisify(this.repl.eval);

    const customEval = async(input, context, filename, callback) => {
      try {
        let str;
        if (this.useAsync) {
          const syncStr = this.mapper.asyncWriter.compile(input);
          console.log(`DEBUG: rewrote input "${input.trim()}" to "${syncStr.trim()}"`);
          str = await this.evaluateAndResolveApiType(originalEval, syncStr, context, filename);
        } else {
          str = await this.evaluateAndResolveApiType(originalEval, input, context, filename);
        }
        callback(null, str);
      } catch (err) {
        callback(err, null);
      } finally {
        this.mapper.cursorAssigned = false;
      }
    };

    // @ts-ignore
    this.repl.eval = customEval;

    const historyFile = path.join(os.homedir(), this.mongoshDir,  '.mongosh_repl_history');
    const redactInfo = this.options.redactInfo;
    this.repl.setupHistory(historyFile, function(err, repl) {
      // TODO: @lrlna format this error
      if (err) console.log(err);

      // repl.history is an array of previous commands. We need to hijack the
      // value we just typed, and shift it off the history array if the info is
      // sensitive.
      repl.on('flushHistory', function() {
        // @ts-ignore
        changeHistory(repl.history, redactInfo);
      })
    })

    this.repl.on('exit', () => {
      this.serviceProvider.close(true);
      process.exit();
    });

    this.mapper.setCtx(this.repl.context);
  }
}

export default CliRepl;

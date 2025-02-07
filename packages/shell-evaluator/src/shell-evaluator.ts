import type { ShellInstanceState } from '@mongosh/shell-api';
import {
  toShellResult,
  ShellResult,
  EvaluationListener,
} from '@mongosh/shell-api';
import AsyncWriter from '@mongosh/async-rewriter2';

type EvaluationFunction = (
  input: string,
  context: object,
  filename: string
) => Promise<any>;

import { HIDDEN_COMMANDS, redactSensitiveData } from '@mongosh/history';
import { TimingCategories, type TimingCategory } from '@mongosh/types';

let hasAlreadyRunGlobalRuntimeSupportEval = false;
// `v8.startupSnapshot` is currently untyped, might as well use `any`.
let v8: any;
try {
  v8 = require('v8');
} catch {
  /* not Node.js */
}
if (v8?.startupSnapshot?.isBuildingSnapshot?.()) {
  v8.startupSnapshot.addSerializeCallback(() => {
    // Ensure that any lazy loading performed by Babel is part of the snapshot
    eval(new AsyncWriter().runtimeSupportCode());
    eval(new AsyncWriter().process('1+1'));
    hasAlreadyRunGlobalRuntimeSupportEval = true;
  });
}

type ResultHandler<EvaluationResultType> = (
  value: any
) => EvaluationResultType | Promise<EvaluationResultType>;
class ShellEvaluator<EvaluationResultType = ShellResult> {
  private instanceState: ShellInstanceState;
  private resultHandler: ResultHandler<EvaluationResultType>;
  private hasAppliedAsyncWriterRuntimeSupport = true;
  private asyncWriter: AsyncWriter;
  private markTime?: (category: TimingCategory, label: string) => void;

  constructor(
    instanceState: ShellInstanceState,
    resultHandler: ResultHandler<EvaluationResultType> = toShellResult as any,
    markTime?: (category: TimingCategory, label: string) => void
  ) {
    this.instanceState = instanceState;
    this.resultHandler = resultHandler;
    this.asyncWriter = new AsyncWriter();
    this.hasAppliedAsyncWriterRuntimeSupport = false;
    this.markTime = markTime;
  }

  /**
   * Checks for linux-style commands then evaluates input using originalEval.
   *
   * @param {function} originalEval - the javascript evaluator.
   * @param {String} input - user input.
   * @param {Context} context - the execution context.
   * @param {String} filename
   */
  private async innerEval(
    originalEval: EvaluationFunction,
    input: string,
    context: object,
    filename: string
  ): Promise<any> {
    const { shellApi } = this.instanceState;
    const trimmedInput = input.trim();
    const argv = trimmedInput.replace(/;$/, '').split(/\s+/g);
    const cmd = argv.shift() as keyof typeof shellApi;

    if (
      shellApi[cmd]?.isDirectShellCommand &&
      shellApi[cmd]?.acceptsRawInput &&
      !(argv[0] ?? '').startsWith('(')
    ) {
      const rawArg = trimmedInput.replace(/^\S+\s*/, '');
      return shellApi[cmd](rawArg);
    }

    if (
      shellApi[cmd]?.isDirectShellCommand &&
      !(argv[0] ?? '').startsWith('(')
    ) {
      return shellApi[cmd](...argv);
    }

    this.markTime?.(TimingCategories.AsyncRewrite, 'start async rewrite');
    let rewrittenInput = this.asyncWriter.process(input);
    this.markTime?.(TimingCategories.AsyncRewrite, 'done async rewrite');

    const hiddenCommands = RegExp(HIDDEN_COMMANDS, 'g');
    if (!hiddenCommands.test(input) && !hiddenCommands.test(rewrittenInput)) {
      this.instanceState.messageBus.emit('mongosh:evaluate-input', {
        input: redactSensitiveData(trimmedInput),
      });
    }

    if (!this.hasAppliedAsyncWriterRuntimeSupport) {
      this.hasAppliedAsyncWriterRuntimeSupport = true;
      this.markTime?.(
        TimingCategories.AsyncRewrite,
        'start runtimeSupportCode processing'
      );
      const supportCode = this.asyncWriter.runtimeSupportCode();
      // Eval twice: We need the modified prototypes to be present in both
      // the evaluation context and the current one, because e.g. the value of
      // db.test.find().toArray() is a Promise for an Array from the context
      // in which the shell-api package lives and not from the context inside
      // the REPL (i.e. `db.test.find().toArray() instanceof Array` is `false`).
      if (!hasAlreadyRunGlobalRuntimeSupportEval) {
        eval(supportCode);
      }
      this.markTime?.(
        TimingCategories.AsyncRewrite,
        'done global runtimeSupportCode processing'
      );
      rewrittenInput = supportCode + ';\n' + rewrittenInput;
    }

    try {
      this.markTime?.(
        TimingCategories.Eval,
        'started evaluating processed code'
      );
      return await originalEval(rewrittenInput, context, filename);
    } catch (err: any) {
      throw this.instanceState.transformError(err);
    } finally {
      this.markTime?.(
        TimingCategories.Eval,
        'finished evaluating processed code'
      );
    }
  }

  /**
   * Evaluates the input code and wraps the result with the type
   *
   * @param {function} originalEval - the javascript evaluator.
   * @param {String} input - user input.
   * @param {Context} context - the execution context.
   * @param {String} filename
   */
  public async customEval(
    originalEval: EvaluationFunction,
    input: string,
    context: object,
    filename: string
  ): Promise<EvaluationResultType> {
    const evaluationResult = await this.innerEval(
      originalEval,
      input,
      context,
      filename
    );

    return await this.resultHandler(evaluationResult);
  }
}

export { ShellResult, ShellEvaluator, EvaluationListener };

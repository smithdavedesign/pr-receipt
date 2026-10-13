// Runs this repository's action.yml the way a GitHub runner runs a composite action, so the Action's real
// steps are tested, not a copy of them: inputs get their defaults, the `${{ }}` expressions the file uses are
// evaluated from a small context (any other expression fails the test), `uses:` steps are skipped (this
// machine already has Node), and each `run:` step goes to bash with its env, like
// `bash --noprofile --norc -eo pipefail {0}` on a runner.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ACTION_FILE = join(ROOT, 'action.yml');

export interface ActionStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  shell?: string;
  env?: Record<string, unknown>;
  'working-directory'?: string;
  if?: string;
}

export interface ActionDefinition {
  name: string;
  description: string;
  inputs: Record<string, { description?: string; required?: boolean; default?: string }>;
  runs: { using: string; steps: ActionStep[] };
}

export function loadAction(file = ACTION_FILE): ActionDefinition {
  return parse(readFileSync(file, 'utf8')) as ActionDefinition;
}

export interface ActionContext {
  /** The checked-out repository (GITHUB_WORKSPACE). */
  workspace: string;
  /** github.event.pull_request.number; leave out for an event without a pull request (e.g. push). */
  prNumber?: number;
  /** github.head_ref. */
  headRef?: string;
  /** owner/repo. Default: acme/shop, the fake gh's repository. */
  repository?: string;
  /** github.token. */
  token: string;
  /** Inputs given with `with:` in the workflow. */
  inputs?: Record<string, string>;
  /** Put first on PATH (the fake gh). */
  binDir: string;
  /** Extra environment for every step (the fake gh's state file). */
  env?: Record<string, string>;
  home: string;
}

export interface ActionResult {
  /** The failing step's exit code, or 0. */
  code: number;
  stdout: string;
  stderr: string;
  /** `uses:` of the steps that were skipped. */
  skipped: string[];
}

const EXPRESSION = /\$\{\{\s*(.*?)\s*\}\}/g;

function evaluate(text: string, values: Record<string, string>): string {
  return text.replace(EXPRESSION, (_, expr: string) => {
    if (!Object.hasOwn(values, expr)) throw new Error(`action-runner: action.yml uses \${{ ${expr} }}, which this runner doesn't model`);
    return values[expr];
  });
}

export function runAction(ctx: ActionContext, action = loadAction()): ActionResult {
  if (action.runs?.using !== 'composite') throw new Error('action-runner: only composite actions are supported');
  const github: Record<string, string> = {
    'github.token': ctx.token,
    'github.repository': ctx.repository ?? 'acme/shop',
    'github.workspace': ctx.workspace,
    'github.event.pull_request.number': ctx.prNumber === undefined ? '' : String(ctx.prNumber),
    'github.head_ref': ctx.headRef ?? '',
  };
  const values: Record<string, string> = { ...github };
  for (const name of Object.keys(ctx.inputs ?? {})) {
    if (!Object.hasOwn(action.inputs ?? {}, name)) throw new Error(`action-runner: unexpected input ${name}`);
  }
  for (const [name, input] of Object.entries(action.inputs ?? {})) {
    const given = ctx.inputs?.[name];
    if (given === undefined && input.required && input.default === undefined) throw new Error(`action-runner: input ${name} is required`);
    values[`inputs.${name}`] = given ?? evaluate(String(input.default ?? ''), github);
  }

  const baseEnv: Record<string, string> = {
    PATH: `${ctx.binDir}:${process.env.PATH ?? ''}`,
    HOME: ctx.home,
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_ACTION_PATH: ROOT,
    GITHUB_WORKSPACE: ctx.workspace,
    GITHUB_REPOSITORY: github['github.repository'],
    GITHUB_EVENT_NAME: ctx.prNumber === undefined ? 'push' : 'pull_request',
    GITHUB_HEAD_REF: ctx.headRef ?? '',
    ...ctx.env,
  };
  const result: ActionResult = { code: 0, stdout: '', stderr: '', skipped: [] };
  for (const step of action.runs.steps) {
    if (step.if !== undefined) throw new Error('action-runner: `if:` on a step is not modelled');
    if (step.uses !== undefined) {
      result.skipped.push(step.uses);
      continue;
    }
    if (step.run === undefined) throw new Error('action-runner: a step needs `uses` or `run`');
    if (step.shell !== 'bash') throw new Error('action-runner: composite run steps must say `shell: bash`');
    const env = { ...baseEnv };
    for (const [key, value] of Object.entries(step.env ?? {})) env[key] = evaluate(String(value), values);
    const cwd = step['working-directory'] === undefined ? ctx.workspace : evaluate(step['working-directory'], values);
    const out = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', evaluate(step.run, values)], { cwd, env, encoding: 'utf8' });
    result.stdout += out.stdout;
    result.stderr += out.stderr;
    if (out.status !== 0) {
      result.code = out.status ?? 1;
      return result;
    }
  }
  return result;
}

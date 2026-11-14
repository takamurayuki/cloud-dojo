/**
 * 直し回12（推奨B）：CI/CD の real 実行で、許可された実コマンドの実行が失敗したら、模擬（simulate）の成功結果に
 * 置き換えずにステップ・ジョブを失敗にする。模擬は simulation モードを選んだときだけ。
 * child_process はスタブに差し替える（実際のコマンドは実行しない）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => {
  const calls: { file: string; args: string[] }[] = [];
  /** コマンド名 → 実行時に返す失敗 */
  const failures = new Map<string, () => Error>();
  const run = (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ file, args });
    const f = failures.get(file);
    if (f) return Promise.reject(f());
    return Promise.resolve({ stdout: `ran ${file} ${args.join(' ')}\n`, stderr: '' });
  };
  const execFile = (file: string, args: string[], _opts: unknown, cb: (e: unknown, o: string, s: string) => void) => {
    run(file, args).then(
      (r) => cb(null, r.stdout, r.stderr),
      (e) => cb(e, '', ''),
    );
  };
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: (file: string, args: string[]) => run(file, args) });
  const exec = (_cmd: string, ...rest: unknown[]) => {
    const cb = rest.find((r) => typeof r === 'function') as ((e: unknown, o: unknown, s: unknown) => void) | undefined;
    cb?.(null, '', '');
  };
  return { calls, failures, execFile, exec };
});

vi.mock('child_process', () => ({ exec: cp.exec, execFile: cp.execFile, default: { exec: cp.exec, execFile: cp.execFile } }));

const { CICDService } = await import('../services/cicd');
type WorkflowRun = import('../services/cicd').WorkflowRun;

async function runWith(lines: string[], mode: 'real' | 'simulation') {
  const svc = new CICDService();
  (svc as unknown as { sleep: () => Promise<void> }).sleep = async () => undefined;
  const done = new Promise<WorkflowRun>((resolve) => svc.on('run:completed', resolve));
  await svc.runWorkflow(
    { name: 'wf', on: { workflow_dispatch: {} }, jobs: { build: { name: 'build', 'runs-on': 'ubuntu-latest', steps: [{ name: 's', run: lines.join('\n') }] } } },
    'manual',
    'main',
    mode,
  );
  return done;
}

const enoent = (file: string) => () => Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT', errno: -2, syscall: `spawn ${file}` });

describe('直し回12 推奨B：real 実行の失敗を模擬結果で置き換えない', () => {
  beforeEach(() => {
    cp.calls.length = 0;
    cp.failures.clear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('許可コマンドの実行が ENOENT で失敗：ステップ・ジョブは failure、模擬の出力は出ず、失敗理由が残る', async () => {
    cp.failures.set('node', enoent('node'));
    const run = await runWith(['node --version'], 'real');
    expect(cp.calls).toEqual([{ file: 'node', args: ['--version'] }]);
    const step = run.jobs[0].steps[0];
    expect(step.conclusion).toBe('failure');
    expect(run.jobs[0].conclusion).toBe('failure');
    const out = step.output.join('\n');
    expect(out).toMatch(/real 実行したコマンド（node --version）が失敗しました（spawn node ENOENT／code ENOENT）。模擬結果には置き換えません/);
    // 模擬のときに出る node のバージョン表示（generateMockOutput）が出ていない
    expect(out).not.toMatch(/^v\d+\.\d+/m);
  });

  it('終了コードが0以外（stderr あり）でも失敗になり、後続の行は実行しない', async () => {
    cp.failures.set('ls', () => Object.assign(new Error('Command failed: ls -la src'), { code: 2, stderr: "ls: cannot access 'src': No such file or directory\n" }));
    const run = await runWith(['ls -la src', 'echo never'], 'real');
    expect(run.jobs[0].conclusion).toBe('failure');
    expect(run.jobs[0].steps[0].output.join('\n')).toMatch(/code 2／stderr: ls: cannot access 'src'/);
    expect(cp.calls).toEqual([{ file: 'ls', args: ['-la', 'src'] }]);
  });

  it('実行が成功すれば従来どおり実際の出力で success', async () => {
    const run = await runWith(['node --version'], 'real');
    expect(run.jobs[0].conclusion).toBe('success');
    expect(run.jobs[0].steps[0].output).toContain('ran node --version');
  });

  it('simulation モードは従来どおり模擬（実行しない・失敗の設定に関係なく success）', async () => {
    cp.failures.set('node', enoent('node'));
    const run = await runWith(['node --version'], 'simulation');
    expect(run.conclusion).toBe('success');
    expect(cp.calls).toEqual([]);
  });
});

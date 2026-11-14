/**
 * 直し回13（必須）：CI/CD でジョブが1つでも失敗したら run の結論を failure にする（全ジョブ成功のときだけ success）。
 * 失敗（またはスキップ）したジョブに依存するジョブは実行せず、結論 skipped・理由つきで run に記録する。
 * 成功・失敗・スキップの内訳は run.summary に入る。依存の無いジョブは従来の実行順序（バッチ単位）のまま実行する。
 * child_process はスタブに差し替える（実際のコマンドは実行しない）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => {
  const calls: { file: string; args: string[] }[] = [];
  /** 「コマンド名 引数」→ 実行時に返す失敗 */
  const failures = new Map<string, () => Error>();
  const run = (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ file, args });
    const f = failures.get([file, ...args].join(' '));
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
type WorkflowJob = import('../services/cicd').WorkflowJob;

const job = (cmd: string, needs?: string[]): WorkflowJob => ({ name: cmd, 'runs-on': 'ubuntu-latest', steps: [{ name: 's', run: cmd }], ...(needs ? { needs } : {}) });

async function runJobs(jobs: Record<string, WorkflowJob>, mode: 'real' | 'simulation' = 'real') {
  const svc = new CICDService();
  (svc as unknown as { sleep: () => Promise<void> }).sleep = async () => undefined;
  const events: { type: string; jobId?: string; conclusion?: string }[] = [];
  svc.on('job:completed', ({ jobRun }) => events.push({ type: 'job:completed', jobId: jobRun.id, conclusion: jobRun.conclusion }));
  const done = new Promise<WorkflowRun>((resolve) => svc.on('run:completed', resolve));
  await svc.runWorkflow({ name: 'wf', on: { workflow_dispatch: {} }, jobs }, 'manual', 'main', mode);
  return { run: await done, events };
}

const jobOf = (run: WorkflowRun, name: string) => {
  const j = run.jobs.find((x) => x.name === name);
  if (!j) throw new Error(`job ${name} not found`);
  return j;
};

describe('直し回13 必須：ジョブの失敗を run 全体の結論へ反映する', () => {
  beforeEach(() => {
    cp.calls.length = 0;
    cp.failures.clear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('1つのジョブが失敗：run は failed／failure、依存ジョブ（直接・間接）は実行せず skipped、依存の無いジョブは実行される', async () => {
    cp.failures.set('node --version', () => Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }));
    const { run, events } = await runJobs({
      build: job('node --version'),
      lint: job('echo lint'),
      test: job('echo test', ['build']),
      deploy: job('echo deploy', ['test']),
      report: job('echo report', ['lint']),
    });

    expect(run.status).toBe('failed');
    expect(run.conclusion).toBe('failure');
    expect(run.summary).toEqual({
      succeeded: ['lint', 'report'],
      failed: ['build'],
      skipped: [
        { job: 'test', reason: '依存ジョブが成功しなかったため実行しませんでした（build: failure）' },
        { job: 'deploy', reason: '依存ジョブが成功しなかったため実行しませんでした（test: skipped）' },
      ],
    });
    expect(run.error).toBe('ワークフローは成功しませんでした（成功：lint, report／失敗：build／スキップ：test, deploy）');

    expect(jobOf(run, 'node --version').conclusion).toBe('failure');
    for (const name of ['echo test', 'echo deploy']) {
      const j = jobOf(run, name);
      expect(j.status).toBe('completed');
      expect(j.conclusion).toBe('skipped');
      expect(j.steps).toEqual([]);
      expect(j.skipReason).toMatch(/依存ジョブが成功しなかったため実行しませんでした/);
    }
    // スキップしたジョブのコマンドは実行していない。依存の無い lint と、成功した lint に依存する report は実行した
    expect(cp.calls.map((c) => [c.file, ...c.args].join(' '))).toEqual(['node --version', 'echo lint', 'echo report']);
    // スキップも job:completed として通知される（画面・WebSocket で分かる）
    expect(events.filter((e) => e.conclusion === 'skipped').map((e) => e.jobId)).toEqual([`${run.id}-test`, `${run.id}-deploy`]);
  });

  it('全ジョブが成功：従来どおり completed／success、内訳は全て succeeded', async () => {
    const { run } = await runJobs({
      build: job('node --version'),
      test: job('echo test', ['build']),
      deploy: job('echo deploy', ['test']),
    });
    expect(run.status).toBe('completed');
    expect(run.conclusion).toBe('success');
    expect(run.summary).toEqual({ succeeded: ['build', 'test', 'deploy'], failed: [], skipped: [] });
    expect(run.error).toBeUndefined();
    expect(run.jobs.every((j) => j.conclusion === 'success')).toBe(true);
  });

  it('依存の無い並行ジョブの片方だけ失敗しても run は failure（成功したジョブは success のまま内訳に残る）', async () => {
    cp.failures.set('ls -la src', () => Object.assign(new Error('Command failed: ls -la src'), { code: 2 }));
    const { run } = await runJobs({ a: job('ls -la src'), b: job('echo b') });
    expect(run.conclusion).toBe('failure');
    expect(run.summary).toEqual({ succeeded: ['b'], failed: ['a'], skipped: [] });
  });

  it('依存関係を解決できないジョブ（循環）は実行せず skipped とし、run は success にしない', async () => {
    const { run } = await runJobs({ ok: job('echo ok'), x: job('echo x', ['y']), y: job('echo y', ['x']) });
    expect(run.conclusion).toBe('failure');
    expect(run.summary?.succeeded).toEqual(['ok']);
    expect(run.summary?.skipped.map((s) => s.job)).toEqual(['x', 'y']);
    expect(run.summary?.skipped[0].reason).toMatch(/依存関係を解決できないため実行しませんでした（needs: y。/);
    expect(cp.calls.map((c) => c.args.join(' '))).toEqual(['ok']);
  });

  it('simulation モードでも全成功なら success（従来どおり）', async () => {
    const { run } = await runJobs({ build: job('npm --version'), test: job('echo t', ['build']) }, 'simulation');
    expect(run.conclusion).toBe('success');
    expect(cp.calls).toEqual([]);
  });
});

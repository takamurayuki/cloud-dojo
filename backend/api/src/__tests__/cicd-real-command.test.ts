/**
 * 直し回4（必須）：CI/CD の real 実行で、許可パターンと完全一致するコマンドだけを、シェルを介さずに実行する。
 * 再レビュー3回目の迂回（`echo allowed; docker rm -f <ID>`）を含む、連結・置換・リダイレクトの各形が実行されないことを確かめる。
 * child_process は記録用のスタブに差し替える（実際のコマンド・Docker は実行しない）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => {
  const calls = { exec: [] as string[], execFile: [] as { file: string; args: string[]; shell: unknown }[] };
  const execFile = (file: string, args: string[], opts: { shell?: unknown }, cb: (e: unknown, o: string, s: string) => void) => {
    calls.execFile.push({ file, args, shell: opts?.shell });
    cb(null, `ran ${file} ${args.join(' ')}\n`, '');
  };
  // 実物の execFile と同じく、promisify すると { stdout, stderr } で解決する
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (file: string, args: string[], opts: { shell?: unknown }) =>
      new Promise((resolve) => execFile(file, args, opts, (_e, stdout, stderr) => resolve({ stdout, stderr }))),
  });
  return {
    calls,
    execFile,
    exec: (cmd: string, ...rest: unknown[]) => {
      calls.exec.push(cmd);
      const cb = rest.find((r) => typeof r === 'function') as ((e: unknown, o: unknown, s: unknown) => void) | undefined;
      cb?.(null, '', '');
    },
  };
});

vi.mock('child_process', () => ({ exec: cp.exec, execFile: cp.execFile, default: { exec: cp.exec, execFile: cp.execFile } }));

const { checkRealCommand, splitArgs, sanitizeStepEnv } = await import('../services/cicd-command');
const { CICDService } = await import('../services/cicd');
type WorkflowRun = import('../services/cicd').WorkflowRun;

const PILOT_ID = 'labc0ffee0001';

/** 再レビューの迂回文字列（連結・置換・リダイレクト・改行・エスケープの各形） */
const BYPASSES = [
  `echo allowed; docker rm -f ${PILOT_ID}`,
  `echo allowed && docker rm -f ${PILOT_ID}`,
  `echo allowed || docker stop ${PILOT_ID}`,
  `echo allowed | docker rm -f ${PILOT_ID}`,
  `echo allowed & docker rm -f ${PILOT_ID}`,
  `echo $(docker rm -f ${PILOT_ID})`,
  `echo \`docker rm -f ${PILOT_ID}\``,
  `echo "$(docker stop ${PILOT_ID})"`,
  'echo ${HOME}',
  'echo pwned > /tmp/cicd-bypass',
  'echo < /etc/passwd',
  'ls >> out.txt',
  `echo a\ndocker rm -f ${PILOT_ID}`,
  `echo a\r docker rm -f ${PILOT_ID}`,
  'echo a\\; docker ps',
  `docker --version; docker rm -f ${PILOT_ID}`,
  "echo 'unterminated",
];

describe('checkRealCommand：許可パターンとの完全一致', () => {
  it('迂回文字列（連結・置換・リダイレクト・改行）は全て rejected', () => {
    for (const c of BYPASSES) expect(checkRealCommand(c), c).toMatchObject({ kind: 'rejected' });
  });

  it('前方一致では通っていた別コマンド・引数付きは not-allowed（実行しない）', () => {
    for (const c of [
      'lsof -i',
      'lsblk',
      'datex',
      'echox hi',
      'whoami --help extra',
      'docker --version --format x',
      `docker rm -f ${PILOT_ID}`,
      `docker stop ${PILOT_ID}`,
      'node --version --eval x',
      'node -e require',
      'git --version -c core.pager=x',
      'ls /etc',
      'ls ../..',
      'ls --color=always',
      'date -s 2020-01-01',
      'pwd -P',
    ]) {
      expect(checkRealCommand(c), c).toEqual({ kind: 'not-allowed' });
    }
  });

  it('従来の許可コマンドはそのまま allowed（引数を分けて返す）', () => {
    expect(checkRealCommand('echo "Hello, CI"')).toEqual({ kind: 'allowed', command: { file: 'echo', args: ['Hello, CI'] } });
    expect(checkRealCommand("echo 'Build #42 done' ok")).toEqual({ kind: 'allowed', command: { file: 'echo', args: ['Build #42 done', 'ok'] } });
    expect(checkRealCommand('echo')).toEqual({ kind: 'allowed', command: { file: 'echo', args: [] } });
    for (const t of ['node', 'npm', 'pnpm', 'docker', 'git']) {
      expect(checkRealCommand(`${t} --version`)).toEqual({ kind: 'allowed', command: { file: t, args: ['--version'] } });
    }
    expect(checkRealCommand('ls -la src')).toEqual({ kind: 'allowed', command: { file: 'ls', args: ['-la', 'src'] } });
    expect(checkRealCommand('ls')).toEqual({ kind: 'allowed', command: { file: 'ls', args: [] } });
    expect(checkRealCommand('pwd')).toEqual({ kind: 'allowed', command: { file: 'pwd', args: [] } });
    expect(checkRealCommand('date')).toEqual({ kind: 'allowed', command: { file: 'date', args: [] } });
    expect(checkRealCommand('date +%Y-%m-%d')).toEqual({ kind: 'allowed', command: { file: 'date', args: ['+%Y-%m-%d'] } });
    expect(checkRealCommand('  whoami  ')).toEqual({ kind: 'allowed', command: { file: 'whoami', args: [] } });
  });

  it('splitArgs：引用をまとめ、閉じていない引用は null', () => {
    expect(splitArgs(`a "b c" 'd e'f ""`)).toEqual(['a', 'b c', 'd ef', '']);
    expect(splitArgs('a "b')).toBeNull();
  });

  it('sanitizeStepEnv：探索先・読み込むコードを変える env は渡さない', () => {
    expect(sanitizeStepEnv({ PATH: '/evil', NODE_OPTIONS: '--require x', LD_PRELOAD: 'x', DOCKER_HOST: 'x', FOO: 'bar' })).toEqual({ FOO: 'bar' });
  });
});

/** sleep を即時にして、ワークフローを最後まで実行する */
async function runReal(lines: string[]) {
  const svc = new CICDService();
  (svc as unknown as { sleep: () => Promise<void> }).sleep = async () => undefined;
  const done = new Promise<WorkflowRun>((resolve) => svc.on('run:completed', resolve));
  await svc.runWorkflow(
    { name: 'wf', on: { workflow_dispatch: {} }, jobs: { build: { name: 'build', 'runs-on': 'ubuntu-latest', steps: [{ name: 's', run: lines.join('\n'), env: { PATH: '/evil' } }] } } },
    'manual',
    'main',
    'real',
  );
  return done;
}

describe('CICDService の real 実行（child_process はスタブ）', () => {
  beforeEach(() => {
    cp.calls.exec.length = 0;
    cp.calls.execFile.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('迂回文字列は1つも実行されず、ステップ・ジョブが失敗になる（exec・execFile とも0回）', async () => {
    for (const c of BYPASSES.filter((b) => !b.includes('\n'))) {
      cp.calls.exec.length = 0;
      cp.calls.execFile.length = 0;
      const run = await runReal([c]);
      // run 全体の conclusion は、ジョブの失敗を拾わない既存の挙動（executeJob が内部で捕捉する）のため見ない
      expect(run.jobs[0].conclusion, c).toBe('failure');
      expect(run.jobs[0].steps[0].conclusion, c).toBe('failure');
      expect(run.jobs[0].steps[0].output.join('\n'), c).toMatch(/real 実行では実行しません/);
      expect(cp.calls.exec, c).toHaveLength(0);
      expect(cp.calls.execFile, c).toHaveLength(0);
    }
  });

  it('許可コマンドは従来どおり実行される（execFile・shell:false・引数は分けて渡す。exec は使わない）', async () => {
    const run = await runReal(['echo "Hello, CI"', 'node --version', 'docker --version', 'ls -la', 'pwd', 'date', 'whoami']);
    expect(run.conclusion).toBe('success');
    expect(run.jobs[0].conclusion).toBe('success');
    expect(cp.calls.exec).toHaveLength(0);
    expect(cp.calls.execFile).toEqual([
      { file: 'echo', args: ['Hello, CI'], shell: false },
      { file: 'node', args: ['--version'], shell: false },
      { file: 'docker', args: ['--version'], shell: false },
      { file: 'ls', args: ['-la'], shell: false },
      { file: 'pwd', args: [], shell: false },
      { file: 'date', args: [], shell: false },
      { file: 'whoami', args: [], shell: false },
    ]);
    expect(run.jobs[0].steps[0].output).toContain('ran echo Hello, CI');
  });

  it('許可されていないコマンド（docker rm 単独等）は従来どおり模擬で、実際には実行しない', async () => {
    const run = await runReal([`docker rm -f ${PILOT_ID}`, `docker stop ${PILOT_ID}`, 'npm test']);
    expect(run.conclusion).toBe('success');
    expect(cp.calls.exec).toHaveLength(0);
    expect(cp.calls.execFile).toHaveLength(0);
  });

  it('複数行の run は1行ずつ判定し、迂回行に当たったところで止まる（後続の許可コマンドも実行しない）', async () => {
    const run = await runReal(['echo first', `echo x; docker rm -f ${PILOT_ID}`, 'echo never']);
    expect(run.jobs[0].conclusion).toBe('failure');
    expect(cp.calls.execFile).toEqual([{ file: 'echo', args: ['first'], shell: false }]);
  });

  it('simulation モードは判定に関係なく従来どおり模擬（実行しない）', async () => {
    const svc = new CICDService();
    (svc as unknown as { sleep: () => Promise<void> }).sleep = async () => undefined;
    const done = new Promise<WorkflowRun>((resolve) => svc.on('run:completed', resolve));
    await svc.runWorkflow(
      { name: 'wf', on: {}, jobs: { b: { name: 'b', 'runs-on': 'x', steps: [{ name: 's', run: `echo a; docker rm -f ${PILOT_ID}` }] } } },
      'manual',
      'main',
      'simulation',
    );
    const run = await done;
    expect(run.conclusion).toBe('success');
    expect(cp.calls.exec).toHaveLength(0);
    expect(cp.calls.execFile).toHaveLength(0);
  });
});

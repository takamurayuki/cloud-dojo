/**
 * 共有ラボの排他制御（プロセス内）。
 *
 * ラボはラベルで一意に決まる1組（client / server）を全試行で共有するため、ラボを触る操作
 * （試行の実測 run・lab/start・lab/reset）は全て同じ排他区間で直列化する。待ち行列にはせず、
 * 使用中なら呼び出し側が即座に 409 を返す（利用者が「誰の何が実行中か」を判断できるようにする）。
 * パイロットは単一プロセス・単一利用者の構成のため、プロセス内のロックで足りる。
 */
export interface LabLockHolder {
  /** 例：'run:<attemptId>'、'lab/start' */
  owner: string;
  since: string;
}

export class LabLock {
  private holder: LabLockHolder | null = null;

  /** 取得できたら解放関数を返す（複数回呼んでも1回だけ解放）。使用中なら null */
  tryAcquire(owner: string): (() => void) | null {
    if (this.holder) return null;
    const mine: LabLockHolder = { owner, since: new Date().toISOString() };
    this.holder = mine;
    return () => {
      if (this.holder === mine) this.holder = null;
    };
  }

  /** 現在の保持者（なければ null） */
  current(): LabLockHolder | null {
    return this.holder ? { ...this.holder } : null;
  }
}

/** プロセスで共有する既定のラボロック（既存サーバ・パイロット単独起動のどちらでも1つ） */
export const sharedLabLock = new LabLock();

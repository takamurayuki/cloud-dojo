# N5 パイロット（学習エンジン新経路）

N5「TCP接続」1単元で、単元の型・学習ループ・ラボ・判定の全経路を通す。PostgreSQL・Redis・認証・AIキーなしで動く。

## 起動（パイロット専用）

```sh
# リポジトリ直下：API（127.0.0.1:4000）とフロント（127.0.0.1:3000）を同時起動
pnpm run dev:pilot
# 個別に起動する場合
pnpm --filter cloud-dojo-api dev:pilot        # API のみ。PILOT_PORT / PILOT_DB_PATH で変更可
pnpm --filter cloud-dojo-frontend dev:pilot   # 画面：http://127.0.0.1:3000/units/n5-tcp（vite --mode pilot）
```

- パイロットのフロントは `vite --mode pilot` で 127.0.0.1 のみで待ち受ける（通常の `pnpm dev` は従来どおり全インターフェース）。
  さらに Vite のプロキシは X-Forwarded-For で元の接続元を API に渡し、`/api/pilot` は接続元・転送ヘッダの
  どちらかが loopback 以外なら 403 にする。通常の開発起動で別端末から Vite 経由で届いた要求も拒否される。

## ラボの安全・整合の仕組み

- **SYN 再送の前提**：client コンテナに `net.ipv4.tcp_syn_linear_timeouts=0`・`net.ipv4.tcp_syn_retries=6` を
  `HostConfig.Sysctls` で設定する（追加の権限は不要）。実際の値は証拠 `lab-env` として記録し、整合判定は
  記録された値から導いた SYN の送信時刻・回数と実測を照合する。値が前提と違えば `lab-env-premise-mismatch` で
  完了にしない。sysctl が無いカーネルでは設定を外して作り直し、`absent`（0 と同じ倍々）として記録する。
- **排他制御**：ラボを触る操作（実測 run・lab/start・lab/reset）はプロセス内の1つのロックで直列化し、使用中なら
  409 `LAB_BUSY`。試行の run は SQLite 上で原子的に「実行中」を確保し、二重 run は 409（`RUN_IN_PROGRESS`／`ALREADY_RUN`）。
  証拠一式と評価は収集完了後に1トランザクションで保存する（途中失敗では何も残らず、同じ試行で再実行できる）。
- **期限と上限**：start／reset／collect の全体と、ping・ビルド・起動・リセット・exec の各単位に期限がある
  （`lab/runner.ts` の `DEFAULT_LAB_LIMITS`）。ビルド進捗は 2MB、exec 出力は 256KB まで。期限を超えたら
  ラベル付きコンテナを停止・削除し、504 `LAB_TIMEOUT` の `cleanup` に後始末の成否を返す。

- Node 22.5 以上が必要（`node:sqlite` を使う）。保存先の既定は `backend/api/.data/pilot.sqlite`（git 管理外）。
- 既定ポートは既存 API と同じ 4000 なので、既存 API（`pnpm dev:api`）とは同時に起動しない。既存 API を起動した場合も `/api/pilot` に同じ経路が登録される（node:sqlite が無い Node ではパイロット経路だけ無効化し、既存機能は止めない）。
- ラボは Docker が必要。Docker が無いとラボ API は `503 DOCKER_NOT_FOUND` を返す。画面では「フィクスチャで実行（練習用・完了不可）」を使える。
- ラボのイメージ（`cloud-dojo-lab/n5-tcp:0.1`）は初回の起動時に `backend/api/labs/n5-tcp/` からビルドされる（ビルド時のみ外部取得あり。ラボのネットワークは internal）。

## 構成

| パス | 役割 |
|---|---|
| `curriculum/schema.ts` | 単元の型と zod バリデータ（3層・5段階の順序・必須項目） |
| `curriculum/units/n5-tcp.ts` | N5 の単元データ（git 管理の型付きデータ） |
| `conditions.ts` | シード → 条件（portState: open/closed/drop、connectTimeout: 2/5/10） |
| `evidence/parse.ts` | ss / tcpdump / curl の解析と、証拠からの正解算出 |
| `evidence/fixtures.ts` | 実測形式のフィクスチャ証拠 |
| `judge.ts` | 判定（予測の正誤）と完了フラグ（実測・必須証拠・整合・振り返り） |
| `store.ts` | SQLite 保存（attempts / evidence / evaluations / reflections） |
| `lab/runner.ts` | dockerode ラボランナー（ラベル付きコンテナのみ操作、期限・上限・後始末） |
| `lab/lock.ts` | ラボ操作の排他区間（プロセス内） |
| `routes.ts` | API（`/api/pilot/...`、127.0.0.1 のみ） |

## テスト

```sh
pnpm --filter cloud-dojo-api test:pilot
```

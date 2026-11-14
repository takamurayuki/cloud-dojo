# N5 パイロット（学習エンジン新経路）

N5「TCP接続」1単元で、単元の型・学習ループ・ラボ・判定の全経路を通す。PostgreSQL・Redis・認証・AIキーなしで動く。

## 起動（パイロット専用）

```sh
# リポジトリ直下：API（127.0.0.1:4000）とフロント（:3000）を同時起動
pnpm run dev:pilot
# 個別に起動する場合
pnpm --filter cloud-dojo-api dev:pilot      # API のみ。PILOT_PORT / PILOT_DB_PATH で変更可
pnpm --filter cloud-dojo-frontend dev       # 画面：http://localhost:3000/units/n5-tcp
```

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
| `lab/runner.ts` | dockerode ラボランナー（ラベル付きコンテナのみ操作） |
| `routes.ts` | API（`/api/pilot/...`、127.0.0.1 のみ） |

## テスト

```sh
pnpm --filter cloud-dojo-api test:pilot
```

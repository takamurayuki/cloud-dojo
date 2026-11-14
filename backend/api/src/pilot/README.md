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
  さらに Vite のプロキシは X-Forwarded-For で元の接続元を API に渡し、API は接続元・転送ヘッダの
  どちらかが loopback 以外なら 403 `LOOPBACK_ONLY` にする。通常の開発起動で別端末から Vite 経由で届いた要求も拒否される。
  パイロット API（`src/pilot/server.ts`）では、この検査をルートスコープの共通フックに置き、`/api/pilot`・ラボ系ルート・
  `/health`・未定義の経路・CORS のプリフライトを含む全経路にかける（判定は `src/pilot/loopback.ts`）。許可の判定は TCP の
  実際の接続元で行い（trustProxy は使わない）、転送ヘッダは拒否の理由にだけ使うため、ヘッダで外部を loopback に見せかけられない。
- パイロット API（`src/pilot/main.ts`）は `/api/pilot` に加えて、認証・DB に依存しないラボ系ルート
  （`/api/docker`・`/api/compose`・`/api/k8s`・`/api/cicd`・`/api/network`）も登録する。auth／users／learning／ai／queue は
  登録しない。ラボ保護（下記のラベル保護・Docker ソケット保護・定義の検証）は各ルート側にあるので、パイロットでもそのまま効く。
  Docker が無い環境では、ラボ系 API は 503 などのエラー応答を返す。
- パイロット API は Redis キューの Worker を起動しない。キューへ投入する操作は受け付けず、503 `PILOT_QUEUE_UNSUPPORTED`
  （`message`・`reason`・`queue`）を返す。対象（`server.ts` の `PILOT_QUEUE_ROUTES`）：`POST /api/docker/build`・
  `POST /api/docker/containers/run`・`POST /api/compose/up`・`POST /api/compose/down`・`POST /api/compose/down-volumes`・
  `POST /api/k8s/apply`・`POST /api/cicd/run`。
- パイロットのフロントはログインをしない。認証ガードは素通しで、ユーザー取得（`/api/auth/me`）もしない。
  ナビは開ける項目だけで、DB 前提の Dashboard・Learning Path は出さない。`/`・`/learning`・`/login` は `/units/n5-tcp` へ送る。

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
  その操作の世代のコンテナを停止・削除し、504 `LAB_TIMEOUT` の `cleanup` に後始末の成否を返す。
- **実行世代と後始末中の状態**：start／reset／collect は開始時に世代を採番し、作るコンテナ・ネットワークに
  ラベル `cloud-dojo.gen` と世代入りの名前（`cloud-dojo-lab-n5-tcp-<世代>`…）を付ける。期限超過時の後始末は、
  その世代のラベルを持ち、かつ名前がその世代の接頭辞で始まるものだけを対象にする（遅れて走っても別の世代には触れない）。
  後始末は応答の期限（`abortGraceMs`＋`cleanupMs`）を過ぎても、走っていた単位と後始末が実際に終わるまで続く。
  その間は「後始末中」で、run・lab/start・lab/reset は 409 `LAB_CLEANUP_PENDING`（`lab/status` の `cleanupPending` で確認できる）。
  期限超過した操作が reset（collect 冒頭のリセットを含む）を始めていた場合、後始末は reset が一覧した既存のリソース
  （ID と世代を記録したもの）も削除し直す（このプロセスで reset より後に採番された世代は対象にしない）。最後に、対象にした
  全リソースが無くなったことを inspect（404）で確かめる。
  `cleanup.ok` は、対象の削除が全て確認できたときだけ true。期限内に終わらなければ `ok=false`・`pending=true`、
  終わっても削除を確認できない対象があれば `ok=false`・`pending=true`・`remaining`（残っている対象の一覧）。
  後始末中の状態は、対象の削除が全て確認できたときだけ解除する（削除失敗・未確認では解除しない。状態の `remaining` に残りが入る）。
- **後始末中が続く場合**：Docker が応答を返さないまま、または削除を確認できない対象が残ったときは、待っても後始末中
  （409 `LAB_CLEANUP_PENDING`）が解除されない（画面にもこの案内を表示する）。復旧手順：
  1. API プロセスを再起動する（`pnpm run dev:pilot` を止めて起動し直す）。後始末中の状態はプロセス内にだけあるので解除される。
  2. 画面の「リセット」（`POST /api/pilot/lab/reset`）を行う。前のプロセスのものを含むラベル付きのラボが全て削除される
     （削除だけで、ラボは停止したままになる。続けて使うときは「起動」）。代わりに「ラボで実行（実測）」でもよい。こちらは
     同じ削除のあとに実測用のラボを新しく起動して実測する（実測後もそのラボは起動したまま残る）。
     画面では、この手順を「復旧手順」として開いて読める（ラボ欄の後始末中の表示と、409／504 のエラー表示）。
  3. それでも残る場合は Docker 自体を確認する（`docker ps -a --filter label=cloud-dojo.lab`、`docker network ls --filter label=cloud-dojo.lab`）。
- **既存 API との併用**：既存サーバ（`pnpm dev:api`）はパイロットと既存 API を同時に登録する。既存 API がホストやラボに
  届かないよう、保護は次の3つを組み合わせる（いずれも名前・短縮 ID の指定は inspect で解決してから判定し、以後は確かめた
  完全な ID で操作する）：
  1. **ラボのラベル**：コンテナ・ネットワークを実行・停止・削除する経路は、対象がラベル `cloud-dojo.lab` を持てば
     403 `PILOT_LAB_PROTECTED` で拒否する（`lab/protect.ts`）
  2. **Docker ソケットを保有するコンテナ**：ラベルの有無によらず、inspect（一覧では listContainers）の `Mounts[].Source` が
     Docker ソケット（またはそれを含む親ディレクトリ・別名・リンク）を指すコンテナは、実行・削除・停止・起動を
     403 `DOCKER_SOCKET_CONTAINER_PROTECTED` で拒否する（例：リポジトリの `docker-compose.yml` の `cloud-dojo-worker`。
     中からソケットへ要求を送ればホストの全コンテナを操作できるため）。compose の up・down でも同じに拒否する
  3. **定義・マニフェストの検証**：compose の定義と Kubernetes のマニフェストは、ホストを操作できる設定を含めば適用前に拒否する（下記）
  パスの判定（compose の bind、既存コンテナの `Mounts[].Source`、Kubernetes の `hostPath.path`）は、どれも同じ共有関数
  （`services/compose-guard.ts` の `dockerSocketReason`）で行う。検査には実際に Docker・kubelet へ渡す文字列そのものを使い、
  書き換え（trim 等）はしない。前後の空白・`\`・制御文字を含むパスや、空・空白だけのパスは、解釈を一致させられないため判定不能として
  拒否する（既存コンテナでは保護対象にする）。空・空白だけのパスは3経路とも読み飛ばさない（compose の短い書式 `:/x`・長い書式の
  `source: ""`、既存コンテナの空の `Mounts[].Source`、空の `hostPath.path`）。そのため、Source が空のマウント（tmpfs 等）を持つ
  通常のコンテナも、この API からは実行・削除・停止・起動できない（判定不能を許可側に倒さない）。
  文字列でないパス（欠落・null・数値・オブジェクト等）も読み飛ばさない。既存コンテナの `Mounts[]` では、種別（`Type`）が
  bind・npipe・欠落・未知のものは、Source が文字列でなければ判定不能として保護する。Source にホストのパスを持たないことが正常な
  volume・tmpfs・image・cluster は、Source の欠落・null を通し、数値・オブジェクト等の想定外の型は判定不能として保護する。
  `Mounts` が配列でない、または要素がオブジェクトでない場合も保護する。compose の長い書式では、`source`（`src`）が文字列でなければ
  type によらず拒否し、type が bind・npipe で `source` が欠落・null のものも拒否する（volume の匿名ボリューム・tmpfs の source 無しは通す）。
  ラベルもソケットも持たない通常のリソースは従来どおり操作できる。
  対象の経路：
  - `POST /api/network/exec`、`DELETE /api/docker/containers/:id`、`POST /api/docker/containers/:id/stop`・`start`
  - `POST /api/network/lab/create`（固定名 `network-node-<i>` の既存コンテナ削除。何も作らないうちに拒否する）。
    指定した名前のネットワークが既にあれば、名前の完全一致とラベル `cloud-dojo=network-lab` を確かめた場合だけ再利用する。
    パイロットのラベルがあれば 403、ラボ用だと確かめられなければ 409 `LAB_NETWORK_UNVERIFIED`。どちらも作成前の確認で拒否するので、
    何も作成・削除しない。コンテナは確かめた（または作成した）ネットワークの ID で接続する（名前では接続しない）。
    確認を通った後の作成途中で失敗した場合（500）は、その要求で作成したネットワークがあれば、その要求で作成したコンテナと
    そのネットワークを ID で削除する。削除できなかったものは応答の `cleanup.remaining` とログに残存として出す
    （再利用した既存のネットワークは削除しない。作り直しのために削除した既存の `network-node-<i>` は戻らない）。
    作成前の存在確認（既存の `network-node-<i>`・ネットワーク・イメージ `alpine:latest` の inspect）は 404 だけを「存在しない」とし、
    それ以外の失敗（500・通信エラー等）では、何も作成・削除・pull せずに 500 `LAB_PRECHECK_FAILED`（ネットワークは従来どおり 500）で中止する。
    作り直しのための既存 `network-node-<i>` の削除も、404 以外の失敗は読み飛ばさずに作成を中止し、上の後始末を行う
  - `DELETE /api/network/lab/cleanup`（ラベル `cloud-dojo=network-lab` の一括削除。対象に1つでもあれば何も削除せずに拒否する）。
    対象の確認（inspect）が 404 以外で失敗したら何も削除せずに 500。削除の失敗は 404（確認後に消えた）だけを削除済みとし、
    それ以外（使用中を含む）は読み飛ばさずに 500 とし、残ったものの名前・ID・復旧手順を `cleanup.remaining`・`message` とログに出す
  - compose（`POST /api/compose/up` の同名コンテナ削除、`/api/compose/down`・`down-volumes` のコンテナ・ネットワーク削除。
    どちらもキューのジョブが失敗として終わる。up は、保護したサービスを作り直さず、他のサービスの起動は従来どおり続けたうえで
    ジョブを失敗にする。このときの失敗理由には、保護の理由に続けて、起動したサービスと失敗したサービスを両方とも出す）。up の存在確認（既存コンテナ・ボリューム・イメージの inspect）は 404 だけを「存在しない」とし、
    それ以外の失敗（500・通信エラー等）ではそのサービスを作成しない。サービス個別の作成・起動の失敗もジョブの失敗にし、
    失敗理由に起動したサービスと失敗したサービスを両方とも出す（一部だけ起動した場合も成功にはしない）。起動後の最終確認（作成したコンテナの inspect）が失敗したサービスも、確認できない状態を起動とはみなさずに失敗とし、ジョブを失敗にする（失敗理由にコンテナ ID と確認手順を出す）。up の接続先ネットワーク `<project>_<network>` が既にあれば、名前の完全一致と、
    このプロジェクトの compose ネットワークのラベル（この API が作成時に付ける `cloud-dojo=compose`・
    `cloud-dojo.compose.project`・`cloud-dojo.compose.network`、または Docker Compose が付ける `com.docker.compose.project`・
    `com.docker.compose.network`）を確かめた場合だけ接続する。確かめられなければ（パイロットのラベル、`cloud-dojo=network-lab`
    等の別用途、ラベル無しを含む）ジョブを失敗にする。全ネットワークを作成前にまとめて確かめるので、その確認で拒否した場合は
    ネットワーク・コンテナを何も作成・停止・削除しない。確認の後、ネットワークの作成途中で失敗した場合（作成中の 409 の
    再確認で拒否した等）は、コンテナは作らず、この回に作成したネットワークを作成時の ID で削除する。削除できなかったものは
    ジョブの失敗理由とログに残存として出す。コンテナは確かめた（または作成した）ネットワークの ID で接続する（名前では接続しない）。
    以前の版が作ったラベル無しのネットワークは、一度 `docker network rm <project>_<network>` で削除すると次回から作り直される。
    down・down-volumes のネットワーク削除は、404（既に無い）だけを削除済みとし、それ以外（使用中＝`has active endpoints`・500・通信エラー等）は
    残存として記録したうえで残りのネットワークの削除も試みる。残存が1つでもあればジョブを失敗にし、失敗理由とログに残ったネットワークの
    名前・ID・理由・復旧手順（`docker network rm <ID>`）と、削除できたものを出す（以前は使用中を警告だけにして成功としていた）。
    down-volumes は、ネットワークが残ってもコンテナは削除済みなのでボリュームの削除は続け、そのうえでジョブを失敗にする
    （保護による拒否・コンテナの削除失敗で down が中止した場合は、従来どおりボリュームに触れない）。
    ネットワークの残存が無くボリュームの削除だけが失敗した場合も、ジョブを失敗にし、最後の進捗（`down:progress`）を `error` にする
  - compose の定義（`POST /api/compose/up`）：ホストを操作できる設定を含む定義は、受付時に 400 `COMPOSE_DEFINITION_REJECTED`
    で拒否してキューに入れない。Worker 側の compose up でも同じ検査をし、Docker を何も操作しないうちにジョブを失敗にする。
    拒否するのは次の5つ（判定は YAML の解析結果と、この API が実際に Docker へ渡す bind mount に対して行う。パスは `..`・
    重複・末尾スラッシュを正規化し、ホストに存在する部分はシンボリックリンクを解決した実体で比べる）：
    1. Docker ソケットの bind mount（`/var/run/docker.sock`・`/run/docker.sock`・`DOCKER_HOST` 等。別名・リンク・同じ inode、
       ソケットを含む親ディレクトリ（`/`・`/run`・`/var/run`・`/var` 等）、名前が `docker.sock` のもの、Windows の
       `docker_engine` パイプを含む。名前付きボリュームの `driver_opts.device`、`secrets`／`configs` の `file` も同じ）
    2. `privileged: true`
    3. host 名前空間の共有（`network_mode`・`pid`・`ipc`・`uts`・`userns_mode`・`cgroup` が `host` または `container:…`）
    4. `cap_add` のうち許可リスト外のもの（`ALL`・`SYS_ADMIN` 等）。許可するのは Docker の既定14個と `NET_ADMIN`・
       `SYS_PTRACE`・`IPC_LOCK`・`SYS_NICE`（`services/compose-guard.ts` の `ALLOWED_CAP_ADD`）
    5. `devices`
    任意のイメージ・command・名前付きボリューム・上記以外のホストパス・ポート・環境変数は従来どおり使える。
    YAML として解析できない定義も、判定できないため拒否する
  - Kubernetes（`/api/k8s/*`）：namespace・name・kind・tail を Kubernetes の名前の規則（RFC 1123 等）で検証し、
    妥当でなければ 400 `K8S_INVALID_INPUT` で kubectl を起動しない。kubectl はシェルを介さず（execFile）引数を分けて起動する。
    `POST /api/k8s/apply` のマニフェストは、受付と Worker 側の両方で `services/k8s-manifest-guard.ts` の検査を通し、
    ノードを操作できる設定があれば 400 `K8S_MANIFEST_REJECTED` で何も適用しない（mock モードでも同じ）。検査は構造上の位置で行い、
    PodSpec（Pod の `spec`、Deployment・StatefulSet・DaemonSet・ReplicaSet・Job・ReplicationController の `spec.template.spec`、
    PodTemplate の `template.spec`、CronJob の `spec.jobTemplate.spec.template.spec`、List の `items`、Pod テンプレートを持つ CRD）の
    コンテナの `securityContext`（`privileged`、許可リスト外の `capabilities.add`）、`hostNetwork`・`hostPID`・`hostIPC`、
    `volumes[].hostPath.path`（Docker ソケット等）と、PersistentVolume の `spec.hostPath.path` だけを見る。
    ConfigMap・Secret の `data` 等にある同名のキーは検査しない。List の入れ子は8段まで検査し、それより深い要素を含む
    マニフェストは、危険な指定の有無によらず検査不能として同じ 400 `K8S_MANIFEST_REJECTED` で拒否する（Worker 側も kubectl を起動しない）。真偽値は kubectl と同じく `yes`・`on`・`y` も真とする。
    apply の後は各リソースを `kubectl get <kind> <name> -o json` で取得し、種別ごとの規則（`services/k8s-readiness.ts`）で準備完了を判定する。
    取得の失敗（通信・認証・NotFound 等）・JSON として読めない応答・失敗が確定した状態（Pod の Failed、Job の Failed、
    Deployment の ProgressDeadlineExceeded 等）・期限（2秒間隔で15回）までに準備完了にならないものは、そのリソースを `error` にし、
    セッションも `error` にしてジョブを失敗させる（失敗・準備完了・判定不能の内訳を message に出す）。
    判定の前に応答の構造を検証する：kind が適用した種別と一致し、metadata.name が適用した名前と一致し、（判定対象の種別では）status が
    オブジェクトであること、判定に使う数値項目が 0 以上の整数であること。欠落・不正な型は既定値で補わず「確認できない応答」として
    取り直さずに `error` にする（`ready`・`unverified` にしない）。API サーバーが必ず返す項目（metadata.generation、spec.replicas、
    StatefulSet・ReplicaSet の status.replicas、DaemonSet の desiredNumberScheduled・currentNumberScheduled・numberReady・numberMisscheduled、
    Service の spec.type）の欠落も同じ。Kubernetes が 0 のとき省略するレプリカ数（availableReplicas 等）の欠落は 0 と読み替えず、
    「未報告」として準備完了の根拠にしない（待っても揃わなければ期限切れで `error`）。「未報告」として扱うのはキーが無いときだけで、
    明示的な `null` は数値・文字列・オブジェクト・配列・条件（status.conditions の要素と type・status・reason・message）のどれでも
    不正な型として `error` にする。コントローラ系は observedGeneration ≧ generation に加えて、
    全体・更新済み・利用可能の数がすべて希望数と一致し（旧レプリカが残っていない）、利用不可が 0 または未設定のときだけ準備完了とする。判定するのは
    Deployment・StatefulSet（全体・更新済み・準備完了・利用可能のレプリカ数）、ReplicaSet（全体・準備完了・利用可能の数）、DaemonSet（配置・更新済み・利用可能・利用不可の数）、Pod（Running かつ Ready、または Succeeded）、
    Job（Complete）、Service（clusterIP の割り当て。LoadBalancer は status.loadBalancer.ingress に ip または hostname が空でない文字列の要素があること。有効な要素が無ければ未割り当てとして待ち、要素の構造が不正（null・オブジェクト以外・ip／hostname が文字列以外）なら `error`。LoadBalancer の構造検証は clusterIP の割り当て判定より先に行い、clusterIP が未割り当てでも不正な構造は待たずに `error`。Endpoints は見ない）、PersistentVolumeClaim（Bound）、
    Namespace（Active）。それ以外の種別（ConfigMap・Secret・CRD 等）は存在だけを確かめて `unverified`（判定不能）とし、`ready` とはみなさない。
    内訳はセッションの `verification`（ready・unverified・failed）に入る。mock モードの模擬適用は従来どおり
  - CI/CD の real 実行（`POST /api/cicd/run` の `executionMode: real`）：許可パターン（`echo …`、`node`・`npm`・`pnpm`・
    `docker`・`git` の `--version`、`ls`、`pwd`、`date`、`whoami`）と引数まで完全に一致する行だけを、シェルを介さずに
    （execFile）実行する。シェルのメタ文字（`; & | $ ( ) < >`、バッククォート、改行、バックスラッシュ）を含む行は実行せずに
    ステップを失敗させる。許可した行の実行自体が失敗した場合（コマンドが無い・終了コードが0以外・時間切れ等）も、
    模擬の結果には置き換えずにステップを失敗させる（許可した行の実行失敗から模擬へは自動で切り替えない）。
    real でも、メタ文字を含まず許可パターンにも一致しない行は、実行せずに模擬の結果を返す（従来どおり。出力は実行結果ではない）。
    docker は `docker --version` だけなので、この経路でラボを停止・削除することはできない。
    ワークフロー全体の結論は、全ジョブが成功したときだけ `success`。1つでも失敗したら run は `failed`／`failure` になり、
    失敗（またはスキップ）したジョブに `needs` で依存するジョブは実行せずに結論 `skipped`（理由は `skipReason`）にする。
    依存関係を解決できないジョブ（循環・存在しないジョブ）も実行せずに `skipped` とし、run は `failure` にする。
    依存の無いジョブは従来の順序（依存段ごとのバッチ。同じバッチは並行）で実行する。ジョブの `if` は評価しない（従来どおり）。
    成功・失敗・スキップの内訳は run の `summary`（succeeded・failed・skipped）と、失敗時の `error` に入る
  ログの取得（読み取り）は拒否しない。Docker を直接操作（docker CLI 等）した場合の干渉は防げない。

- Node 22.5 以上が必要（`node:sqlite` を使う）。保存先の既定は `backend/api/.data/pilot.sqlite`（git 管理外）。
- 既定ポートは既存 API と同じ 4000 なので、既存 API（`pnpm dev:api`）とは同時に起動しない。既存 API を起動した場合も `/api/pilot` に同じ経路が登録される（node:sqlite が無い Node ではパイロット経路だけ無効化し、既存機能は止めない）。
- ラボは Docker が必要。Docker が無いとラボ API は `503 DOCKER_NOT_FOUND` を返す。画面では「フィクスチャで実行（練習用・完了不可）」を使える。
- ラボのイメージ（`cloud-dojo-lab/n5-tcp:0.1`）は初回の起動時に `backend/api/labs/n5-tcp/` からビルドされる（ビルド時のみ外部取得あり。ラボのネットワークは internal）。イメージの有無の確認（inspect）は 404 だけを「未ビルド」とし、それ以外の失敗（500・通信エラー等）ではビルドせずにラボ操作を中止する（500 `LAB_ERROR`。message に確認できなかった理由が入る）。

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
| `lab/protect.ts` | 既存のコンテナ操作 API からラボコンテナ（ラベル `cloud-dojo.lab`）と Docker ソケットを保有するコンテナを守る判定 |
| `routes.ts` | API（`/api/pilot/...`、127.0.0.1 のみ） |

## テスト

```sh
pnpm --filter cloud-dojo-api test:pilot
```

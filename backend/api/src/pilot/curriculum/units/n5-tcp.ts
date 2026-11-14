/**
 * N5「TCP接続」：待受とTCP接続。
 * MVP「1本のHTTPSリクエストの裏側」の第5単元。パイロットとして全経路（型・学習ループ・ラボ・判定）を通す。
 */
export const n5TcpUnit = {
  id: 'n5-tcp',
  code: 'N5',
  domain: 'Linux＆ネットワーク基礎',
  title: 'TCP接続：待受と3ウェイハンドシェイク',
  summary:
    'curl が「つながった／拒否された／待たされた」の裏で、カーネル同士がどのパケットを交わし、ソケットがどの状態を通るのかを、実際のパケットとソケット表で確かめる。',

  layers: {
    surface: {
      title: '表層の操作：curl でポートに接続する',
      body: [
        'client ノードから server ノードの 8080 番ポートへ curl で HTTP リクエストを送る。利用者から見える結果は「応答が返る」「すぐにエラー（Connection refused）」「しばらく待ってタイムアウト」の3通りに分かれる。',
        'curl は --connect-timeout で「接続確立まで待つ上限秒数」を決められる。終了コードは 0（成功）、7（接続できなかった）、28（時間切れ）。',
      ],
      commands: [
        'curl -sS -o /dev/null -w "time_total=%{time_total} http_code=%{http_code}\\n" --connect-timeout <秒> http://server:8080/',
        'echo $?   # curl の終了コード',
      ],
    },
    mechanism: {
      title: '内部機構：ハンドシェイク・状態遷移・RST・再送',
      body: [
        '3ウェイハンドシェイク：接続する側（client）のカーネルが SYN を送り、待ち受けている側（server）のカーネルが SYN-ACK を返し、client が ACK を返した時点で両側のソケットが ESTABLISHED になる。アプリ（curl や Web サーバ）が connect()/accept() を呼ぶだけで、パケットのやり取りはカーネルが行う。',
        '状態遷移：server のソケットは listen() で LISTEN になって SYN を待つ。client のソケットは SYN を送ると SYN_SENT になり、SYN-ACK を受け取ると ESTABLISHED になる。通信が終わり、先に close() した側は TIME_WAIT に入り、遅れて届くパケットに備えて一定時間（Linux では 60 秒）その接続の記録を残す。',
        'RST の発生条件：そのポートで LISTEN しているソケットが無いのに SYN が届くと、server のカーネルは RST（ACK付き）を返して「ここには誰もいない」と即座に知らせる。client の connect() は ECONNREFUSED で失敗し、curl は終了コード 7 になる。',
        '再送とバックオフ：SYN に何の応答も来ない場合（途中で黙って破棄された場合など）、client のカーネルは SYN を再送する。Linux の初期再送タイムアウトは 1 秒で、待ち時間を毎回 2 倍にしていく（送信は 0秒・1秒後・3秒後・7秒後・15秒後…）。上限（tcp_syn_retries）まで続くが、curl は --connect-timeout で先に打ち切る。',
      ],
    },
    observation: {
      title: '観察：パケットとソケット表で裏付ける',
      body: [
        '予測を提出すると、ラボで実際に curl を実行し、同時に client 側でパケットを記録し、ソケット表を取得する。予測と食い違った箇所は、下の証拠のどこに表れているかを確かめる。',
      ],
      tools: [
        {
          kind: 'tcpdump',
          tool: 'tcpdump -nn -tt -i eth0 tcp port 8080（client 側）',
          shows: '送受信された TCP パケットの時刻とフラグ',
          howToRead:
            'Flags [S] は SYN、[S.] は SYN-ACK、[.] は ACK、[R.] は RST（ACK付き）。client→server の [S] が何回出たか、その時刻の間隔（1秒、2秒、4秒…）が再送のバックオフ。',
        },
        {
          kind: 'ss-client',
          tool: 'ss -tan（client 側、curl 実行開始から約1秒後）',
          shows: '接続試行中の client ソケットの状態',
          howToRead: 'State 列を読む。SYN-SENT は応答待ち、ESTAB は確立済み。8080 宛ての行が無ければ、その時点で試行は終わっている。',
        },
        {
          kind: 'ss-server',
          tool: 'ss -tan（server 側、curl 終了後）',
          shows: '試行後の server ソケットの状態',
          howToRead: 'LISTEN は待受中のソケット。TIME-WAIT は server が先に閉じた接続の記録が残っていることを示す。',
        },
        {
          kind: 'curl',
          tool: 'curl の -w 出力と終了コード',
          shows: '所要時間（time_total）と終了コード',
          howToRead: 'exit=0 は成功、7 は接続拒否など、28 は時間切れ。time_total が --connect-timeout とほぼ等しければ、時間切れまで待たされたということ。',
        },
      ],
    },
  },

  loop: [
    { stage: 'predict', title: '予測', instructions: '与えられた条件から、パケット・ソケット状態・curl の結果を予測して提出する。提出するまで実行・観察はできない。提出後は変更できない。' },
    { stage: 'execute', title: '実行', instructions: 'ラボで curl を実行し、同時に証拠（tcpdump・ss・curl 結果）を自動で収集する。' },
    { stage: 'observe', title: '観察', instructions: '収集した証拠を読み、予測と実測の差分を確かめる。正誤は証拠から自動で判定される。' },
    { stage: 'explain', title: '説明', instructions: 'なぜその結果になったのかを、因果の連鎖として自分の言葉で説明し、ルーブリックで自己照合する。' },
    { stage: 'counterfactual', title: '反事実', instructions: '条件が違っていたら何が変わるかに答え、ルーブリックで自己照合する。' },
  ],

  prediction: {
    prompt: '次の条件で client から curl を実行する。実行したときに観察される結果を予測せよ。',
    conditionParams: [
      {
        id: 'portState',
        label: 'server の 8080 番ポートの状態',
        variants: [
          { value: 'open', label: 'open（待受あり）', scenario: 'server では Web サーバが 8080 番ポートで待ち受けている。応答を返す前に 1.5 秒の処理時間がかかり、応答後は server 側から接続を閉じる。' },
          { value: 'closed', label: 'closed（待受なし・REJECT相当）', scenario: 'server は起動しているが、8080 番ポートで待ち受けているプロセスは無い。ファイアウォールは何もしていない。' },
          { value: 'drop', label: 'DROP（黙って破棄）', scenario: 'server では Web サーバが 8080 番ポートで待ち受けているが、server のファイアウォール（iptables）が 8080 宛ての受信パケットを応答なしで破棄する設定になっている。' },
        ],
      },
      {
        id: 'connectTimeout',
        label: 'curl の --connect-timeout（秒）',
        variants: [
          { value: '2', label: '2 秒', scenario: 'curl は --connect-timeout 2 で実行する。' },
          { value: '5', label: '5 秒', scenario: 'curl は --connect-timeout 5 で実行する。' },
          { value: '10', label: '10 秒', scenario: 'curl は --connect-timeout 10 で実行する。' },
        ],
      },
    ],
    fields: [
      {
        id: 'curlResult',
        label: 'curl の結果',
        kind: 'choice',
        options: [
          { value: 'connected', label: '接続して応答を受け取る（exit=0）' },
          { value: 'refused', label: 'すぐに接続拒否（exit=7）' },
          { value: 'timeout', label: '時間切れ（exit=28）' },
        ],
        derivedFrom: ['curl'],
      },
      {
        id: 'synReply',
        label: 'client の SYN に対して server から返るもの',
        kind: 'choice',
        options: [
          { value: 'syn-ack', label: 'SYN-ACK（[S.]）' },
          { value: 'rst', label: 'RST（[R.]）' },
          { value: 'none', label: '何も返らない' },
        ],
        derivedFrom: ['tcpdump'],
      },
      {
        id: 'synCount',
        label: 'client が送る SYN の回数（再送を含む）',
        kind: 'choice',
        options: [
          { value: '1', label: '1 回' },
          { value: '2', label: '2 回' },
          { value: '3', label: '3 回' },
          { value: '4', label: '4 回' },
          { value: '5+', label: '5 回以上' },
        ],
        derivedFrom: ['tcpdump'],
      },
      {
        id: 'clientState',
        label: 'curl 開始から約1秒後の client ソケットの状態（ss）',
        kind: 'choice',
        options: [
          { value: 'ESTAB', label: 'ESTAB（確立済み）' },
          { value: 'SYN-SENT', label: 'SYN-SENT（応答待ち）' },
          { value: 'none', label: '該当ソケットなし（試行は終わっている）' },
        ],
        derivedFrom: ['ss-client'],
      },
      {
        id: 'serverState',
        label: 'curl 終了後の server 側 8080 のソケット（ss）',
        kind: 'choice',
        options: [
          { value: 'TIME-WAIT', label: 'TIME-WAIT の接続が残る（LISTEN も残る）' },
          { value: 'LISTEN', label: 'LISTEN のみ' },
          { value: 'none', label: '8080 のソケットは無い' },
        ],
        derivedFrom: ['ss-server'],
      },
      {
        id: 'duration',
        label: 'curl の所要時間（time_total）',
        kind: 'choice',
        options: [
          { value: 'immediate', label: 'ほぼ 0 秒（0.3 秒未満）' },
          { value: 'server-delay', label: '約 1.5 秒（server の処理時間）' },
          { value: 'connect-timeout', label: 'ほぼ --connect-timeout の秒数' },
        ],
        derivedFrom: ['curl'],
      },
    ],
  },

  causalExplanation: {
    prompt: '観察した結果がなぜそうなったのかを、カーネルの動作の連鎖として説明せよ。',
    chain: [
      { id: 'syn', cause: 'curl が connect() を呼ぶ', effect: 'client のカーネルが SYN を送り、ソケットが SYN-SENT になる', evidence: ['tcpdump', 'ss-client'] },
      { id: 'reply', cause: 'server のカーネルが SYN を受け取ったときの 8080 の状態（LISTEN の有無／破棄）', effect: 'SYN-ACK・RST・無応答のどれになるかが決まる', evidence: ['tcpdump'] },
      { id: 'client-outcome', cause: 'client のカーネルが受け取った応答（または無応答での再送とバックオフ）', effect: 'connect() の成否と所要時間、curl の終了コードが決まる', evidence: ['curl', 'tcpdump'] },
      { id: 'teardown', cause: '接続が確立した場合、先に close() した側', effect: 'その側のソケットが TIME_WAIT に残る', evidence: ['ss-server'] },
    ],
    freeTextPrompt: '今回の条件で観察された結果を、上の因果チェーンに沿って、証拠（どのパケット・どの状態・どの数値）を引用しながら説明せよ。手順の暗唱ではなく「なぜ」を書くこと。',
    rubric: [
      { id: 'cites-packets', criterion: 'tcpdump のフラグ列（[S]／[S.]／[R.]／再送の時刻）を具体的に引用して、server 側の応答を説明している', evidence: ['tcpdump'] },
      { id: 'kernel-not-app', criterion: '応答（SYN-ACK や RST）を返すのはアプリではなくカーネルであることを踏まえている', evidence: ['tcpdump'] },
      { id: 'state-linked', criterion: 'ss で見えたソケット状態（SYN-SENT／ESTAB／TIME-WAIT／LISTEN）を、ハンドシェイクのどの時点かと結び付けている', evidence: ['ss-client', 'ss-server'] },
      { id: 'timing-explained', criterion: 'curl の所要時間と終了コードを、応答の有無・再送とバックオフ・--connect-timeout から説明している', evidence: ['curl', 'tcpdump'] },
    ],
  },

  counterfactuals: [
    {
      id: 'drop-vs-reject',
      prompt: 'ファイアウォールで接続を拒否するとき、DROP（黙って破棄）ではなく REJECT --reject-with tcp-reset にしたら、client 側で観察される結果（パケット・所要時間・終了コード）はどう変わるか。運用上、それぞれを選ぶ理由（トレードオフ）も述べよ。',
      rubric: [
        { id: 'observable-diff', criterion: 'RST が返るため即座に失敗し、SYN の再送が起きないことを述べている' },
        { id: 'tradeoff', criterion: 'DROP は存在を隠せるが利用者や監視を待たせる、REJECT は早く失敗させられるがポートの存在や方針が分かる、という観点で比較している' },
      ],
    },
    {
      id: 'longer-timeout',
      prompt: '応答が無いポートに対して --connect-timeout を 20 秒にしたら、SYN は何回送られるか。curl に --connect-timeout を付けなかった場合は何が上限を決めるか。',
      rubric: [
        { id: 'backoff-count', criterion: '0・1・3・7・15 秒の送信時刻から、20 秒以内の SYN 回数を数えている（5 回）' },
        { id: 'syn-retries', criterion: 'タイムアウト指定が無い場合は client カーネルの tcp_syn_retries（既定 6 回で約 127 秒）が上限になることを述べている' },
      ],
    },
  ],

  faultScenarios: [
    { id: 'listener-down', name: '待受プロセスが落ちている', condition: { portState: 'closed' }, injection: 'server の Web サーバを停止する（ポートに LISTEN が無い状態）', symptom: 'curl が即座に Connection refused（exit=7）で失敗する' },
    { id: 'firewall-drop', name: 'ファイアウォールが黙って破棄する', condition: { portState: 'drop' }, injection: 'server で iptables -A INPUT -p tcp --dport 8080 -j DROP を設定する', symptom: 'curl が応答なしで待たされ、--connect-timeout で時間切れ（exit=28）になる' },
  ],

  requiredEvidence: ['tcpdump', 'ss-client', 'ss-server', 'curl'],
} as const;

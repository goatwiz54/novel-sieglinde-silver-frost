# TASK / QUE 仕様書

対象スプレッドシート: なろう・更新日別PV解析テンプレート
作成日: 2026-07-09

## 1. 目的・背景

これまでは1つのQUEシートに「タスク定義」「予約状態」「キュー状態」が混在しており、役割の切り分けが曖昧だった。本仕様では以下のように役割を分離する。

- **TASKシート**: タスクの定義と予約状態を持つ。予約したい処理はTASKにだけ書き込む。
- **QUEシート**: 実際に積まれた実行キュー（ログ）を持つ。TASKからのみ追加され、削除はクリーナーだけが行う。

GAS（Google Apps Script）は1回の実行が最大6分で強制終了されるため、タイムアウト検知の基準はそれより余裕を持たせて10分とする。

## 2. TASKシート仕様

列構成:

| 列 | 名前 | 内容 |
|---|---|---|
| A | ID | タスクの一意なID（固定行、増減しない） |
| B | 名称 | 表示名 |
| C | KEY | トリガー/タスクの一意キー（例: trigger_fetch_pv） |
| D | GROUP_KEY | グルーピング用キー（例: day, pv, search, que, summary） |
| E | TARGET | 処理対象の詳細（日付・対象シート名など、一意に特定できる情報を書く） |
| F | GUARD | block または日時。block中はQUEへ積まない。日時はblock解除時刻 |
| G | TASK | none / reserve / wait |
| H | TASK_TIME | TASKの状態を更新した時刻 |
| I | TASK_WAIT(min) | TASK=wait にする際の待機分数（スプシで調整する） |
| J | TASK_WAIT_TIME | TASK=wait の解除時刻 |
| K | QUE | on / off。このタスクが現在QUEに積まれているかどうかのフラグ |
| L | QUE_TIME | QUEがonになった時刻（クリーナーのタイムアウト判定に使用） |

### 2.1 行の性質

行は固定。動的な追加・削除はしない。複数予約が必要なタスク（日付シート更新、PV取得シート更新、PV書き込みなど）は、あらかじめ複数行（例: day1/day2/day3、update_pv1/2/3、fetch_pv1/2/3）を用意しておき、空いている行に書き込む方式。

検索APIは、実行完了後に同じ検索APIタスク行を TASK=wait にして、
TASK_WAIT(min) に基づいて TASK_WAIT_TIME を自動設定し、再投入を止める。

### 2.2 予約の書き込みルール

各処理がTASKに予約を書き込む際：

1. 対象行のQUE(K列)を確認する
2. offなら: TARGET・TASK=reserve・TASK_TIMEを書き込む
3. onなら: 書き込み不可（すでに処理中/積まれ済みのためスキップ、または別の空き行を探す）

GUARD(F列)がblock、または未来日時の場合、その行はreserveでもQUEへ積まない。

TASK=wait の行は、TASK_WAIT_TIME(J列)の時刻を過ぎるまでQUEへ積まない。

同一GROUP_KEY内で同一TARGETが重複して予約されることはNG。書き込み側では基本的に避ける想定だが、万一発生した場合はクリーナーが整理する。

## 3. QUEシート仕様

列構成:

| 列 | 名前 | 内容 |
|---|---|---|
| - | TASK_ID | 参照元TASKのID |
| - | KEY | 参照元TASKのKEY（コピー） |
| - | TARGET | 参照元TASKのTARGET（コピー） |
| - | STATUS | 未処理 / 処理中 / 完了 / エラー |
| - | TIME | STATUSが更新されるたびに書き換えられる時刻（QUEシート自身の時刻。TASKのTIMEとは別物） |

TASKは処理開始後は一切参照・更新されないため、QUEには実行に必要な情報（TARGETなど）をこの時点でコピーして持たせる。

## 4. トリガー・処理の役割分担

### 4.1 各タスクの元処理（予約する側）

TASK.QUE(K)がoffの行にのみ、TARGET・TASK=reserve・TASK_TIMEを書き込む。

### 4.2 appendQueTrigger（QUE追加）

- TASKでTASK=reserveの行を見つけたら、QUEに新規行を追加する（TARGET等をコピー、STATUS=未処理）
- 同時にTASK側のQUE(K)をon、QUE_TIME(L)を積んだ時刻に更新する
- 追加専用。QUE・TASKどちらの行も削除・リセットしない
- グループやKEY種別に関係なく、TASK_TIMEの昇順（古い時刻が先）でQUEへ積む

### 4.3 QUE実行トリガー（未処理を探して実行するもの）

- 起動時、QUEに処理中(STATUS=処理中)の行が1つでもあればスキップ（何もしない）
- 処理中の行がなければ、未処理の行を1つ拾い、STATUSを処理中にして実際の処理を実行
- 処理の結果に応じてSTATUSを完了またはエラーに更新し、TIME（QUE側）も都度更新
- TASK表は一切触らない
- この仕組みにより、QUE全体で同時に1件しか処理中にならず、ロック無しで排他制御ができる

※運用停止スイッチ:
QUEのID列(A列)のどこかに `###` を含む値がある場合、
enqueue（新規積み込み）とworkerの処理開始（未処理→処理中化）の両方を停止する。
手動で流したい時は `###` を消す。

### 4.4 clearQueTrigger（クリーナー）

QUEとTASKの両方を整備できる唯一の処理。

- QUE: 処理開始時刻から10分以上経過した行を削除する（GASの最大実行時間6分を超えたバッファとして10分を採用）
- TASK: QUE(K)=onのままQUE_TIME(L)が10分以上経過している行を、TARGET・GUARD・TASK・TASK_TIME・TASK_WAIT_TIME・QUE・QUE_TIMEをリセット（未使用状態に戻し、再予約可能にする）
- GROUP_KEY＋TARGETが重複しているTASK行があれば、IDが小さい方を残し、大きい方をリセットする
- TASK: GUARD(F列)が日時の場合、解除時刻を過ぎたらGUARDをクリアする
- TASK: TASK=wait かつ TASK_WAIT_TIME(J列)の時刻を過ぎたらリセットして再予約可能にする

QUE整理タスク自身は、処理完了時に TASK=wait へ遷移し、
同じ行の TASK_WAIT(min) に基づいて TASK_WAIT_TIME を設定する。
これにより、QUE整理の間隔をスプシ側で調整できる。

## 5. 状態遷移まとめ

**TASK**: (none/off) → 予約書き込み → (reserve/off) → appendQueTriggerが検知 → (reserve/on) → クリーナーが10分超で検知 → (none/off) に戻る

**QUE**: 追加(未処理) → 実行トリガーが拾う(処理中) → 完了 or エラー → クリーナーが10分超で削除

## 6. 参考: 現状のTASK一覧（設計時点のサンプル）

| ID | 名称 | KEY | GROUP_KEY |
|---|---|---|---|
| 10100 | 検索API | trigger_fetch_search_api | search |
| 10200 | PV取得 | trigger_fetch_pv | pv |
| 10300 | 日付シート更新1 | trigger_update_day1 | day |
| 10310 | 日付シート更新2 | trigger_update_day2 | day |
| 10320 | 日付シート更新3 | trigger_update_day3 | day |
| 10400 | PV取得シート更新1 | trigger_update_pv1 | pv |
| 10410 | PV取得シート更新2 | trigger_update_pv2 | pv |
| 10420 | PV取得シート更新3 | trigger_update_pv3 | pv |
| 10500 | PV取得シートPV書き込み1 | trigger_fetch_pv1 | pv |
| 10510 | PV取得シートPV書き込み2 | trigger_fetch_pv2 | pv |
| 10520 | PV取得シートPV書き込み3 | trigger_fetch_pv3 | pv |
| 10600 | QUE追加 | trigger_append_que | que |
| 10610 | クリーナー | trigger_clear_que | que |
| 10700 | サマリ更新 | trigger_update_summary | summary |
| 10800 | 10分集計 | trigger_update_ten_minuts_pv | ten_minuts_pv |
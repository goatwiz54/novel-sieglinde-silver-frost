#!/bin/bash

# ========================================================
# 【注意】GIT_WORK_TREEは git worktree コマンドとは無関係です！
# 単に「GoogleDrive内のソースコード（Resource）の場所」を指定しています。
# ========================================================
NOVELS_HOME="$HOME/goatwiz54/novels"

# 1. Macのシステム（次回以降のターミナル）にもずっと有効にする設定
# 使用しているシェル設定ファイル（通常は .zshrc）に追記します
if [ -f "$HOME/.zshrc" ]; then
    # 重複して書き込まないようにチェック
    if ! grep -q "GIT_DIR" "$HOME/.zshrc"; then
        echo 'export GIT_DIR="$NOVELS_HOME/novels.git"' >> "$HOME/.zshrc"
        echo 'export GIT_WORK_TREE="$NOVELS_HOME/novels.src"' >> "$HOME/.zshrc"
    fi
fi

# 2. いま開いているこの画面でもすぐに有効にする設定
export GIT_DIR="$NOVELS_HOME/novels.git"
export GIT_WORK_TREE="$NOVELS_HOME/novels.src"

echo "Gitの環境変数を設定しました。(Resourceの場所: $GIT_WORK_TREE)"

# ターミナルを閉じずに操作できるようにシェルを維持
$SHELL

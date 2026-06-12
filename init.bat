@echo off
rem ========================================================
rem 【注意】GIT_WORK_TREEは git worktree コマンドとは無関係です！
rem 単に「GoogleDrive内のソースコード（Resource）の場所」を指定しています。
rem ========================================================

:: 1. 次回以降もずっと有効にする設定（システムへの保存）
setx GIT_DIR "C:\Users\goatwiz54\MyProjects\novels.git"
setx GIT_WORK_TREE "C:\Users\goatwiz54\MyProjects\novels.src"

:: 2. いま開いているこの画面でもすぐに有効にする設定
set GIT_DIR "C:\Users\goatwiz54\MyProjects\novels.git"
set GIT_WORK_TREE "C:\Users\goatwiz54\MyProjects\novels.src"

echo Gitの環境変数を設定しました。(Resourceの場所: %GIT_WORK_TREE%)
cmd /k

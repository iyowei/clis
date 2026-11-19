@echo off
rem codd 启动器 (Windows): 挑选运行时 (Bun 优先, 其次 Node) 后交给 bin/codd.mjs。
rem 使用 for 的 PATH 展开修饰符避免搜当前目录; 仅在成功解析出 bun 时才设置 IS_BUN, 防止污染 node 回退。
setlocal
set "ROOT=%~dp0.."
set "ENTRY=%ROOT%\bin\codd.mjs"
set "BUNFIG=%ROOT%\bin\bunfig.toml"
set "RUNNER="
set "IS_BUN="

for %%I in (bun.com bun.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"
if defined RUNNER set "IS_BUN=1"
if not defined RUNNER for %%I in (node.com node.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"

if not defined RUNNER echo codd: 未找到 bun 或 node, 请至少安装其一 1>&2
if not defined RUNNER exit /b 1

if defined IS_BUN (
  "%RUNNER%" "--config=%BUNFIG%" --no-env-file "%ENTRY%" %*
) else (
  "%RUNNER%" "%ENTRY%" %*
)
exit /b %errorlevel%

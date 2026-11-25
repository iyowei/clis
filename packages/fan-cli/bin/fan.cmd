@echo off
rem fan 启动器 (Windows): 挑选运行时 (Bun 优先, 其次 Node) 后启动真实入口。
rem 全程只用单行 if 判定, 并使用 %%~$PATH:I 仅在 PATH 条目内查找避免搜索 cwd。
setlocal
set "ROOT=%~dp0.."
set "ENTRY=%ROOT%\bin\fan.mjs"
set "BUNFIG=%ROOT%\bin\bunfig.toml"
set "RUNNER="
set "IS_BUN="

for %%I in (bun.com bun.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"
if defined RUNNER set "IS_BUN=1"
if defined IS_BUN set "CLIS_BUN_ISOLATED=1"
if not defined RUNNER for %%I in (node.com node.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"

if not defined RUNNER echo fan: bun or node not found in PATH 1>&2
if not defined RUNNER exit /b 1

if defined IS_BUN if not exist "%BUNFIG%" echo fan: missing bin/bunfig.toml 1>&2
if defined IS_BUN if not exist "%BUNFIG%" exit /b 1

if defined IS_BUN "%RUNNER%" "--config=%BUNFIG%" --no-env-file "%ENTRY%" %*
if not defined IS_BUN "%RUNNER%" "%ENTRY%" %*
exit /b %errorlevel%

@echo off
rem create-clis 启动器 (Windows): 挑选运行时 (Bun 优先, 其次 Node) 后交给 npm 分发入口
rem (bin/create-clis.mjs, 内含产物自证)。全程只用单行 if 判定, 防回退 Node 误传 Bun 参数。
setlocal
set "ROOT=%~dp0.."
set "ENTRY=%ROOT%\bin\create-clis.mjs"
set "BUNFIG=%ROOT%\bin\bunfig.toml"
set "RUNNER="
set "IS_BUN="

for %%I in (bun.com bun.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"
if defined RUNNER set "IS_BUN=1"
if defined IS_BUN set "CLIS_BUN_ISOLATED=1"
if not defined RUNNER for %%I in (node.com node.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"

if not defined RUNNER echo create-clis: bun or node not found in PATH 1>&2
if not defined RUNNER exit /b 1

if defined IS_BUN "%RUNNER%" "--config=%BUNFIG%" --no-env-file "%ENTRY%" %*
if not defined IS_BUN "%RUNNER%" "%ENTRY%" %*
exit /b %errorlevel%

@echo off
rem sweep 启动器 (Windows): 挑选运行时 (Bun 优先, 其次 Node) 后启动真实入口。
rem 全程只用单行 if 判定 (不用标签与括号块), 防回退 Node 时误传 Bun 参数。
rem 使用 for 的 PATH 展开修饰符 (只搜 PATH, 不搜当前目录, 见 ADR 0007)。
setlocal
set "ROOT=%~dp0.."
set "ENTRY=%ROOT%\bin\sweep.mjs"
set "BUNFIG=%ROOT%\bin\bunfig.toml"
set "RUNNER="
set "IS_BUN="

for %%I in (bun.com bun.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"
if defined RUNNER set "IS_BUN=1"
if defined IS_BUN set "CLIS_BUN_ISOLATED=1"
if not defined RUNNER for %%I in (node.com node.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"

if not defined RUNNER echo sweep: bun or node not found in PATH 1>&2
if not defined RUNNER exit /b 1

if defined IS_BUN if not exist "%BUNFIG%" echo sweep: missing bin/bunfig.toml 1>&2
if defined IS_BUN if not exist "%BUNFIG%" exit /b 1

if defined IS_BUN "%RUNNER%" "--config=%BUNFIG%" --no-env-file "%ENTRY%" %*
if not defined IS_BUN "%RUNNER%" "%ENTRY%" %*
exit /b %errorlevel%

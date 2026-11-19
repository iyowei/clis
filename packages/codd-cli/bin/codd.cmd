@echo off
rem codd launcher (Windows): prefer bun, fallback to node, then hand off to bin/codd.mjs.
rem Uses PATH expansion modifier to avoid cwd lookup; sets IS_BUN and CLIS_BUN_ISOLATED only when bun is resolved.
setlocal
set "ROOT=%~dp0.."
set "ENTRY=%ROOT%\bin\codd.mjs"
set "BUNFIG=%ROOT%\bin\bunfig.toml"
set "RUNNER="
set "IS_BUN="

for %%I in (bun.com bun.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"
if defined RUNNER set "IS_BUN=1"
if not defined RUNNER for %%I in (node.com node.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"

if not defined RUNNER echo codd: bun or node not found in PATH 1>&2
if not defined RUNNER exit /b 1

if defined IS_BUN (
  set "CLIS_BUN_ISOLATED=1"
  "%RUNNER%" "--config=%BUNFIG%" --no-env-file "%ENTRY%" %*
) else (
  "%RUNNER%" "%ENTRY%" %*
)
exit /b %errorlevel%

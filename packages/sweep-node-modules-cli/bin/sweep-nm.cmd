@echo off
rem sweep-nm 启动器 (Windows): 挑选运行时 (Bun 优先, 其次 Node) 后启动真实入口。
rem 与 sh 启动器 (bin/sweep-nm) 同逻辑; 未经 Windows 真机验证 (证据缺口)。
rem 分支结构全程只用单行 if 判定 (不用标签与括号块), 与 sh 启动器一一对应。
rem
rem 运行时解析防劫持 (安全审计项 runtime-resolution:bare-name-cwd-precedence-windows):
rem 裸名执行与 where 的默认搜索都含当前目录 (官方文档: by default, where searches the current
rem directory and the paths that are specified in the PATH environment variable; path 命令页:
rem the current directory is always searched before the directories specified in the command path),
rem 而本工具又在被扫目录里执行 —— 目录内放一个同名 bun.exe / bun.cmd 即可顶替真实运行时。
rem 故改用 for 的 PATH 展开修饰符 (官方 for 文档: Searches the directories listed in the PATH
rem environment variable and expands 变量 to the fully qualified name of the first directory
rem found): 只搜 PATH, 不搜当前目录, 也不派生任何子进程; 解析出的绝对路径交给末行执行, 带路径
rem 的命令不再触发搜索序。候选扩展名取 .com / .exe: 扩展名相对序 (.com 先于 .exe) 与 libuv 一致;
rem 搜索粒度则不同 —— 本实现扩展名优先 (.com 扫完全部 PATH 目录再试 .exe), npm 启动器
rem (bin/sweep-nm.mjs, 走 Node 的 libuv 搜索) 目录优先 (逐目录内先 .com 再 .exe); 仅当多个 PATH 目录
rem 分别存在不同扩展名的 bun / node 时, 三入口可能选中不同二进制 (登记见 packages/sweep-node-modules/docs/adrs/0007-platform-portability.md)。
setlocal
set "ROOT=%~dp0.."
set "ENTRY=%ROOT%\src\cli.ts"
set "RUNNER="

for %%I in (bun.com bun.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"
if not defined RUNNER for %%I in (node.com node.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"

if not defined RUNNER echo sweep-nm: 未找到 bun 或 node, 请至少安装其一 1>&2
if not defined RUNNER exit /b 1

"%RUNNER%" "%ENTRY%" %*
exit /b %errorlevel%

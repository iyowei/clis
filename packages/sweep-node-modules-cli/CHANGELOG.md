# @iyowei/sweep-node-modules-cli [0.4.0](https://github.com/iyowei/clis/compare/@iyowei/sweep-node-modules-cli@0.3.0...@iyowei/sweep-node-modules-cli@0.4.0) (2026-11-20)


### Bug Fixes

* update 子命令要求位于参数首位并给出用法提示 ([9ea4368](https://github.com/iyowei/clis/commit/9ea4368ee022d5b4d4ee6dafd04ff6c051619671))
* 保住 update 多行输出并补齐命令面错误上下文 ([b91c891](https://github.com/iyowei/clis/commit/b91c891dbe882bef3717343a6cda77898324ec98))
* 修正 Windows 路径校验、软链拦截与入口判定 ([106036c](https://github.com/iyowei/clis/commit/106036cb5822d3d0d88a0edcfbd0dc14c1480787))
* 修正清单渲染宽字符列宽与根项目名兜底 ([f2e4bc2](https://github.com/iyowei/clis/commit/f2e4bc25d3699f6748c6de13ba33409453ec87f2))
* 修正渲染层家目录缩写与列宽边界 ([bf2b4fe](https://github.com/iyowei/clis/commit/bf2b4fe14fb8f5a8ebb1031ca33384d52c6b7fdf))
* 向导路径绝对化去重并前置拦截配置落盘冲突 ([6efa88a](https://github.com/iyowei/clis/commit/6efa88a4170e36edf9f64323a82401f5e8722c81))
* 启动器隔离工作目录 bunfig 与环境变量 ([df889db](https://github.com/iyowei/clis/commit/df889dbdaaa10aa37494acb380215c4a4a7db9da))
* 未隔离 Bun 改用 process.execPath 重派进入隔离态 ([b381790](https://github.com/iyowei/clis/commit/b381790bb6477700cb2ebb9a7ae6144615a7a780))
* 重做三平台启动器运行时解析与进程派生模型 ([d61719b](https://github.com/iyowei/clis/commit/d61719b92ce94f7311ab9a352d93a5ecdb8a5aba))


### Features

* sweep-nm 新增 update 自更新子命令 ([4178814](https://github.com/iyowei/clis/commit/4178814ffaecdf8b33a38c0043570905532bc45b))
* 命令面新增版本输出并补齐向导根形态校验 ([9b88fae](https://github.com/iyowei/clis/commit/9b88fae325d37874eb4cb7a0a4b706671b038bad))
* 路径风味可显式注入, 测试断言脱离宿主 OS ([00831a9](https://github.com/iyowei/clis/commit/00831a9f010698bac624cc79352334f4339576c9))


### Dependencies

* **@iyowei/sweep-node-modules:** upgraded to 1.0.0

# @iyowei/sweep-node-modules-cli [0.3.0](https://github.com/iyowei/sweep-node-modules/compare/@iyowei/sweep-node-modules-cli@0.2.1...@iyowei/sweep-node-modules-cli@0.3.0) (2026-09-30)


### Bug Fixes

* 收紧启动器 POSIX 分支的 PATH 解析防御 ([cec3c9c](https://github.com/iyowei/sweep-node-modules/commit/cec3c9c85cee66dcc3253f31b4c4751bfa2aa9d5))


### Features

* 帮助页登记 -h 别名 ([1ca2fb0](https://github.com/iyowei/sweep-node-modules/commit/1ca2fb0bdba4c5f61797197523f133cf777356e3))


### Dependencies

* **@iyowei/sweep-node-modules:** upgraded to 0.5.1

## @iyowei/sweep-node-modules-cli [0.2.1](https://github.com/iyowei/sweep-node-modules/compare/@iyowei/sweep-node-modules-cli@0.2.0...@iyowei/sweep-node-modules-cli@0.2.1) (2026-09-29)


* feat!: API 公开面收口, 补齐缺失导出并撤除越界项 ([0d345e2](https://github.com/iyowei/sweep-node-modules/commit/0d345e25ed8ef546ef5e0aee539267cb5421ff76))


### Bug Fixes

* CI conformance 补构建前置, 固化本地全量预演入口 ([d6fd050](https://github.com/iyowei/sweep-node-modules/commit/d6fd0501b6ab0bd8780d67b5718bbf7e9de2c5ae))


### Dependencies

* **@iyowei/sweep-node-modules:** upgraded to 0.5.0


### BREAKING CHANGES

* RenderEntry 类型改由 CLI 包导出, runtimeLabel 与 writeTextFile 不再自 API 包导出, 调用方需自取运行时信息并把写文件改用 node:fs/promises 的 writeFile

# @iyowei/sweep-node-modules-cli [0.2.0](https://github.com/iyowei/sweep-node-modules/compare/@iyowei/sweep-node-modules-cli@0.1.2...@iyowei/sweep-node-modules-cli@0.2.0) (2026-09-29)


* feat!: 跳过集册结果形态落定, 入参解耦并补候选构造 ([6f4f450](https://github.com/iyowei/sweep-node-modules/commit/6f4f450938f79249c159ce2b2bd1b7dffb561122))
* feat!: 公开面刀 B 收口, 安全闸 / 设备边界 / 删除侧结果形态落地 ([1e4ca5f](https://github.com/iyowei/sweep-node-modules/commit/1e4ca5fc4dff62bfae6cb6713d85e18bf81db5e2))
* feat!: 体积告警结构化并补全结果三桶划分 ([d0e26bb](https://github.com/iyowei/sweep-node-modules/commit/d0e26bbc415b2099ec2335afd1b403e9442b30dc))
* feat!: 扫描告警结构化并收紧名单字段必填 ([56a1863](https://github.com/iyowei/sweep-node-modules/commit/56a18632fe7e87f1177a36db48ab86d50ad24633))


### Features

* 编排层 createSweeper 落地, CLI 退化为渲染薄壳 ([5f81bd9](https://github.com/iyowei/sweep-node-modules/commit/5f81bd92c6f24de932f3c6722ae582536e56f164))


### BREAKING CHANGES

* collectSkips / deletionBatch / skipsBatch 第三参改收 SweepPolicy 对象, 调用点改传 { releaseSuspects: <原 boolean> }; RenderEntry.suspect 改必填, 构造处需显式给出该字段
* RejectedTarget 与 AbortedBatch 的 reason 拆为 code 与 message (定位信息进 details / path), FailedTarget 更名 TargetFailure 并把 error 拆为 code / errno / message / partialRisk, findCrossDeviceTargets 的返回由 Map 改为 CrossDeviceEntry[] 数组 (需 has / get 查询的调用方改走 crossDeviceIndex), ValidationResult 新增必填 mappings 字段
* SizeResult.warnings 元素由字符串改为对象, 取原文案读 message, unmeasured 项新增必填 code, 自定义 Sizer 实现须补 basis 并适配 measure 的新签名
* ScanResult.warnings 元素由字符串改为对象, 取原文案读 message, 自定义 Scanner 实现须为 excludeMatches 与 includeMatches 补空数组

## @iyowei/sweep-node-modules-cli [0.1.2](https://github.com/iyowei/sweep-node-modules/compare/@iyowei/sweep-node-modules-cli@0.1.1...@iyowei/sweep-node-modules-cli@0.1.2) (2026-09-29)


### Bug Fixes

* 更正作者标识为 iTonyYo ([2d2be63](https://github.com/iyowei/sweep-node-modules/commit/2d2be633b25455658ed905fbad310b284257a5ec))

## @iyowei/sweep-node-modules-cli [0.1.1](https://github.com/iyowei/sweep-node-modules/compare/@iyowei/sweep-node-modules-cli@0.1.0...@iyowei/sweep-node-modules-cli@0.1.1) (2026-09-29)


### Bug Fixes

* CLI 包依赖改归 devDependencies ([bf77fe2](https://github.com/iyowei/sweep-node-modules/commit/bf77fe2fa62183d25329026e902a4dbe6d392ad2))
* 依赖版本区间改为星号形态修复发布报错 ([ae5ab8c](https://github.com/iyowei/sweep-node-modules/commit/ae5ab8c1a6e76ec271c183fb1f7096fdb9dd2a0b))
* 初始化测试的配置路径改为动态构造 ([68abd73](https://github.com/iyowei/sweep-node-modules/commit/68abd73f3226c740ad4b938ee11eb2ecb20a0cb5))
* 发布闸门脏工作树拒绝原因附路径预览 ([3ea82fc](https://github.com/iyowei/sweep-node-modules/commit/3ea82fce0eb6f40f2d923424a9c48a7d6727674d))

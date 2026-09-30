# @iyowei/sweep-node-modules [0.5.0](https://github.com/iyowei/sweep-node-modules/compare/@iyowei/sweep-node-modules@0.4.0...@iyowei/sweep-node-modules@0.5.0) (2026-09-29)


* feat!: API 公开面收口, 补齐缺失导出并撤除越界项 ([0d345e2](https://github.com/iyowei/sweep-node-modules/commit/0d345e25ed8ef546ef5e0aee539267cb5421ff76))
* feat!: 跳过集册结果形态落定, 入参解耦并补候选构造 ([6f4f450](https://github.com/iyowei/sweep-node-modules/commit/6f4f450938f79249c159ce2b2bd1b7dffb561122))
* feat!: 公开面刀 B 收口, 安全闸 / 设备边界 / 删除侧结果形态落地 ([1e4ca5f](https://github.com/iyowei/sweep-node-modules/commit/1e4ca5fc4dff62bfae6cb6713d85e18bf81db5e2))
* feat!: 体积告警结构化并补全结果三桶划分 ([d0e26bb](https://github.com/iyowei/sweep-node-modules/commit/d0e26bbc415b2099ec2335afd1b403e9442b30dc))
* feat!: 扫描告警结构化并收紧名单字段必填 ([56a1863](https://github.com/iyowei/sweep-node-modules/commit/56a18632fe7e87f1177a36db48ab86d50ad24633))


### Bug Fixes

* 中止报告取批次序最前触发条, 消除并发取值漂动 ([e0aaadf](https://github.com/iyowei/sweep-node-modules/commit/e0aaadf467bcef4f6bf1a008249dd3dbcdfbfd9c))
* 更正作者标识为 iTonyYo ([2d2be63](https://github.com/iyowei/sweep-node-modules/commit/2d2be633b25455658ed905fbad310b284257a5ec))
* 配置装载错误结构化, 对齐 SweepError 契约 ([7842f22](https://github.com/iyowei/sweep-node-modules/commit/7842f22949bcd37ee95e7ed6e0005366ae33cc75))


### Features

* API 包发布形态落地, 补齐构建链与发布闸门 ([3207a96](https://github.com/iyowei/sweep-node-modules/commit/3207a9663492a7f902b555b3c0c1cb39c3804837))
* 扫描侧实现取消信号与进度回调 ([baf5b64](https://github.com/iyowei/sweep-node-modules/commit/baf5b64114af26fc1ec8863abf1ab3e897647959))
* 扫描命中新增所属根字段 ([8ae50a7](https://github.com/iyowei/sweep-node-modules/commit/8ae50a73e70843b69ad3ffaa4ddc48ef4f11001a))
* 编排层 createSweeper 落地, CLI 退化为渲染薄壳 ([5f81bd9](https://github.com/iyowei/sweep-node-modules/commit/5f81bd92c6f24de932f3c6722ae582536e56f164))
* 落地公开面错误模型与域类型骨架 ([24d8292](https://github.com/iyowei/sweep-node-modules/commit/24d8292dfab24e89105f52d22773bc4c78917779))


### Performance Improvements

* 删除执行改 4 路有界并发, 保持输入序与中止语义 ([0f8e6af](https://github.com/iyowei/sweep-node-modules/commit/0f8e6af73ea235cb6d0dc9f01a35fed48eab201a))


### BREAKING CHANGES

* RenderEntry 类型改由 CLI 包导出, runtimeLabel 与 writeTextFile 不再自 API 包导出, 调用方需自取运行时信息并把写文件改用 node:fs/promises 的 writeFile
* collectSkips / deletionBatch / skipsBatch 第三参改收 SweepPolicy 对象, 调用点改传 { releaseSuspects: <原 boolean> }; RenderEntry.suspect 改必填, 构造处需显式给出该字段
* RejectedTarget 与 AbortedBatch 的 reason 拆为 code 与 message (定位信息进 details / path), FailedTarget 更名 TargetFailure 并把 error 拆为 code / errno / message / partialRisk, findCrossDeviceTargets 的返回由 Map 改为 CrossDeviceEntry[] 数组 (需 has / get 查询的调用方改走 crossDeviceIndex), ValidationResult 新增必填 mappings 字段
* SizeResult.warnings 元素由字符串改为对象, 取原文案读 message, unmeasured 项新增必填 code, 自定义 Sizer 实现须补 basis 并适配 measure 的新签名
* ScanResult.warnings 元素由字符串改为对象, 取原文案读 message, 自定义 Scanner 实现须为 excludeMatches 与 includeMatches 补空数组

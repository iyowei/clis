## @iyowei/sweep-node-modules [1.1.1](https://github.com/iyowei/clis/compare/@iyowei/sweep-node-modules@1.1.0...@iyowei/sweep-node-modules@1.1.1) (2026-11-20)


### Bug Fixes

* 统一 sweep-nm 帮助页配色为主视图同源标准 SGR 单色系 ([237f670](https://github.com/iyowei/clis/commit/237f670d59a0ad0e5a03a2e148482d1738a11c50))

# @iyowei/sweep-node-modules [1.1.0](https://github.com/iyowei/clis/compare/@iyowei/sweep-node-modules@1.0.0...@iyowei/sweep-node-modules@1.1.0) (2026-11-20)


### Features

* 重构全仓 CLI 帮助页为 Apple HIG 分层排版并补齐 codd -V 短旗标 ([7776a59](https://github.com/iyowei/clis/commit/7776a5962ff4ff0690b2d5afe7a1024b19846067))

# @iyowei/sweep-node-modules [1.0.0](https://github.com/iyowei/clis/compare/@iyowei/sweep-node-modules@0.5.1...@iyowei/sweep-node-modules@1.0.0) (2026-11-20)


* feat!: 让 SweepError 的 details 按 code 收窄并透传底层 cause ([d6092d4](https://github.com/iyowei/clis/commit/d6092d47c831d45078057c5b508ef70f96ea886d))


### Bug Fixes

* 体积统计分批调用 du 并先去重再测 ([9aeba3f](https://github.com/iyowei/clis/commit/9aeba3f0412256eb9bda3e34619ba96342f47208))
* 修正 win32 UNC 绝对路径正则兼容正斜杠 ([461558a](https://github.com/iyowei/clis/commit/461558a59081a932e6d1f7a878ea080a06e8e205))
* 修正 Windows 路径校验、软链拦截与入口判定 ([106036c](https://github.com/iyowei/clis/commit/106036cb5822d3d0d88a0edcfbd0dc14c1480787))
* 删除批次补 errno 并在回调抛错后立即停泵 ([f28c841](https://github.com/iyowei/clis/commit/f28c841158f0c0277431ded120af4e6d0ea1c96f))
* 加固 guard 与 classify 的路径判定并冻结路径风格常量 ([0d9846a](https://github.com/iyowei/clis/commit/0d9846a79851737b81d0ff62b462fc21dfb1e4ef))
* 加固 Windows 下 npm pack 的批处理调用与 PATH 解析 ([e775d51](https://github.com/iyowei/clis/commit/e775d51cbd8c32c1b73a29b067b31e77000817f5))
* 加固删除前安全复核链并让中止事件只发射一次 ([0884ed1](https://github.com/iyowei/clis/commit/0884ed171f5cd55e231526336a4624da06110533))
* 扫描器入口补齐取消预检并在目录不可读告警中透出 errno ([adb2ce5](https://github.com/iyowei/clis/commit/adb2ce562dffbe9d33ced83b3146154ebca084aa))
* 扫描并发池遇异常或取消立即停泵 ([16adad6](https://github.com/iyowei/clis/commit/16adad6351b60290e7be37c6816da9a97da7958d))
* 收窄发布类型面并加固构建与发布自证链 ([9654ef4](https://github.com/iyowei/clis/commit/9654ef4db3cfff458647be263d0c85ffeca2ddaf))
* 补强构造参数与配置校验, 拒绝空或相对 roots 与空 home ([94093d6](https://github.com/iyowei/clis/commit/94093d678c51ba204bde26e65597aa9c5dfb47ed))
* 重做 du stderr 解析以还原 GNU shell-escape 路径并降级子进程异常 ([bbc60e1](https://github.com/iyowei/clis/commit/bbc60e103f9a35c3c37b466e7fe120375cc12f84))


### Features

* collectFacts 支持注入 pack 事实 ([08f77b6](https://github.com/iyowei/clis/commit/08f77b699839e326f6ff20eb40baa4a71628c9a7))
* 基准套件支持自定义工作区根与压测独立存档 ([fb25812](https://github.com/iyowei/clis/commit/fb25812be90bd5764f684412baffa9751fd69ba4))
* 拆分拒绝与未尝试归因并透出清单 trailer ([114d46d](https://github.com/iyowei/clis/commit/114d46d960957635bfbf675de996a64d36120b31))
* 路径风味可显式注入, 测试断言脱离宿主 OS ([00831a9](https://github.com/iyowei/clis/commit/00831a9f010698bac624cc79352334f4339576c9))


### Performance Improvements

* 为成功侧 kind 常量标注纯构造以支持消费方 tree-shaking ([64cce4e](https://github.com/iyowei/clis/commit/64cce4e7ca880e1e9a054448a1fe0b0189305061)), closes [#__PURE__](https://github.com/iyowei/clis/issues/__PURE__)
* 体积统计改显式栈与 32 路有界并发并补 errno ([6fb1bec](https://github.com/iyowei/clis/commit/6fb1becac452a2d59426cea512006ccafc25cdae))


### BREAKING CHANGES

* isSweepError now narrows to a per-code union (NarrowedSweepError) instead of SweepError and rejects error-shaped objects without a string message; callers reading details fields without narrowing by code no longer type-check.

## @iyowei/sweep-node-modules [0.5.1](https://github.com/iyowei/sweep-node-modules/compare/@iyowei/sweep-node-modules@0.5.0...@iyowei/sweep-node-modules@0.5.1) (2026-09-30)


### Bug Fixes

* 补齐 du 批量调用前的取消检查点 ([1893a8f](https://github.com/iyowei/sweep-node-modules/commit/1893a8fad620cfda3bce095c33a6afb6bf9a33a9))

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

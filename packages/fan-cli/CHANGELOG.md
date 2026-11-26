## @iyowei/fan-cli [1.2.1](https://github.com/iyowei/clis/compare/@iyowei/fan-cli@1.2.0...@iyowei/fan-cli@1.2.1) (2026-11-26)


### Bug Fixes

* **fan-cli:** 收紧手动百分比调速实时追踪为全扇精确十分位收敛 ([6339d5a](https://github.com/iyowei/clis/commit/6339d5a9ddf25879e629e3b4cd822ed3102503f1))


### Dependencies

* **@iyowei/fan:** upgraded to 1.0.2

# @iyowei/fan-cli [1.2.0](https://github.com/iyowei/clis/compare/@iyowei/fan-cli@1.1.0...@iyowei/fan-cli@1.2.0) (2026-11-26)


### Bug Fixes

* **fan-cli:** 修复手动百分比调速实时追踪在双风扇未全达标时提前退出的问题 ([48fc7b1](https://github.com/iyowei/clis/commit/48fc7b140c3ff9b2bf8eabad687645862088c0bf))


### Features

* 新增 cli-i18n 共享库并为全仓 CLI 接入中英双语与系统语言自适应 ([c6432d2](https://github.com/iyowei/clis/commit/c6432d2ce0d4f64b5fc8462ff6aa7c574d5fb64b))

# @iyowei/fan-cli [1.1.0](https://github.com/iyowei/clis/compare/@iyowei/fan-cli@1.0.0...@iyowei/fan-cli@1.1.0) (2026-11-25)


### Features

* **fan-cli:** 重构渐变矩阵终端界面并支持转速实时追踪到位与守护自动同步 ([4a77a54](https://github.com/iyowei/clis/commit/4a77a54c33adb2b059a5e3b996e7dadce3521a63))


### Dependencies

* **@iyowei/fan:** upgraded to 1.0.1

# @iyowei/fan-cli 1.0.0 (2026-11-25)


### Bug Fixes

* **fan-cli:** 注入 persistOps 时不受宿主机平台门控以稳定跨平台测试 ([f164dcb](https://github.com/iyowei/clis/commit/f164dcbadf2bc0ca9901cad6311c055798185432))
* **fan,fan-cli:** 隔离只读 SMC 探测 stdin、补充超时降级并加固 macOS CI 探测 ([ed71d3b](https://github.com/iyowei/clis/commit/ed71d3bcc086877d6587b3eeb940ec20343d2162))


### Features

* 新增 fan macOS 风扇转速控制双包 ([0a74234](https://github.com/iyowei/clis/commit/0a742341aa1ff0089f9c6fd8903c0f077b97b2f3))

# Changelog

All notable changes to `@iyowei/fan-cli` will be documented in this file.

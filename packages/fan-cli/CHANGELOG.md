# @iyowei/fan-cli [1.4.0](https://github.com/iyowei/clis/compare/@iyowei/fan-cli@1.3.0...@iyowei/fan-cli@1.4.0) (2026-11-26)


### Bug Fixes

* 统一各 CLI 帮助面板的章节高亮与说明压暗层级 ([fa343a3](https://github.com/iyowei/clis/commit/fa343a3008404fb7f690440ed30f490a0cb40cbb))


### Features

* 为 CLI 进度指示器引入标准 SGR 流光跑马灯渲染 ([bdfb04a](https://github.com/iyowei/clis/commit/bdfb04a9d5543578756e43ba9870187ec34341c4))
* 为 fan-cli 帮助信息补充文档与源码地址 ([afa53d4](https://github.com/iyowei/clis/commit/afa53d4b10964e782163bc762f4025dc2f0ec553))
* 新增跨平台一键安装脚本与各 CLI 独立安装入口 ([59fc608](https://github.com/iyowei/clis/commit/59fc608b82984519e15c9a5aad455dee68a01822))

# @iyowei/fan-cli [1.3.0](https://github.com/iyowei/clis/compare/@iyowei/fan-cli@1.2.1...@iyowei/fan-cli@1.3.0) (2026-11-26)


### Bug Fixes

* 修复 fan-cli liveSettle 未随 NO_COLOR 关闭及输出流回退 ([063d971](https://github.com/iyowei/clis/commit/063d971ed1a11dc4675a452308cae5a77c7fb74c))
* 修复 fan-cli 中 -w 后接无效数字轮询间隔未报错的问题 ([d104c4a](https://github.com/iyowei/clis/commit/d104c4a9b80af0c8c64f7f0a397afcb269cefdd9))
* 修复 fan-cli 入口未透传注入平台与自定义 statePath 的问题 ([816af8d](https://github.com/iyowei/clis/commit/816af8dd047dc7f12fbaa37721feace9c294f0c1))
* 修复 fan-cli 实时刷新在窄终端换行残影与告警丢失问题 ([7790e6a](https://github.com/iyowei/clis/commit/7790e6a99f9660af7712c0d187a63c22c4b4a72a))
* 修复 fan-cli 英文平台错误未按注入平台本地化的问题 ([4be1339](https://github.com/iyowei/clis/commit/4be13390127ec81fff13c9a0737b9717e5d049bd))
* 修复 watch 模式收到 SIGINT 后需等待周期结束才退出的问题 ([412ddf9](https://github.com/iyowei/clis/commit/412ddf9706d71981c4bfab13e2c2f7dd102946da))
* 修复跨包启动器 win32 下空 PATH 未回退读取 Path 的问题 ([1c0c716](https://github.com/iyowei/clis/commit/1c0c7165c5b807d8bb463ef5aeb6a8db7c2d3954))
* 修正 fan-cli 中 update 与 lang 后接帮助选项无法生效的问题 ([7ba917b](https://github.com/iyowei/clis/commit/7ba917b153327c34371ae7c92eca16a83b416a63))


### Features

* 为 fan-cli persist 状态面板补充状态文件损坏诊断展示 ([8ca0497](https://github.com/iyowei/clis/commit/8ca0497814d1e23c321ad933b786f0919f8a5aad))
* 为 fan-cli 报告渲染补充 STATE_CORRUPT 英文告警提示 ([522076e](https://github.com/iyowei/clis/commit/522076ec032d2343a5c62f2c980436487cbeffac))


### Dependencies

* **@iyowei/fan:** upgraded to 1.1.0

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

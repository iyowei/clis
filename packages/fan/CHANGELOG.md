# @iyowei/fan [1.1.0](https://github.com/iyowei/clis/compare/@iyowei/fan@1.0.2...@iyowei/fan@1.1.0) (2026-11-26)


### Bug Fixes

* 为 AppleSMC 传输补充写超时与 pgrep 进程探测超时 ([a27ad91](https://github.com/iyowei/clis/commit/a27ad91a176bb620de99a08886ba9be32790da40))
* 为 fan 守护补充缺少 IOPMrootDomain 服务时的告警日志 ([338baa9](https://github.com/iyowei/clis/commit/338baa9a0ed80b78ab28ee52ec0c283eb8a3b726))
* 为 fan 构建脚本补充子进程超时、非交互 stdio 与错误校验 ([c75c0b9](https://github.com/iyowei/clis/commit/c75c0b9a434a465168a8b198f0acd2237728b323))
* 修复 fan 守护在睡眠或合盖期间继续恢复手动转速的问题 ([5827734](https://github.com/iyowei/clis/commit/5827734671f9e0ee953a4ef0e890f69976cea4fe))
* 修复 fan 守护恢复百分比转速时的越界夹逼与四舍五入 ([6c68daf](https://github.com/iyowei/clis/commit/6c68dafe0239a826f4ddb5d8bf2ad0f0f007595c))
* 修正 AppleSMC 传输在非 POSIX 环境下的默认 geteuid 回退 ([5dd9d64](https://github.com/iyowei/clis/commit/5dd9d64c2241aa9d6e810e831669aba13cc903b9))
* 修正 fan 守护卸载在 macOS 缺失 Python 时未校验的问题 ([53f084e](https://github.com/iyowei/clis/commit/53f084e5819a4dceec4c9cf995f090abf32e1a4a))
* 修正 fan 构建脚本 .d.ts 内部模块引用泄露检查正则 ([3ec0902](https://github.com/iyowei/clis/commit/3ec0902e2a9b9980a6cdfd036b61d983bd63d1f0))
* 完善 fan 守护管理的依赖注入、sudo 检查与超时守卫 ([9c1a36d](https://github.com/iyowei/clis/commit/9c1a36da0bc3f4da2f83c319c71f13ec0e5e8bc6))
* 完善 fan 状态存储的递归可写探测、依赖注入与超时守卫 ([b5b26b3](https://github.com/iyowei/clis/commit/b5b26b3320f968864050f1fab1b7719f98cef615))
* 收紧 state.json 持久化条目的百分比与转速取值校验 ([9ceb73e](https://github.com/iyowei/clis/commit/9ceb73eb47347a12c960bd65d8577660c6eb9ca6))
* 避免 fan 发布校验在 dist 目录存在时吞掉读盘异常 ([b14f9b2](https://github.com/iyowei/clis/commit/b14f9b22bbe722fa51ac89b2c397fa6e14764a13))


### Features

* 为 fan 守护状态查询暴露损坏 state.json 的 stateError 诊断 ([64dea21](https://github.com/iyowei/clis/commit/64dea21445642e54d7318f6ee385e6f7635f1d06))
* 为 fan 控制器增加 platform 宿主机平台注入支持 ([7d97431](https://github.com/iyowei/clis/commit/7d974311f341081a821d5eae277e0ac88c3a1aa9))
* 为 fan 控制器增加损坏状态守卫、写入回滚与守护提示 ([3927d0a](https://github.com/iyowei/clis/commit/3927d0a3b683bd52e0abbd4be237a7bf586dee42))

## @iyowei/fan [1.0.2](https://github.com/iyowei/clis/compare/@iyowei/fan@1.0.1...@iyowei/fan@1.0.2) (2026-11-26)


### Bug Fixes

* **fan:** 兼容跨代 Mac 的 F0Md、Ftst 温控延迟解锁与 Intel FS! 位掩码协议 ([2d15314](https://github.com/iyowei/clis/commit/2d15314b1f982161661f0e12cf574ebfad23314a))

## @iyowei/fan [1.0.1](https://github.com/iyowei/clis/compare/@iyowei/fan@1.0.0...@iyowei/fan@1.0.1) (2026-11-25)


### Bug Fixes

* **fan:** 合盖睡眠与暗唤醒自动释放手动转速并支持按需同步守护服务 ([e2dce90](https://github.com/iyowei/clis/commit/e2dce9000c67d73cc9541a8102bd193752e740ce))

# @iyowei/fan 1.0.0 (2026-11-25)


### Bug Fixes

* **fan,fan-cli:** 隔离只读 SMC 探测 stdin、补充超时降级并加固 macOS CI 探测 ([ed71d3b](https://github.com/iyowei/clis/commit/ed71d3bcc086877d6587b3eeb940ec20343d2162))


### Features

* 新增 fan macOS 风扇转速控制双包 ([0a74234](https://github.com/iyowei/clis/commit/0a742341aa1ff0089f9c6fd8903c0f077b97b2f3))

# Changelog

All notable changes to `@iyowei/fan` will be documented in this file.

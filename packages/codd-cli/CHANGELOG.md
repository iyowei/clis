# @iyowei/codd-cli [1.5.0](https://github.com/iyowei/clis/compare/@iyowei/codd-cli@1.4.1...@iyowei/codd-cli@1.5.0) (2026-11-26)


### Features

* 为 cli-updater 增加独立脚本安装来源识别与在线自更新 ([c5448bc](https://github.com/iyowei/clis/commit/c5448bc2f1094d19091441e0f828fb52604c7e8d))
* 为 codd-cli 帮助信息补充文档与源码地址 ([3ec8baa](https://github.com/iyowei/clis/commit/3ec8baa9ab2e712ccf83bc1614fe9ccba9d7575d))
* 新增跨平台一键安装脚本与各 CLI 独立安装入口 ([59fc608](https://github.com/iyowei/clis/commit/59fc608b82984519e15c9a5aad455dee68a01822))

## @iyowei/codd-cli [1.4.1](https://github.com/iyowei/clis/compare/@iyowei/codd-cli@1.4.0...@iyowei/codd-cli@1.4.1) (2026-11-26)


### Bug Fixes

* 修复跨包启动器 win32 下空 PATH 未回退读取 Path 的问题 ([1c0c716](https://github.com/iyowei/clis/commit/1c0c7165c5b807d8bb463ef5aeb6a8db7c2d3954))

# @iyowei/codd-cli [1.4.0](https://github.com/iyowei/clis/compare/@iyowei/codd-cli@1.3.1...@iyowei/codd-cli@1.4.0) (2026-11-26)


### Features

* 新增 cli-i18n 共享库并为全仓 CLI 接入中英双语与系统语言自适应 ([c6432d2](https://github.com/iyowei/clis/commit/c6432d2ce0d4f64b5fc8462ff6aa7c574d5fb64b))

## @iyowei/codd-cli [1.3.1](https://github.com/iyowei/clis/compare/@iyowei/codd-cli@1.3.0...@iyowei/codd-cli@1.3.1) (2026-11-25)


### Bug Fixes

* 修正 codd init 模板根解析与缺失清单提示 ([ce2b502](https://github.com/iyowei/clis/commit/ce2b5022f367a165fc16515fe28cd1180146afd5))
* 兼容 --help 前置的 update 子命令 ([ffdac94](https://github.com/iyowei/clis/commit/ffdac94826289c2ca0970f90cc426ed69e6414f1))
* 分离 stdout 与 stderr 的色彩降级判定 ([f0ff4ba](https://github.com/iyowei/clis/commit/f0ff4ba60abcbd709a3305d1d0d4376acef44377))
* 加固 CLI 启动器隔离校验与入口判定 ([10e24df](https://github.com/iyowei/clis/commit/10e24df3da4e583034da568a7dfb46888dc30b9f))

# @iyowei/codd-cli [1.3.0](https://github.com/iyowei/clis/compare/@iyowei/codd-cli@1.2.0...@iyowei/codd-cli@1.3.0) (2026-11-20)


### Features

* **codd,codd-cli:** restore 与 drill 原生支持 weekly/ 周备解析及自动回退 ([eaebb2c](https://github.com/iyowei/clis/commit/eaebb2ce3c316c17780ebb0e2182f06c11e69e30))


### Dependencies

* **@iyowei/codd:** upgraded to 1.3.0

# @iyowei/codd-cli [1.2.0](https://github.com/iyowei/clis/compare/@iyowei/codd-cli@1.1.0...@iyowei/codd-cli@1.2.0) (2026-11-20)


### Features

* **codd,codd-cli:** 新增备份四重磁盘防爆守卫并优化连接串 Compass 兼容性 ([81f3097](https://github.com/iyowei/clis/commit/81f30974fc07ee2c33f8edd0a2f25c1cfb5fe074))


### Dependencies

* **@iyowei/codd:** upgraded to 1.2.0

# @iyowei/codd-cli [1.1.0](https://github.com/iyowei/clis/compare/@iyowei/codd-cli@1.0.0...@iyowei/codd-cli@1.1.0) (2026-11-20)


### Features

* **codd,codd-cli:** 兼容 rootless Podman、完善部署指引并新增安全端口推荐 ([d2c9fe8](https://github.com/iyowei/clis/commit/d2c9fe8f56a15e2636c13c399f1a0eee1eab90b6))


### Dependencies

* **@iyowei/codd:** upgraded to 1.1.0

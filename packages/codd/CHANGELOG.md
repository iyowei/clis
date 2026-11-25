# @iyowei/codd [1.4.0](https://github.com/iyowei/clis/compare/@iyowei/codd@1.3.0...@iyowei/codd@1.4.0) (2026-11-25)


### Bug Fixes

* codd 构建补齐声明产物并新增双运行时冒烟 ([e538d1d](https://github.com/iyowei/clis/commit/e538d1da878282d53a460736afc4d00dcc6292e5))
* codd 路径校验改系统目录黑名单并对齐 schema ([62bb1cf](https://github.com/iyowei/clis/commit/62bb1cfee12afcde4b364e7e9c8e27b1d08f17b2))
* 修复 Helm init Job 标签触发反亲和死锁 ([8077cd0](https://github.com/iyowei/clis/commit/8077cd09cb6a5de7162a4a2026bca686979c3674))
* 修正 codd init 模板根解析与缺失清单提示 ([ce2b502](https://github.com/iyowei/clis/commit/ce2b5022f367a165fc16515fe28cd1180146afd5))
* 关闭 system.profile 双写并加固运行日志 ([b846ed3](https://github.com/iyowei/clis/commit/b846ed31979077db17261831ba51f32b251f0cb0))
* 加固 macOS 节点绑定告警与备份自启 ([d1991a7](https://github.com/iyowei/clis/commit/d1991a7dfc0892615387b29ef2fdc54d0e840344))
* 等待副本集成员就绪并校验主节点可写 ([36b2d86](https://github.com/iyowei/clis/commit/36b2d8684bfdc3e00c9740fad176edae30843f80))


### Features

* 按负载特征分化缓存与压缩公式 ([d8914d7](https://github.com/iyowei/clis/commit/d8914d766a7c621e0f92489aa3f2f2ab7ca3aed7))
* 补齐宿主机内核调优与内存预警 ([c2f597f](https://github.com/iyowei/clis/commit/c2f597fad205cfb7993e67dff11341c64858d255))

# @iyowei/codd [1.3.0](https://github.com/iyowei/clis/compare/@iyowei/codd@1.2.0...@iyowei/codd@1.3.0) (2026-11-20)


### Features

* **codd,codd-cli:** restore 与 drill 原生支持 weekly/ 周备解析及自动回退 ([eaebb2c](https://github.com/iyowei/clis/commit/eaebb2ce3c316c17780ebb0e2182f06c11e69e30))

# @iyowei/codd [1.2.0](https://github.com/iyowei/clis/compare/@iyowei/codd@1.1.0...@iyowei/codd@1.2.0) (2026-11-20)


### Features

* **codd,codd-cli:** 新增备份四重磁盘防爆守卫并优化连接串 Compass 兼容性 ([81f3097](https://github.com/iyowei/clis/commit/81f30974fc07ee2c33f8edd0a2f25c1cfb5fe074))

# @iyowei/codd [1.1.0](https://github.com/iyowei/clis/compare/@iyowei/codd@1.0.0...@iyowei/codd@1.1.0) (2026-11-20)


### Features

* **codd,codd-cli:** 兼容 rootless Podman、完善部署指引并新增安全端口推荐 ([d2c9fe8](https://github.com/iyowei/clis/commit/d2c9fe8f56a15e2636c13c399f1a0eee1eab90b6))

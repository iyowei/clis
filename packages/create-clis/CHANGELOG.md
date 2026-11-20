# create-clis [1.1.0](https://github.com/iyowei/clis/compare/create-clis@1.0.0...create-clis@1.1.0) (2026-11-20)


### Bug Fixes

* 修正 full 档协议路径提示指向包内目录 ([b96f7e7](https://github.com/iyowei/clis/commit/b96f7e77264d038a98a23c4251c896857e4af8c5))
* 修正 scope 残留检测的短词失明与拼缝误报 ([1cc52c7](https://github.com/iyowei/clis/commit/1cc52c7c42283943bcaab82d9af0abf9a6a65be5))
* 修正残留检测对目标词汇超集的误报 ([b293226](https://github.com/iyowei/clis/commit/b29322616824f850ee46be60072b3be1b044d56d))
* 加固 create-clis 的 Windows 启动与模板裁剪 ([7abdc2a](https://github.com/iyowei/clis/commit/7abdc2a60d2d75b51e345b1cb4ac07de1b78df4b))
* 加固生成收尾 hook 的跨平台子进程与错误指引 ([e039f2f](https://github.com/iyowei/clis/commit/e039f2fd0e445fa68d03e58003df11dfb36a84b4))
* 双包派生与模板清单识别仓内共享私有库 ([3dc6199](https://github.com/iyowei/clis/commit/3dc6199d9a04e3a66ed99b6dfd7b194ab3ef0c70))
* 启动器强制隔离 Bun 配置与环境文件 ([04a06ec](https://github.com/iyowei/clis/commit/04a06ecc06872ebcabda0407b26510cb29cd6143))
* 把模板 API 包换成不含 sweep 内部实现的中性骨架 ([3eb0ec2](https://github.com/iyowei/clis/commit/3eb0ec23aeda1881c491fbea488e8bcf6caa57b6))
* 收紧 tier workflow job 裁剪并改用词法走查定位代码块 ([cb78130](https://github.com/iyowei/clis/commit/cb7813034de1cc7de27f3367028728cab3a2e295))
* 未隔离 Bun 改用 process.execPath 重派进入隔离态 ([b381790](https://github.com/iyowei/clis/commit/b381790bb6477700cb2ebb9a7ae6144615a7a780))
* 模板发布自证递归扫描产物目录 ([235af77](https://github.com/iyowei/clis/commit/235af77ff147b84011de3236894b8455cb0eae4e))
* 模板快照消除私有包路径与镜像源泄漏 ([63cc887](https://github.com/iyowei/clis/commit/63cc8871cc74da92b2a085b525cca97a824ae3db))
* 模板构建改为全检通过后再写盘, 失败不留半成品 ([1f473e4](https://github.com/iyowei/clis/commit/1f473e4282a3eb3e1f031ed2f7b0580a2074b51f))
* 模板资产与生成物保留可执行权限位 ([11d9612](https://github.com/iyowei/clis/commit/11d9612af72d67b0ae86a317fc0d3b49ef4edacb))
* 重做 CLI 旗标解析与交互命名, 前移目标目录校验 ([8f88f15](https://github.com/iyowei/clis/commit/8f88f15a91febf5cabf9eaa48c89ee5581dfe7fc))
* 重做三平台启动器运行时解析与进程派生模型 ([d61719b](https://github.com/iyowei/clis/commit/d61719b92ce94f7311ab9a352d93a5ecdb8a5aba))


### Features

* collectFacts 支持注入 pack 事实 ([08f77b6](https://github.com/iyowei/clis/commit/08f77b699839e326f6ff20eb40baa4a71628c9a7))
* create-clis 新增 update 自更新子命令 ([43208e5](https://github.com/iyowei/clis/commit/43208e57247cefa6cf32d1a22494d17769918e67))
* 档位裁剪摘除增强档 workflow job ([786fb6b](https://github.com/iyowei/clis/commit/786fb6b88be202ac04175e8179c9a33f96eaf2d3))
* 模板根包补齐 format-check 脚本 ([83047f1](https://github.com/iyowei/clis/commit/83047f10aa0de9f2efc24578a4eb8fc651597dc1))

# create-clis 1.0.0 (2026-10-01)


### Bug Fixes

* next steps 补 full 档红态提示 ([b2ea203](https://github.com/iyowei/clis/commit/b2ea2037fcc06e3bb3bb92a6c2de6405d3c3e619))
* 二道自检排除与目标词汇重合的形态 ([48d2a52](https://github.com/iyowei/clis/commit/48d2a52165b55ddb9c4d3b3b436d4392fe259e6d))
* 修正 create-clis 点目录参数被当作项目名 ([ceb26ce](https://github.com/iyowei/clis/commit/ceb26ce068796ae934f94d839a02fa3fcf10959a))
* 修正 next steps 指向生成物中不存在的文档 ([e1d0516](https://github.com/iyowei/clis/commit/e1d051632f7ed1da051f11ef37b96f9249ae952e))
* 包隔离机制由 ignorePackages 登记改为 private 标记 ([2df3097](https://github.com/iyowei/clis/commit/2df30975d11aa6d1aeb600afdc639a874422023b))
* 替换引擎移除裸词替换形态 ([9b00c30](https://github.com/iyowei/clis/commit/9b00c30dfee46d509c997655217251bffe9327e5))
* 模板 .gitignore 与 .npmrc 改载体名随包并在生成期还原 ([e2a7b40](https://github.com/iyowei/clis/commit/e2a7b40e5fe1bb84a64b948397045d85843254dd))
* 模板占位符改用双花括号大写形态 ([de7cc80](https://github.com/iyowei/clis/commit/de7cc8002a60c01218b5cb08da4e533c41232591))
* 模板清单四条目改判 reset 并补骨架 ([43c84f6](https://github.com/iyowei/clis/commit/43c84f6a193bd0a2b5be8c40a758f12d4ba64d24))
* 模板清单补正产品短名面, 10 条登记改判泛化 ([b579062](https://github.com/iyowei/clis/commit/b579062bbaf6a00e96baa028008440f045b43be5))
* 模板清单词面收窄, 10 条登记退出泛化面 ([6447e15](https://github.com/iyowei/clis/commit/6447e15832a15b24f2c2794938303aa48b1478ca))
* 生成物示例包改用中性骨架, 阻断原产品元数据外泄 ([24607aa](https://github.com/iyowei/clis/commit/24607aaccadf2f8fa8c4dda5abedb5999d578917))
* 目标拒绝类失败不再谎报半成品 ([4cd343b](https://github.com/iyowei/clis/commit/4cd343b41b9f6fbf7c028abbaff613140753f880))
* 补 turbo 构建缓存键的根级输入面 ([9e3aec3](https://github.com/iyowei/clis/commit/9e3aec3eb9c4af31817515f9f24e4d18c14ea3d6))
* 补齐生成期裸 slug 形态的替换回退 ([7af6b18](https://github.com/iyowei/clis/commit/7af6b18982cca4cf6867e39c0e28c5667f8f8681))
* 裁剪模板时摘净孤儿载体声明与来源导入 ([859b665](https://github.com/iyowei/clis/commit/859b665e9f6cc41ac874a2c97bf3dcd189ea14ab))
* 裁剪补齐根 package.json 脚本面, 消除悬空脚本 ([571730e](https://github.com/iyowei/clis/commit/571730e4c7b5b36add2b4c262840f6a47894e679))


### Features

* 实装 create-clis 发行面与发布自证链 ([5bee073](https://github.com/iyowei/clis/commit/5bee073469b8545e1cb93266a34b1f9488b857e6))
* 新增 create-clis 变量收集与交互问答 ([d314a3e](https://github.com/iyowei/clis/commit/d314a3e85f30c28244c02c70a57f022051240886))
* 新增 create-clis 档位裁剪能力 ([a49e18b](https://github.com/iyowei/clis/commit/a49e18bc9d8b9dde30b071f4531823c74e3a61b5))
* 新增 create-clis 模板快照构建链 ([60d7ab8](https://github.com/iyowei/clis/commit/60d7ab8650b01f4a0650e3ab4f0ec80058b2e731))
* 新增 create-clis 模板清单登记表与自证测试 ([5a3cd1f](https://github.com/iyowei/clis/commit/5a3cd1fcddedf1be13eccf3c15ca207285d8ad71))
* 新增 create-clis 生成主流程 ([351224d](https://github.com/iyowei/clis/commit/351224d1c2ed03030068c6877f8b3d4e53025020))
* 新增 create-clis 生成器包, 工作区判据适配第二个工具包 ([17473d7](https://github.com/iyowei/clis/commit/17473d7e88acd4d882d848de98998d5898aee0c9))
* 新增模板泛化替换引擎与自证测试 ([93b470b](https://github.com/iyowei/clis/commit/93b470b07c3af3203e58274705718ca0830d4fc7))

# fan (API 主包与产品文档)

> 文档类型: 包级文档入口 (两级分层规则见[文档分层协议](../../../docs/designs/docs-layering.md))

`@iyowei/fan` 是 Mac 风扇读取与手动控制器的可编程 API 主包, 封装 AppleSMC IOKit 风扇读写、转速限幅、状态持久化、LaunchDaemon 开机唤醒恢复与 Macs Fan Control 冲突探测; CLI 包 (`@iyowei/fan-cli`, 命令 `fan`) 是其参数解析与终端渲染薄壳。用户向用法见[包 README](../README.md) / [中文 README](../README.zh-CN.md)。

## 包内设计

| 文档                                        | 一句话                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [API 面与 SMC 传输契约](designs/fan-api.md) | 公开导出符号、AppleSMC 键值映射 (`FNum`/`F*Ac`/`F*Tg`/`F*Mn`/`F*Mx`/`F*md`) 与错误码契约 |

## 关联入口

- 仓库级: [仓库文档总索引](../../../docs/README.md) / [仓级设计索引](../../../docs/designs/README.md)
- CLI 薄壳包: [fan-cli 文档](../../fan-cli/docs/README.md) / [命令面设计](../../fan-cli/docs/designs/cli-surface.md)

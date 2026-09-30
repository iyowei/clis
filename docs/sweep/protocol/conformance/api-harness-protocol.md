# API harness 协议 (api harness protocol)

> 用途: 定义「把被测 API 变成黑盒可执行命令」的契约: api 用例 (语料里 `kind: "api"` 的那些) 靠这份协议调用任意语言的实现, 验收行为是否等价。跟 CLI 用例「被测命令是参数」是一个道理: harness 只是一条可执行命令, 验收器 (`run-conformance.ts`) 零改动就能验收新语言的实现。
> 权威: 字段语义以 [`corpus.schema.json`](corpus.schema.json) 为准; 本文件是协议的规范正文, 管指令 / 输出 / 探针 / 实现者契约四个部分; 决策依据见 [ADR 0008](../../../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md) 与「转写双面覆盖」设计。
> 参考实现: `scripts/transcription/api-harness.ts` (TypeScript); 被测方也可以自己写一份等价的 harness, 唯一的约束就是这份协议。

## 1. 定位与调用形态

- harness 就是一条可执行命令: 不带参数, 从 **stdin** 读入调用指令 JSON, 把结果 JSON 写到 **stdout**。
- 运行环境和 CLI 用例一样: 验收器启动它时, 环境变量只给最小白名单, 工作目录设为 fixture 目录 (用例自己的增量见 `env` 字段)。
- 双运行时要求: bun 与 node (≥ 22.18, 类型剥离直接跑) 都要能跑, 跟套件其余部分的双运行时纪律一致。

## 2. 指令 (stdin JSON)

```json
{
  "steps": [
    { "as": "<句柄名>", "call": { "export": "<包顶层导出名>", "args": [] } },
    {
      "call": { "on": "<句柄名>", "method": "<方法名>", "args": [] },
      "collectEvents": true
    }
  ]
}
```

- `steps` 是非空数组, 按顺序执行; 每步只能是两种之一:
  - **创建步** `{ as?, call: { export, args } }`: 调用包的公开导出函数;
  - **方法步** `{ as?, call: { on, method, args }, collectEvents? }`: 调用已有句柄上的方法。
- `as` (可选) 把这一步的返回值存成句柄, 供后面的步骤用 `on` 引用; 返回值必须是对象。
- **最后一步的返回值就是输出的 `value`**。
- `$FIXTURE`: 字符串里的这个变量由验收器提前替换成 fixture 根路径 (在指令交给 harness 之前); harness 不用处理。
- `$probe`: 参数里带 `$probe` 键的对象整体替换成探针注册表 (§4) 里对应的值 (对象里其余键一律不参与); 探针名未知就报错。
- `collectEvents: true`: 把事件收集器并入这次调用的最后一个参数 (字段名 `onProgress`): 最后一个参数是对象就合并进去、覆盖原有的 `onProgress`; 否则追加 `{ onProgress }`。收集到的事件累计进输出的 `events`。
- 步骤形状不合法 (既不是创建步也不是方法步)、句柄没定义过、导出或方法不存在, 一律按失败形态输出 (§3), 不静默。

## 3. 输出 (stdout JSON)

成功:

```json
{ "ok": true, "value": "<最后一步的返回值>" }
```

失败:

```json
{
  "ok": false,
  "error": {
    "name": "<错误类名>",
    "code": "<判别码>",
    "message": "<人话>",
    "details": "<可选上下文>"
  }
}
```

- 「失败」包含两类: 被测 API 抛出的任何错误, 和指令本身的问题; 其中 `code` 与 `details` 是可选字段 (被测错误没有判别码时省略); 语料用 `error.code` 做断言时, 匹配的是 `code` 字段 (判别码体系见「可编程 API 面」(packages/sweep-node-modules/docs/designs/api-surface.md) §3.2 的 code 表)。
- **方法步**只要声明过 `collectEvents`, 输出里就带上 `"events": [...]` 字段 (可以是空数组); 创建步不支持这个字段, 声明了就报错。
- **序列化约束**: `value` 必须是能无损 JSON 序列化的落盘 / 审计域数据 (域类型的序列化承诺见「可编程 API 面」§5.1); `ReadonlyMap` 这类查询辅助的返回值不在语料的断言范围内。
- **退出码**: 正常路径恒为 0 (成功失败都用 JSON 表达); 只有 harness 自己产不出 JSON 时 (比如 stdin 非法导致进程崩溃) 才非零退出, 并在 stderr 上写诊断; 这时验收器记一条 `kind: harness` 的失败, 不炸全局。

## 4. 探针注册表 (协议规定的一组名字)

有一类依赖要注入给被测 API, 又没法用 JSON 序列化 (比如 PathStyle / DeviceProbe), 就靠具名探针传进去; 每种语言的实现都要提供**同名的等价物**:

| 探针名                | 形状        | 语义                            |
| --------------------- | ----------- | ------------------------------- |
| `pathops.posix`       | PathStyle   | POSIX 路径风味 (大小写敏感)     |
| `pathops.win32`       | PathStyle   | win32 路径风味 (大小写折叠)     |
| `deviceProbe.uniform` | DeviceProbe | 恒报同一设备号 (同设备基准场景) |

以后按条款的需要增补探针; 增补不破坏既有语料, 清单以本表为准 (参考实现的注册表也要跟着同步)。

## 5. 实现者契约 (转写实施者须知)

- 任何语言的实现, 只要按本协议提供一个 harness 可执行文件 (用 `--api-target` 指定), 就能被 API 用例验收; 除了协议语义, 没有其他义务 (不要求跟参考实现同语言、同内部结构)。
- 这个协议有五处硬性要求: 探针名与语义、错误 JSON 的形状、`$FIXTURE` 的提前替换、`collectEvents` 的合并规则、最后一步的返回值作为 `value`。
- 语料抓不住实现里的哪块, 不代表「没问题」, 那是语料盲区: 对照覆盖表里的豁免登记逐条核对, 跟 CLI 用例同一纪律。

# API harness 协议 (api harness protocol)

> 用途: 定义「被测 API 的黑盒可执行化」契约: api 用例 (语料 `kind: "api"`) 经此协议驱动任意语言的实现做行为等价验收。与 CLI 面「被测命令是参数」完全同构: harness 只是一个可执行命令, 验收器 (`run-conformance.ts`) 零改动即可验收新语言的实现。
> 权威: 字段语义以 [`corpus.schema.json`](corpus.schema.json) 为准; 本文件是协议面 (指令 / 输出 / 探针 / 实现者契约) 的规范正文; 决策依据见 [ADR 0008](../../adrs/0008-transcription-kit.md) 与「转写双面覆盖」设计。
> 参考实现: `scripts/transcription/api-harness.ts` (TypeScript); 被测方亦可自写等价 harness, 唯一的约束是本协议。

## 1. 定位与调用形态

- harness = 一个可执行命令: 不带参数, 调用指令 JSON 经 **stdin** 喂入, 结果 JSON 经 **stdout** 写出。
- 现场语义与 CLI 面同款: 验收器以最小白名单环境变量 + fixture 目录为 cwd 启动它 (语料级增量见 case 的 `env` 字段)。
- 双载体要求: bun 与 node (≥ 22.18, 类型剥离直跑) 两个运行时均须可跑, 与套件其余部分的双载体纪律一致。

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

- `steps` 为非空数组, 按序执行; 每步恰为二者之一:
  - **创建步** `{ as?, call: { export, args } }`: 调用包的公开导出;
  - **方法步** `{ as?, call: { on, method, args }, collectEvents? }`: 调用既有句柄上的方法。
- `as` (可选) 把该步返回值存为句柄供后续 `on` 引用; 返回值须为对象。
- **末步返回值即输出 `value`**。
- `$FIXTURE`: 字符串内的 fixture 根变量由验收器在派发前完成替换, harness 无需处理。
- `$probe`: 参数中含 `$probe` 键的对象整体替换为探针注册表 (§4) 的对应值 (对象内其余键不参与); 未知探针名即报错。
- `collectEvents: true`: 把事件收集器以 `onProgress` 并入该次调用的**末个参数** (末参为对象则合并其中并覆盖既有 `onProgress`; 否则追加 `{ onProgress }`); 收集的事件累计进输出 `events`。
- 步骤形状非法 (既非创建步也非方法步)、句柄未定义、导出或方法不存在, 一律以失败形态输出 (§3), 不静默。

## 3. 输出 (stdout JSON)

成功:

```json
{ "ok": true, "value": "<末步返回值>" }
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

- 「失败」涵盖被测 API 抛出的任何错误与指令缺陷两类; 其中 `code` 与 `details` 为可选字段 (被测错误不带判别码时省略), 语料以 `error.code` 断言时匹配的是 `code` 字段 (判别码体系见「可编程 API 面」(docs/designs/api-surface.md) §3.2 的 code 表)。
- **方法步**声明过 `collectEvents` 即附 `"events": [...]` 字段 (可为空数组); 创建步不支持该字段, 声明即报错。
- **序列化约束**: `value` 须为 JSON 无损的落盘 / 审计域数据 (域类型序列化承诺见「可编程 API 面」§5.1); 查询辅助类返回值 (如 `ReadonlyMap`) 不属语料断言面。
- **退出码**: 正常路径恒为 0 (成功与失败都以 JSON 表达); 仅当 harness 自身无法产出 JSON (如 stdin 非法导致进程崩溃) 才以非零退出 + stderr 诊断; 此时验收器以 `kind: harness` 的失败记录, 不炸全局。

## 4. 探针注册表 (协议规定的命名集合)

注入式参数 (PathStyle / DeviceProbe 一类不可 JSON 序列化的依赖) 经具名探针表达; 语言实现者须提供**同名等价物**:

| 探针名                | 形状        | 语义                          |
| --------------------- | ----------- | ----------------------------- |
| `pathops.posix`       | PathStyle   | POSIX 路径风味 (大小写敏感)   |
| `pathops.win32`       | PathStyle   | win32 路径风味 (大小写折叠)   |
| `deviceProbe.uniform` | DeviceProbe | 恒报同一设备号 (同设备基准面) |

增补探针随条款需求进行; 增补不破坏既有语料, 清单以本表为权威 (参考实现的注册表须同步)。

## 5. 实现者契约 (转写实施者须知)

- 任何语言按本协议提供 harness 可执行 (经 `--api-target` 指定) 即接入 API 面验收; 除协议语义外无其他义务 (不要求与参考实现同语言、同内部结构)。
- 五处为协议硬面: 探针名与语义、错误 JSON 形状、`$FIXTURE` 前置替换、`collectEvents` 的合并规则、末步返回值为 `value`。
- 语料抓不住你实现里的哪块, 不是「没问题」, 是语料盲区: 对照覆盖表的豁免登记逐条核对, 与 CLI 面同一纪律。

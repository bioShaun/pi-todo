# pi-todo

轻量级 Pi 1.3.0 待办事项管理扩展。为复杂任务提供结构化计划跟踪：显式 API 驱动、会话内持久化、TUI 挂件实时反映进度。

## 特性概览

- **独立轻量**：不拦截工具集、不接管对话模式、不通过自然语言猜测进度，完全由显式结构化 API 驱动。
- **原子校验**：任何非法输入都整批拒绝，内存状态与持久化快照均不变；批量中的独立错误一次聚合返回。
- **会话感知**：状态存入会话树，分支切换、压缩恢复后进度不丢。
- **主题化 TUI**：挂件颜色跟随宿主主题，多字节字符安全截断。

## `todo` 工具

单一工具 `todo`，通过 `action` 区分四种操作：

| action | 说明 |
| --- | --- |
| `set` | 批量设定任务列表，**替换**当前全部待办。必须提供 `items` 数组，自动分配 1..N 的 ID，最多 20 项；空数组等价于 `clear`。 |
| `update` | 原子批量更新任务的 `status` / `text` / `reason`，按正整数 `id` 定位。支持在同一批操作中完成上一任务并启动下一任务。 |
| `list` | 查询当前待办列表。 |
| `clear` | 清空待办列表。 |

成功与失败均返回一致的 `structuredContent`（`{ items: [...], error?: string, errors?: string[] }`），便于代码模式（codemode）程序化读取；失败时另带 `isError: true`。批量校验会一次返回所有独立错误：`errors` 为逐条错误，`error` 为汇总文案。

### 任务状态

五种状态，各有约束：

- `pending`（○ 待办）：缺省状态。仅当字段完全未提供时才缺省，显式的空串、`null`、`false` 一律拒绝。
- `in_progress`（◐ 进行中）：全局最多 1 项。
- `completed`（✓ 已完成）
- `cancelled`（⊘ 已取消）：显式记录被放弃的工作，保留任务与 ID，避免用 `set` 重排导致旧 ID 失效；不计入完成数。
- `blocked`（✖ 已阻塞）：进入阻塞时必须提供非空 `reason`（≤240 字符）；已阻塞任务更新时省略原因可沿用已有原因；显式提供空白原因会被拒绝。非阻塞任务（含 `cancelled`）省略原因有效，空字符串或纯空白字符串会规范化为未设置；非空原因仍会校验后丢弃，非字符串或超长原因会被拒绝。离开阻塞状态时自动清理原因。

### 调用示例

创建计划（`set`）：

```json
{
  "action": "set",
  "items": [
    { "text": "搭建测试脚手架", "status": "in_progress" },
    { "text": "实现核心逻辑", "status": "pending" },
    { "text": "通过全量验证", "status": "pending" }
  ]
}
```

更新进度（`update`）：

```json
{
  "action": "update",
  "updates": [
    { "id": 1, "status": "completed" },
    { "id": 2, "status": "in_progress" }
  ]
}
```

标记阻塞（`update`，必须附原因）：

```json
{
  "action": "update",
  "updates": [
    { "id": 2, "status": "blocked", "reason": "等待上游接口联调环境" }
  ]
}
```

清空（`clear`）：

```json
{ "action": "clear" }
```

## TUI 挂件与命令

- 挂件以组件工厂函数注册（`render(width: number)`），动态适应终端实际宽度；通过 `@earendil-works/pi-tui` 的 `truncateToWidth` / `visibleWidth` 正确处理 CJK 与 Emoji 宽度。
- 默认展开，最多显示 6 项任务；超出时优先选择进行中、受阻、待办、已完成，最后补入已取消项，同类优先选择编号较小的任务，最终按 ID 顺序展示。全部完成也不自动折叠，空列表隐藏。
- 左侧轻量竖线界定任务区域，编号按列表内最大编号等宽对齐。摘要显示 `▾ 待办 2/6 完成 · 1 项受阻 · 1 项取消`；全部完成显示 `6/6 全部完成`。
- `Alt+T` 切换整个列表的展开/折叠；`/todos toggle` 提供同等操作。折叠后仅保留实时更新的进度摘要和受阻计数。Pi 的 `Ctrl+T` 仍用于思考内容切换。
- 展开/折叠是临时显示偏好，不修改任务、不写入快照。普通更新和查询保留选择；成功设定新计划、清空、会话启动或分支切换后恢复默认展开。空列表按快捷键会提示“暂无待办事项”。
- 配色跟随宿主主题：`✖` 阻塞（warning）、`◐` 进行中（accent、加粗）、`○` 待办（muted）、`✓` 已完成（success，文本使用 muted）、`⊘` 已取消（dim）。阻塞原因在下一行以 `└` 缩进显示。
- 挂件任务名和原因按终端宽度安全截断；标题宽度不足时优先省略快捷键提示，保留进度信息。标题不绘制进度条或百分比。
- `/todos` 打开只读详情页，任务名与阻塞原因完整换行；`↑/↓` 滚动、`PgUp/PgDn` 翻页、`Home/End` 到首尾、`Esc` 关闭。页面随终端宽高变化重新排版。
- 计划超过 6 项时，挂件底部显示“另有 N 项 · /todos 查看全部”；摘要始终统计整个计划。显示限制不影响任务存储、工具查询或 `/todos` 完整详情。
- 终端安全过滤：所有展示文本去除 C0/C1 控制字符、OSC/DCS 转义序列、Unicode Bidi 控制符并折叠连续换行，防止任务内容注入终端控制序列。

## 持久化与上下文快照

- 每次**实际**变更后通过 `pi.appendEntry('pi-todo-state', { version: 1, items: [...] })` 将快照写入会话树；内容相同的 `set`、无字段变化的 `update`、清空已空列表等 no-op 不追加条目，但仍返回成功。
- 会话启动（`session_start`，覆盖 startup / new / reload / resume / fork）与分支切换（`session_tree`）只读取**当前分支**的最新快照；空分支或非法快照安全重置为空并告警，不回退到旧快照。
- **前缀缓存友好（Prompt Cache Preservation）**：不使用 `context` 钩子过滤或重写历史消息。工具执行成功且实际改变列表后（`set` / `update` / `clear`），通过 `pi.sendMessage` 追加持久隐藏的 `customType: 'pi-todo-context'` 快照（`{ triggerTurn: false }`）；`list`、执行失败或无实质变更（no-op）不追加。
- 任务全部完成、全部取消或清空时追加空列表快照（`{"todos":[]}`），覆盖旧状态语义且不破坏历史；仍有未关闭任务时快照保留完整计划（含已完成/已取消项）作为审计轨迹；快照内容不含易变时间戳。
- 会话启动、分支切换（`session_start` / `session_tree`）与压缩后（`session_compact`），检查当前压缩感知投影（`buildSessionProjection().messages`）中最新的快照；仅当快照缺失或内容不一致时才追加恢复一次，同内容快照不重复追加。压缩重试（`willRetry: true`）通过 `deliverAs: 'steer'` 投递。
- 前缀只追加特性已通过宿主 `convertToLlm` 与 `convertResponsesMessages` 离线投影验证，并完成线上短间隔缓存复用验证；这不代表已核对远端完整 HTTP 请求或长期缓存保留策略，详见下方故障记录。

### 已知陷阱：临时快照移动导致缓存反复失效

2026-10-20 修复（`c634801`）：旧实现每次请求在 `context` 钩子中过滤所有 `pi-todo-context`，再把当前快照临时追加到消息末尾。即使快照 JSON 完全相同，下一轮新增的 assistant / tool 消息也会占据旧快照的位置，快照则移到更后面。上一轮的消息序列因此不再是下一轮的完整前缀，缓存只能复用到首次差异之前。

**不要重新引入“删除旧快照，再在请求尾部注入最新快照”的方案。** 正确方式是把快照作为持久隐藏消息追加到会话历史，后续请求保留其原位置。Pi 1.3.0 在 streaming 期间会把 `{ triggerTurn: false }` 的消息放入待投递队列，在 `turn_end`、本轮所有工具结果写入后刷新；快照不能插到 assistant toolCall 与对应 toolResult 之间。

故障表现与线上复测如下（时间为北京时间，token 数来自宿主记录的 usage；`prompt = input + cacheRead + cacheWrite`，命中率为 `cacheRead / prompt`）：

| 场景 | 模型 | 时间 | prompt tokens | cacheRead tokens | 观察 |
| --- | --- | --- | ---: | ---: | --- |
| 旧实现，已注入待办 | `tcuni/gpt-6-astra` | 22:38:40、22:38:53 | — | 两轮均为 82,944 | 间隔 13 秒，仍提示约 99k、103k token 重新计费 |
| 新实现，reload 后首轮 | `tcuni/gpt-6.1-sol` | 23:13:18 | 178,348 | 0 | 首轮全 miss |
| 新实现，下一轮 | 同上 | 23:13:35 | 179,305 | 178,176 | 命中率 99.37% |
| 新实现，活动待办变更后 | 同上 | 23:15:12 | 183,562 | 182,784 | 命中率 99.58% |
| 新实现，全部完成后 | 同上 | 23:15:26 | 184,719 | 184,448 | 命中率 99.85% |

旧实现两轮之间没有切换模型或压缩。新实现复测中，`cacheRead` 随上下文增长，活动待办更新和全部完成后的空快照也能继续复用缓存。这两组使用不同模型，是故障与修复后的观察记录，不是同模型成本对照实验。

排查与验收步骤：

1. 更新插件后，在每个已运行窗口分别 `/reload`；触发一次实际待办变更后，检查会话 JSONL 中是否出现持久的 `custom_message`（`customType: "pi-todo-context"`、`display: false`）。本次 reload 后首轮发生全 miss，下一轮恢复高命中；不能据此认定每次 reload 都会 miss。
2. 保留一项活动待办，连续执行工具并发起模型请求，再更新待办状态、标记全部完成。逐轮比较 usage 中的 `cacheRead` 是否随可复用前缀增长，并检查快照位于本轮工具结果之后。单看快照内容相同或挂件正常不足以确认缓存兼容。
3. 若短间隔内 `cacheRead` 长期停在同一位置，先检查上下文前缀是否被过滤、重排或重写，再结合服务端信息排查 TTL。`Cache miss` 提示是 Pi 按 usage 和模型单价估算的重新计费成本，并不是平台额外收取的一笔费用。
4. 修改上下文逻辑时运行 `npm test` 与 `node scripts/host-smoke.mjs`：覆盖真实消息转换的前缀断言、同一 turn 的 `A → B → A`、分支恢复、压缩恢复及重试投递。每次真实状态变化都应排队；streaming 时持久投影尚未包含队列中的 B，不能用它把最后的 A 当作重复快照跳过。

验证范围：已覆盖本地宿主投影、工具结果与快照顺序，以及线上短间隔 usage。未保存远端原始 HTTP 请求，不能完全排除代理因素；尚未验证长时间空闲、30 分钟 TTL 或代理端缓存保留策略。缓存有效期与消息前缀稳定性需要分别验证。

## 模型使用指引

工具注册了 `promptGuidelines`，引导模型正确使用待办：

- 多步任务用 3–6 步的短计划；简单问答或单步任务不建待办。
- 只在里程碑处显式更新状态；同时最多 1 项进行中；阻塞必须给原因。
- 被放弃的工作标 `cancelled`，不要用 `set` 重排或把未完成工作标成 `completed`。
- 委派给子代理的实现不等于已验证完成：核对证据后才标 `completed`。
- 切换到无关任务时替换或清空计划。

## 安装

从 GitHub 安装到个人配置，然后在当前会话执行 `/reload`（或重新启动 Pi）：

```bash
pi install git@github.com:bioShaun/pi-todo.git
# 或 HTTPS
pi install https://github.com/bioShaun/pi-todo.git
```

安装器会把该来源记录到 `~/.pi/agent/settings.json`，这是正常行为。也可以直接在配置中声明：

```json
{
  "packages": [
    { "source": "git@github.com:bioShaun/pi-todo.git" }
  ]
}
```

或者克隆本仓库后单次加载：

```bash
git clone git@github.com:bioShaun/pi-todo.git
pi --extension ./pi-todo/index.ts
```

## 测试

使用 Node.js 内置测试运行器，自动推导本地 Pi 安装路径：

```bash
npm test
```

显式指定主机依赖路径：

```bash
PI_TEST_HOST_ROOT="$HOME/.pi/agent/install/releases/1.3.0/node_modules" npm test
```

真实宿主 SDK 离线验收（无需模型请求），覆盖宿主加载、真实工具包装、JSONL 会话写入、重新打开会话、树分支切换与上下文恢复；证据写入 `.work/`，交互终端的人工视觉检查另行进行：

```bash
node scripts/host-smoke.mjs
```

## 约束与常量

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `MAX_ITEMS` | 20 | 单次计划最多任务数 |
| `MAX_TEXT` | 160 字符 | 任务标题长度上限 |
| `MAX_REASON` | 240 字符 | 阻塞原因长度上限 |

非法输入一律整批原子拒绝（返回 `isError: true`，不修改内存、不写入快照），包括：未知 ID、重复 ID、空标题、超限文本、阻塞缺少原因、多项同时进行中等。一次批量中的多个独立错误会聚合到 `structuredContent.errors` 一并返回，模型无需逐轮试错。

## 项目结构

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 扩展入口：注册 `todo` 工具、`/todos` 命令、挂件与事件处理 |
| `context.ts` | 消息上下文辅助：持久快照格式化、投影快照提取与恢复判定 |
| `state.ts` | `TodoStateManager`：状态模型、批量校验与错误聚合、列表相等判断、快照提交与分支恢复 |
| `view.ts` | 纯渲染函数：挂件行、对话框文本、终端安全过滤 |
| `scripts/host-smoke.mjs` | 真实宿主 SDK 离线验收脚本（无模型网络请求） |
| `tests/` | Node.js 内置测试用例（状态、边界、UI、前缀缓存与上下文恢复） |

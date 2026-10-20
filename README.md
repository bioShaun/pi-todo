# pi-todo

轻量级 Pi 1.3.0 待办事项管理扩展。为复杂任务提供结构化计划跟踪：显式 API 驱动、会话内持久化、TUI 挂件实时反映进度。

## 特性概览

- **独立轻量**：不拦截工具集、不接管对话模式、不通过自然语言猜测进度，完全由显式结构化 API 驱动。
- **原子校验**：任何非法输入都整批拒绝，内存状态与持久化快照均不变。
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

成功与失败均返回一致的 `structuredContent`（`{ items: [...], error?: string }`），便于代码模式（codemode）程序化读取；失败时另带 `isError: true`。

### 任务状态

四种状态，各有约束：

- `pending`（○ 待办）：缺省状态。仅当字段完全未提供时才缺省，显式的空串、`null`、`false` 一律拒绝。
- `in_progress`（◐ 进行中）：全局最多 1 项。
- `completed`（✓ 已完成）
- `blocked`（✖ 已阻塞）：进入阻塞时必须提供非空 `reason`（≤240 字符）；同一批次重复标记阻塞可沿用已有原因；离开阻塞状态时自动清理原因；在非阻塞任务上提供非法 `reason` 会被拒绝。

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
- 默认展开整个列表，按 ID 顺序显示所有任务（最多 20 项），完成项原位保留；全部完成也不自动折叠，空列表隐藏。
- 左侧轻量竖线界定任务区域，编号按列表内最大编号等宽对齐。摘要显示 `▾ 待办 2/6 完成 · 1 项受阻`；全部完成显示 `6/6 全部完成`。
- `Alt+T` 切换整个列表的展开/折叠；`/todos toggle` 提供同等操作。折叠后仅保留实时更新的进度摘要和受阻计数。Pi 的 `Ctrl+T` 仍用于思考内容切换。
- 展开/折叠是临时显示偏好，不修改任务、不写入快照。普通更新和查询保留选择；成功设定新计划、清空、会话启动或分支切换后恢复默认展开。空列表按快捷键会提示“暂无待办事项”。
- 配色跟随宿主主题：`✖` 阻塞（warning）、`◐` 进行中（accent、加粗）、`○` 待办（muted）、`✓` 已完成（success，文本使用 muted）。阻塞原因在下一行以 `└` 缩进显示。
- 挂件任务名和原因按终端宽度安全截断；标题宽度不足时优先省略快捷键提示，保留进度信息。标题不绘制进度条或百分比。
- `/todos` 打开只读详情页，任务名与阻塞原因完整换行；`↑/↓` 滚动、`PgUp/PgDn` 翻页、`Home/End` 到首尾、`Esc` 关闭。页面随终端宽高变化重新排版。
- 展开挂件不按状态筛掉任务；计划较长时可手动折叠，再通过 `/todos` 分页查看完整内容。
- 终端安全过滤：所有展示文本去除 C0/C1 控制字符、OSC/DCS 转义序列、Unicode Bidi 控制符并折叠连续换行，防止任务内容注入终端控制序列。

## 持久化与上下文恢复

- 每次成功变更后通过 `pi.appendEntry('pi-todo-state', { version: 1, items: [...] })` 将快照写入会话树。
- 会话启动（`session_start`，覆盖 startup / new / reload / resume / fork）与分支切换（`session_tree`）只读取**当前分支**的最新快照；空分支或非法快照安全重置为空并告警，不回退到旧快照。
- 上下文压缩（`context`）后自动注入单条短时上下文消息（`customType: 'pi-todo-context'`），并过滤历史中的旧注入；仅在存在未完成任务时注入。

## 模型使用指引

工具注册了 `promptGuidelines`，引导模型正确使用待办：

- 多步任务用 3–6 步的短计划；简单问答或单步任务不建待办。
- 只在里程碑处显式更新状态；同时最多 1 项进行中；阻塞必须给原因。
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

非法输入一律整批原子拒绝（返回 `isError: true`，不修改内存、不写入快照），包括：未知 ID、重复 ID、空标题、超限文本、阻塞缺少原因、多项同时进行中等。

## 项目结构

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 扩展入口：注册 `todo` 工具、`/todos` 命令、挂件与事件处理 |
| `state.ts` | `TodoStateManager`：状态模型、校验、快照提交与分支恢复 |
| `view.ts` | 纯渲染函数：挂件行、对话框文本、终端安全过滤 |
| `scripts/host-smoke.mjs` | 真实宿主 SDK 离线验收脚本 |
| `tests/` | Node.js 内置测试用例 |

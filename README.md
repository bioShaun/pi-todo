# pi-todo

轻量级独立 Pi 1.3.0 待办事项管理扩展（Todo Extension）。

## 特性

- **独立性**：独立于 `pi-planner-only`，不拦截工具集、不自动接管对话模式、不通过自然语言猜测进度，完全通过显式结构化 API 驱动。
- **结构化工具 API (`todo`)**：
  - `set`：批量设定任务列表（替换当前所有待办事项），必须提供显式 `items` 数组，自动分配正整数 ID（1..N），最多支持 20 项。
  - `update`：原子批量更新任务状态、标题或阻塞原因（必须提供正整数 ID，支持在一批操作中完成上一任务并启动下一任务）。
  - `list`：查询当前待办事项列表。
  - `clear`：清空待办列表。
  - 声明 `outputSchema`：针对成功与失败调用均返回一致的 `structuredContent`（`{ items: [...], error?: string }`），便于代码模式（codemode）程序化读取。
- **四种任务状态**：
  - `pending`（[待办]）：缺省状态（仅在未指定 status 时缺省为 pending，严格拒绝空串、null、false）。
  - `in_progress`（[进行中]）：全局最多只能有 1 项处于进行中。
  - `completed`（[已完成]）
  - `blocked`（[已阻塞]）：设置为阻塞时必须提供非空 `reason`（<=240 字符）；离开阻塞状态时自动清理历史原因；非阻塞任务上提供非法 reason 亦会被拒绝。
- **终端交互与 TUI 挂件**：
  - 挂件以组件工厂函数注册（`render(width: number)`），动态适应终端视口实际宽度，不采用固定字符宽度。
  - 采用 `@earendil-works/pi-tui` 的 `truncateToWidth` 与 `visibleWidth` 处理多字节 CJK 与 Emoji 字符宽度截断。
  - 编辑器上方展示 1 行纯文字标题（`待办 1/3`，任务行被截断时追加 `还有 N 项`），下接按 ID 顺序排列的任务行，最多 6 行；已完成任务同样显示。
  - 任务行超过 6 行时优先保留可执行任务（已阻塞 > 进行中 > 最早的待办），展示顺序仍为 ID 顺序。
  - 状态字形与主题语义色对齐宿主风格：`✖` 已阻塞（warning）、`◐` 进行中（accent，加粗）、`○` 待办（muted）、`✓` 已完成（success）；已完成文本以弱化色渲染，阻塞原因以警示色内联显示在任务行尾。
  - 全部完成时自动折叠为单行（`✓ 2/2 全部完成`）；待办为空时自动隐藏挂件。
  - 标题不绘制进度条或百分比：深色主题下低对比度的轨道字形几乎不可见，纯文字计数在任何背景下都清晰，且在极窄宽度下自然降级截断，不写入任何未闭合的 ANSI 序列。
  - `/todos` 斜杠命令：弹出只读滚动列表对话框，标题显示 `待办事项 · 1/4 完成 (按 ESC 退出)`，选项为 `✓ #1 任务` 形式并附阻塞原因，按 ESC 退出。
  - 终端安全过滤：去除 C0/C1 控制字符、OSC/DCS 序列、Unicode Bidi 控制符并折叠连续换行。
- **快照持久化与上下文感知**：
  - 状态通过 `pi.appendEntry('pi-todo-state', { version: 1, items: [...] })` 存储于会话树中。
  - 会话启动 (`session_start`，支持 startup, new, reload, resume, fork 等原因) 与分支切换 (`session_tree`) 仅读取当前分支最新快照；空分支或最新快照非法安全重置为空并提供告警，不回退到旧快照。
  - 上下文恢复 (`context`)：在对话压缩后自动向模型注入单条短时上下文消息（`customType: 'pi-todo-context'`），过滤旧历史，且仅在存在未完成任务时注入。

## 工具调用示例

### 1. 创建待办计划 (`set`)
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

### 2. 更新任务进度 (`update`)
```json
{
  "action": "update",
  "updates": [
    { "id": 1, "status": "completed" },
    { "id": 2, "status": "in_progress" }
  ]
}
```

### 3. 清空待办计划 (`clear`)
```json
{
  "action": "clear"
}
```

## 安装与配置

从 GitHub 安装到个人配置，然后在当前会话执行 `/reload`（或重新启动 Pi）：

```bash
pi install git@github.com:bioShaun/pi-todo.git
```

也可以通过 HTTPS 安装：

```bash
pi install https://github.com/bioShaun/pi-todo.git
```

安装器会把该来源记录到 `~/.pi/agent/settings.json`，这是正常行为。也可以在配置中直接使用：

```json
{
  "packages": [
    {
      "source": "git@github.com:bioShaun/pi-todo.git"
    }
  ]
}
```

或者克隆本仓库后通过命令行单次加载：

```bash
git clone git@github.com:bioShaun/pi-todo.git
pi --extension ./pi-todo/index.ts
```

## 测试

本项目使用 Node.js 内置测试运行器，支持自动推导本地 Pi 安装路径：

```bash
npm test
```

也可以显式指定主机依赖路径：

```bash
PI_TEST_HOST_ROOT="$HOME/.pi/agent/install/releases/1.3.0/node_modules" npm test
```

使用真实宿主 SDK 做离线验收（无需模型请求）：

```bash
node scripts/host-smoke.mjs
```

脚本覆盖宿主加载、真实工具包装、JSONL 会话写入、重新打开会话、树分支切换与上下文恢复。证据写入 `.work/`；交互终端的人工视觉检查另行进行。

## 约束与常量

- `MAX_ITEMS`: 20
- `MAX_TEXT`: 160 字符
- `MAX_REASON`: 240 字符
- 任何非法输入（未知 ID、重复 ID、标题为空、阻塞缺少原因、多项进行中等）均保持操作的原子性：不修改内存状态、不产生持久化快照，并返回 `isError: true`。

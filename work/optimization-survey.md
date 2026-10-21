# pi-todo 优化调研

2026-10-21 调研。对比主流 todo 工具的优点，评估哪些适合移植到 pi-todo。

## 主流工具的优点对照

### 面向人的 CLI 工具

| 工具 | 核心优点 |
|---|---|
| **Taskwarrior** | `depends:` 依赖图（blocked/blocking 由边派生而非状态）；urgency 综合排序（优先级+到期日+依赖等多项加权）；`undo` 回滚；annotations 任务附注；`next` 报告给出最该做的任务；JSON export |
| **todo.txt** | 一行一任务的纯文本格式，完全用户可携带；`(A)` 优先级、`+project`、`@context`、`due:` 全部内联；`done.txt` 归档 |
| **dstask** | git 原生同步与 undo；每任务一份 markdown 笔记（可放 checklist）；context 自动过滤；P0–P3 优先级 |

### 面向 Agent 的工具

| 工具 | 核心优点 |
|---|---|
| **Claude Code TodoWrite** | 语义极简：整表替换、恰好一个 in_progress；`activeForm` 进行时态文案改善 UI 展示；工具结果内嵌重复指令提升遵从度 |
| **opencode todowrite** | `cancelled` 状态显式记录被砍范围（而不是让任务消失）；`priority` 字段（high/medium/low）；指引建议"阻塞时保持 in_progress 并新增描述阻塞的 follow-up todo" |
| **gemini-cli write_todos** | 状态含 `blocked`/`cancelled`；Ctrl+T 切换完整列表；结果回执 "Set N todo(s)" |
| **beads (bd)** | agent 原生设计：`blocked` 是**依赖边**而非状态，`bd ready` 计算无 blocker 的可开工前沿；blocker 关闭自动解锁；hash ID 防多智能体冲突；审计轨迹；跨会话记忆衰减 |

### pi-todo 现状定位

pi-todo 在 agent todo 工具里已经偏强，具备多数工具没有的能力：跨 compaction/分支导航的持久化、提示缓存前缀安全、原子批量更新、结构化输出（outputSchema）、UI 消毒与 CJK/emoji 宽度处理。

## 候选优化点（按性价比排序）

### 1. 批量错误聚合 —— 推荐

**现状**：`set`/`update`/`validateSnapshotItems` 遇到第一个错误即返回。模型修完一个错误重试后才会撞见下一个。

**做法**：校验阶段收集每项的错误，`{items: [...], errors: ["item 2: ...", "item 5: ..."]}` 合并进单次响应（拼接 `structuredContent.error`，或新增 `errors` 数组并同步 `outputSchema`/README）。原子性不变：全部错误先收集，任一失败仍整体不落盘。

**收益**：减少 agent 往返轮次；对 20 项上限的批量 `set` 尤其明显。**成本**：低。

### 2. `cancelled` 状态 —— 推荐

**现状**：取消一个已规划任务只能 `set` 整表重排，所有任务 ID 重新编号 —— 此前任何对旧 ID 的引用（reason 文本、会话记录）全部失效，且被取消的任务从当前计划与注入上下文中消失（session 快照历史仍在）。

**做法**：status 增加 `cancelled` literal；widget/dialog 用 dim/划线样式展示（或不计入口径视设计而定）；读取既有 v1 快照无需迁移（status 是字符串），但旧版本扩展不认识新状态，混合版本或降级时会按损坏快照重置；若需跨版本共存应升 snapshot version；约束不变（不参与 in_progress 计数）。

**收益**：保留"曾经计划过但被砍掉"的审计痕迹，ID 稳定。opencode、gemini-cli 均已验证此状态对 agent 场景有用。**成本**：低。

### 3. no-op 不持久化 —— 推荐

**现状**：`update` 无实际变化仍调用 `commitState` 追加 `pi-todo-state` 条目；内容相同的 `set` 同理。context 快照已按 items 比对去重，但 state entry 没有。

**做法**：`commitState` 前复用与 `context.ts` 相同的列表相等判断比较 candidate 与当前 items（建议把 helper 下沉到 `state.ts`，避免 state 层反向依赖 context 层），相同则跳过 `appendEntryFn`（仍返回 success）。注意区分"持久化失败"与"无需持久化"，前者仍须报错。

**收益**：减少 session JSONL 冗余条目。**成本**：极低。

### 4. 结构化阻塞 `blockedBy: [ids]` —— 持保留意见

**调研结论**：依赖图是 Taskwarrior 和 beads 的标志性能力 —— `blocked` 由边派生、blocker 完成自动解锁、`ready` 计算可开工集合。

**评估**：对 pi-todo（≤20 项、单会话计划）偏重。需要依赖存在性校验、环检测、快照 v2、widget 展示改动。当前 ID 顺序≈计划顺序，`reason` 自由文本已能让模型写出 "waiting on #2"。

**若未来需要**：建模为边（`blockedBy: [id]`）而非解析文本；blocker 完成时自动解锁（或至少在 `list` 中标记"可解锁"）；`ready` 语义 = pending 且无未关闭 blocker。

### 5. schema 级约束 —— 可选

**做法**：`items[].reason` 用 TypeBox 联合类型编码 —— `{status: "blocked", reason: 必填非空}` 与 `{status: 其他}` 两个变体，让宿主参数校验在工具执行前拦截非法调用。

**权衡**：schema 复杂度上升；运行时校验逻辑不变（防御层仍需要，绕过 schema 的调用与快照恢复都走它）。**成本**：中。

### 6. `activeForm` 进行时文案 —— 可选

**做法**：item 增加可选 `activeForm` 字段（"Running tests"），in_progress 时 widget/dialog 优先展示。借鉴 Claude Code。

**评估**：低成本低收益。schema 略重，展示收益有限。

### 明确不建议做

- **priority 字段**：≤20 项的单会话计划中，ID 顺序即计划顺序；加字段只增加 schema 重量。
- **时间戳进上下文快照**：CLAUDE.md 明确禁止 volatile 数据进入 `pi-todo-context`（缓存前缀不变性）。如需审计时间可只写 session entry、不进 context，但收益存疑。
- **in_progress 自动降级**：标记 B 为 in_progress 时自动把 A 降回 pending —— 当前的严格报错迫使模型显式表达意图，对 agent 更可靠。
- **依赖文本解析**（如从 reason 里抠 `#2`）：hack 且不可靠；要做就做第 4 项的结构化边。

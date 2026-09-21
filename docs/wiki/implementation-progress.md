# Agent 实施进度

## 2026-09-21：Phase 0 / Slice 1

状态：完成。

### 本切片范围

- AG10：建立最小 deterministic scenario harness。
- AG1：将最近事件从完整持久化事件改为字段级运行时 allowlist 投影。
- AG1：将持久化 checkpoint 改为有界认知摘要，隔离数据库标识符。
- 明确排除：AG4、AG6、真实模型评测、Tool/Runtime 扩建。

### 已交付

- 新增独立 `@focusloop/agent-evals` 包：版本化场景、受限路径解析、确定性 runner、结果与隐私断言。
- 新增 6 个 AG1 固定 JSON 场景：正常上下文、无 Session、材料/事件边界、跨课程隔离、恶意 payload、URL/密钥/表单等敏感哨兵。
- 新增 `AgentContextEvent` 闭集合同：13 类事件逐类型投影。
- Agent Context 不再携带事件 id、session id、`TAB_LEFT.origin` 或未知 payload 字段。
- Agent Context checkpoint 不再携带 checkpoint/session/concept/task 持久化 id；文本、列表和消息参数均有显式上限。
- 非法事件、错误类型、负数/非有限时长、超长事件标识被拒绝并记录 omission。
- Inspector 与 Tutor 增加上下文边界说明；隐私文档区分本地持久化、AG1 报告和 Tutor 送模内容。

### 验收证据

- AG1 固定场景：全部通过，重复运行结果一致。
- `@focusloop/agent-evals`：9 项测试通过；typecheck、lint 通过。
- `@focusloop/agent-core`：227 项测试通过；typecheck、lint 通过。
- `@focusloop/shared-types`：13 项测试通过；typecheck、lint 通过。
- Desktop typecheck 通过。
- 仓库级 test、typecheck、lint、build、文档校验和格式校验通过。

### 下一切片

按实施路线进入 Phase 1：AG5 Resume 三档策略与 resume success metric；同时扩充 AG10 的 AG5 deterministic scenarios。暂不引入新 LLM 能力。

## 2026-09-21：Phase 1 / Slice 2

状态：完成。

### 本切片范围

- AG5：Short/Medium/Long 三档 Resume 策略与 30 秒长期离开回忆步骤。
- AG5：接受恢复后 5 分钟 success evaluator 与 Dashboard 汇总。
- AG10：直接驱动生产 continuity 纯函数的 AG5 deterministic scenarios。
- 明确排除：Tutor/Rescue 卡点摘要、adaptive task、材料章节跳转、长期记忆、新 LLM 能力。

### 已交付

- `ResumePolicyConfig` 集中管理 15 分钟、24 小时和 5 分钟成功窗口；边界等于阈值时进入更高档。
- `ResumeCard` 返回 `variant/gapMs/refresher`；缺失或非法 gap 保守使用 Medium。
- Short UI 不展开历史列表；Long UI 展示专用 30 秒快速回忆提示。
- success 从 timing、checkpoint、events 和当前时间纯派生；pending 不进入成功率分母，dismissed/未选择不进入样本。
- Store 提供按 Session 稳定排序的 Resume timing 读取；无需数据库迁移，重启后可重算。
- Dashboard 展示成功率、已评估样本和 pending 数量。
- AG10 增加 9 个 AG5 固定场景，覆盖 1/10/15 分钟、24 小时、缺失 gap、成功、过期、pending 和重复事件。

### 验收证据

- 仓库级 737 项测试通过。
- `@focusloop/continuity`：41 项测试通过；`@focusloop/agent-core`：230 项测试通过；`@focusloop/persistence`：48 项测试通过。
- `@focusloop/agent-evals`：12 项测试通过，其中 AG5 场景重复运行结果一致。
- 全仓库 typecheck、lint、build、文档、Prettier 和 diff whitespace 校验通过。
- Desktop E2E 在启动应用前被当前 Electron/Playwright 组合阻断：Electron 拒绝 Playwright 注入的 `--remote-debugging-port=0`；没有执行到产品断言，单独作为测试基础设施问题处理。

### 下一切片

AG2 Stuck Rescue 的 Phase 1 确定性策略、救援计划、桌面交互与 outcome evaluator 已收口；后续仍需 AG4/AG8 的结构性任务和工具执行，完整 E2E 当前受运行环境阻塞。AG5 的 Tutor/Rescue 卡点证据与 adaptive restore 留到其依赖能力形成后完成。

## 2026-09-22：Phase 1 / AG2 deterministic rescue slice

状态：部分形成；AG2 Phase 1 已完成，AG4、AG8 和可执行的完整 E2E 仍未完成。

### 本切片范围

- AG2：把 eval adapter 接到生产 `decideIntervention` → `buildRescuePlan` →
  `evaluateRescueSuccess` 路径，而不是在 adapter 内复制 reason/action 表。
- AG10：扩充 AG2 的 happy/edge/adversarial JSON fixtures，覆盖无 reason、未知 reason、
  `OVERLOADED` 下明确 reason 优先级、缺失 `acceptedAt`、跨 session/task、未来事件、重复事件和
  repeated-help precedence，并断言 `stepKeys`、`estimatedMinutes`、`source` 与 evidence ids。
- AG10 的当前交付仍只是 deterministic、同步、JSON-only runner；不包含真实模型、provider、
  tool/store 集成或完整端到端门禁。

### 已知未完成

- AG2 已有 offered → accept → plan → continue 桌面链路，以及 BREAK 暂停/恢复计时器的 E2E；
  该测试当前在应用启动前被 Electron 44 拒绝 `--remote-debugging-port=0` 阻塞。
- 临时任务变更、工具执行和完整六类 E2E 仍需 AG4/AG8 action contract。
- AG4 Task Adaptation 尚未形成；AG8 Tools & Actions 尚未形成（确认、幂等、审计和越权测试仍待交付）。

### 验收证据

- 全仓库 764 项 Vitest 测试通过；12 个项目 typecheck、12 个项目 lint、11 个项目 build 通过。
- AG2 生产策略测试覆盖明确 reason 在 `OVERLOADED` 下仍按固定映射执行。
- AG2 生命周期覆盖 latest-request-wins、accept/dismiss/continue 幂等和跨 Session/任务拒绝。
- AG10 共 18 个 AG2 JSON 场景；重复运行结果一致，并覆盖 happy/edge/adversarial。
- Scaffolding、workflow、docs、theme token、Prettier 和 diff whitespace 校验通过。

### 下一切片

按路线进入 AG9 Model Runtime 基础合同；在 AG8 confirmation/idempotency 形成前，不开放 AG4 的结构性任务写入。

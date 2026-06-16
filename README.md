# Topic Router

OpenClaw 话题路由插件 — 自动将私聊消息按话题分流到独立 session，让 AI 在每个话题中保持完整上下文。

## 快速部署

```bash
# 任意 OpenClaw 容器上执行（一行搞定）
curl -fsSL https://raw.githubusercontent.com/FlanTHU/claude-code-worker/main/deploy.sh | bash
```

手动部署：

```bash
REPO=/root/.openclaw/workspace/code-repo
[ -d "$REPO/.git" ] && (cd "$REPO" && git pull origin main) || \
  (mkdir -p "$(dirname $REPO)" && git clone -b main https://github.com/FlanTHU/claude-code-worker.git "$REPO")
cd "$REPO" && FORCE_BOOTSTRAP=1 bash bootstrap.sh
```

> **拉取超时排查**：容器到 GitHub 偶发 `curl 28`（慢速超时）或 `GnuTLS recv error`。这是网络层问题，**不是证书问题** —— 用 `git -c http.version=HTTP/1.1` + 重试即可，**不要关闭 `http.sslVerify`**（GitHub 证书有效，关校验只会引入中间人风险且救不了超时）。例：`for i in 1 2 3; do git -c http.version=HTTP/1.1 clone ... && break; sleep 5; done`。

代码更新（不重新 patch gateway）：

```bash
cd /root/.openclaw/workspace/code-repo && bash redeploy.sh
```

---

## 用户手册

### 核心概念

| 概念 | 说明 |
|------|------|
| **话题 (Topic)** | 一个独立的对话主题，拥有自己的 session。比如"写代码"和"问天气"是两个话题 |
| **自动路由** | 发消息时系统自动判断属于哪个话题，无需手动切换 |
| **自学习 (V4)** | 系统从你的纠正行为中学习，逐步提高路由准确度 |

### 命令

| 命令 | 作用 | 示例 |
|------|------|------|
| `/topic-router on` | 开启话题路由 | `/topic-router on` |
| `/topic-router off` | 关闭话题路由（消息直接进入默认 session） | `/topic-router off` |
| `/topic-router` | 查看当前开关状态 | `/topic-router` |
| `/topics` | 查看所有话题列表 | `/topics` |
| `/switch <标签>` | 切换到指定话题（支持中文名称模糊匹配） | `/switch coding` 或 `/switch Redis缓存` |
| `/newtopic <标签>` | 手动创建新话题 | `/newtopic travel` |
| `/end` | 结束当前话题 | `/end` |
| `/endall` | 清理全部话题 | `/endall` |

> `/topic-router off` 关闭后，所有消息直接进入默认 session，不做话题分类和路由。`/topics`、`/switch` 等管理命令仍然可用。开关状态持久化到磁盘，gateway 重启后保持。

> 大多数情况下不需要手动操作。直接聊天，系统会自动识别和路由。命令主要用于纠正误判。

### 工作流程

#### 日常使用（零操作）

```
发送消息 → 系统判断 → ┬─ 属于当前话题 → 继续当前session ─┐
                      ├─ 属于其他话题 → 自动切换session ─┤→ AI回复带话题标记
                      └─ 全新主题     → 自动创建新话题 ─┘
```

1. 你正常发消息
2. 系统自动判断话题归属
3. 消息被路由到对应话题的独立 session
4. AI 在该话题的完整上下文中回复
5. 回复末尾带有话题标记（如 `📌 话题: Redis缓存编码`）

#### 纠正误判

当系统判断错误时，你的纠正会被记录用于自学习：

| 场景 | 你的操作 | 系统学习 |
|------|----------|----------|
| 系统把消息路由到了错误话题 | `/switch 正确话题` | 记录误判，提高阈值 |
| 系统延续了当前话题，但你想聊新的 | `/newtopic 新标签` | 记录漏判，降低分裂阈值 |
| 系统自动创建了新话题，但你想回去 | `/switch 原话题` | 自动合并，记录误创建 |

### 自动路由机制

系统使用分层分类策略，从快到慢逐级判断：

**L0: 显式命令** — `/switch`、`/newtopic`、`/end` 直接执行

**L1: 高置信度规则**
- 关键词匹配：消息命中某话题 2+ 个关键词 → 切换。但当前话题"近期活跃"（3 分钟内）时，对**其他**话题的关键词命中不在 L1 抢占，留给 L2/L3 判断（避免多步任务链里某一步被误切走）
- 延续信号：消息以"那这个"、"继续"、"what about"等开头 → 留在当前话题
- 短追问片段：近期活跃时，≤8 字且以疑问语气结尾的碎片（如"郑州哪？"）→ 留在当前话题

**L1.6: 承接上一条助手回复** — 当前话题近期活跃，且新消息与"上一条助手回复"有 **≥2 个具体词重叠**时 → 留在当前话题。用于接住"对助手刚列出的内容做操作"的追问（如助手列了多个会议、用户发"申请 X、Y 的权限"），这类消息常与话题关键词字面不重合，否则会被 L1.5 误判为新话题

**L1.5: 自动新建检测** — 满足全部条件时创建新话题：
- 当前话题消息数 ≥ 6
- 空闲时间 ≥ 15 分钟
- 消息与当前话题关键词零重叠
- 消息足够长（含标点或 >15 字）

> 阈值（消息数 6 / 空闲 15 分钟）是自学习可调的默认值，贴合真实对话节奏（人会停顿、隔一会儿回来追问同一主题）。

**L2: LLM 判断** — 规则无法确定时调用轻量 LLM（20s 超时，3 次失败后熔断 60s）。分类上下文除最近用户消息外，**还包含上一条助手回复**，让 LLM 能识别"对刚才回复的承接/追问"

**L3: 兜底规则** — LLM 不可用时默认延续当前话题（Sticky Session）

### V4 智能特性

#### 置信度提示

当系统不确定时（置信度 < 阈值），不会静默路由，而是询问：

> 🤔 这条消息可能属于新话题。
> → /newtopic 创建新话题 | 继续发消息留在当前话题

#### Soft Fork（软分叉）

系统自动创建新话题后，5 分钟内 `/switch` 回原话题会：
- 自动合并（结束错误创建的子话题）
- 显示「🔄 已合并回话题 xxx」
- 记录反馈用于后续优化

#### Force-Continue（重发/切回后的强制延续）

避免"切回原话题后，重发的消息又被甩进新话题"的死循环：
- **自动切回**：消息被误路由到新建空话题、AI 回复明确表示"没有上下文"时，系统自动把活跃话题切回父话题，并提示"重发即可继续"。此时会对该会话**布防一次性强制延续**，使你重发的下一条消息直接落回父话题，跳过分类器（否则相同文本会被再次判为新话题，承诺无法兑现）
- **手动 `/switch`**：手动切换成功后同样布防，使紧接着的下一条消息留在你选中的话题（否则刚被误建话题学到的关键词会在 L1 把它拉回去）
- 一次性 + 2 分钟内有效，且引用消息的优先级更高，避免吞掉真正的新话题

#### 自适应阈值

每收集 20 条反馈自动调整参数：
- 误判多 → 提高置信度阈值（更保守）
- 全部正确 → 适当降低阈值（更果断）
- 调整幅度非对称（+0.03 / -0.02），宁可保守

### 运行时开关

通过 `/topic-router on|off` 可随时开关话题路由功能：

- **关闭 (`off`)**：`before_dispatch` hook 和 output hook 均跳过，消息直接进入默认 session，无话题 footer
- **开启 (`on`)**：恢复自动路由
- **状态查询**：不带参数的 `/topic-router` 查看当前状态
- **持久化**：开关状态写入 `{stateDir}/enabled.json`，gateway 重启后自动恢复

### 回复中的话题标记

每条 AI 回复末尾显示当前话题：`📌 话题: Redis缓存编码`

引用带话题标记的消息回复时，系统自动路由到该话题（自动切换到被引用消息所属的话题）。

### FAQ

**Q: 话题太多了怎么办？**
系统自动清理 7 天不活跃的话题。也可以 `/end 标签` 手动结束或 `/endall` 清空。

**Q: 为什么有时候系统没有自动新建话题？**
Sticky Session 设计：不确定时优先留在当前话题（代价更低）。用 `/newtopic` 手动创建，系统会学习。

**Q: 关键词是怎么来的？**
从消息中自动提取（名词、术语），随着对话积累越来越准。中文取 2-4 字词，英文/型号取字母起头的 token（含数字，如 `yu7`/`su7`/`gt`），所以短型号、产品代号也能成为关键词。被反馈纠正过的关键词会降权。

### 最佳实践

1. **正常聊天即可** — 不需要刻意切换，让系统自动处理
2. **发现误判就纠正** — `/switch` 或 `/newtopic`，每次纠正都在帮系统学习
3. **明确换话题时加信号词** — "换个话题"、"另外问一下"能帮助系统更快识别
4. **长时间空闲后聊新话题** — 系统会自动分流
5. **引用消息回复** — 自动跳转到对应话题，适合多话题并行

---

## 技术文档

- [V4 技术方案](https://mi.feishu.cn/wiki/N00awD1dBisxdpkLPtocT58LnWe)
- [V3 技术方案](https://mi.feishu.cn/wiki/WvdKwDiHliQYrpk5hAGcrNQUn2e)
- [用户手册（飞书）](https://mi.feishu.cn/wiki/UyVOwHOk1in3ZVkCc4IcWGaJnke)

## 项目结构

```
├── index.ts                # 插件入口，注册命令和 hooks（含 /switch 等 registerCommand）
├── src/
│   ├── classifier.ts       # 分层分类器 (L0-L3 + circuit breaker)
│   ├── commands.ts         # 斜杠命令处理
│   ├── hook-handler.ts     # before_dispatch hook 主逻辑（含 force-continue / 助手回复记录）
│   ├── topic-registry.ts   # 话题注册表 (CRUD + 持久化 + 关键词学习)
│   ├── feedback-store.ts   # V4: 反馈收集 + 自适应阈值
│   ├── context-bridge.ts   # V4: Soft Fork 生命周期
│   ├── no-context-detect.ts# "无上下文"回复检测 + 助手回复文本提取
│   ├── llm-client.ts       # LLM 调用封装
│   ├── utils.ts            # 工具函数
│   └── types.ts            # 类型定义
├── test-classifier.ts      # 分类器测试（L0-L3 / carry-over / 饱和阈值等，76 cases）
├── test-force-continue.ts  # force-continue 机制测试
├── tests/                  # 其他单元测试
├── deploy.sh               # 一键部署（兼容各种容器）
├── bootstrap.sh            # 完整安装（patch gateway + 注册插件）
├── redeploy.sh             # 代码热更新（不重新 patch）
└── patch-gateway.sh        # Gateway JS 补丁
```

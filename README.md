# Topic Router

OpenClaw 话题路由插件 — 自动将私聊消息按话题分流到独立 session，让 AI 在每个话题中保持完整上下文。

## 快速部署

```bash
# 任意 OpenClaw 容器上执行（一行搞定）
curl -fsSL https://raw.githubusercontent.com/FlanTHU/claude-code-worker/v2-direct-llm/deploy.sh | bash
```

手动部署：

```bash
git config --global http.sslVerify false
REPO=/root/.openclaw/workspace/code-repo
[ -d "$REPO/.git" ] && (cd "$REPO" && git pull origin v2-direct-llm) || \
  (mkdir -p "$(dirname $REPO)" && git clone -b v2-direct-llm https://github.com/FlanTHU/claude-code-worker.git "$REPO")
cd "$REPO" && FORCE_BOOTSTRAP=1 bash bootstrap.sh
```

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
| `/topics` | 查看所有话题列表 | `/topics` |
| `/switch <标签>` | 切换到指定话题 | `/switch coding` |
| `/newtopic <标签>` | 手动创建新话题 | `/newtopic travel` |
| `/end` | 结束当前话题 | `/end` |
| `/endall` | 清理全部话题 | `/endall` |

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
- 关键词匹配：消息命中某话题 2+ 个关键词 → 切换
- 延续信号：消息以"那这个"、"继续"、"what about"等开头 → 留在当前话题

**L1.5: 自动新建检测** — 满足全部条件时创建新话题：
- 当前话题消息数 ≥ 3
- 空闲时间 ≥ 5 分钟
- 消息与当前话题关键词零重叠
- 消息足够长（含标点或 >15 字）

**L2: LLM 判断** — 规则无法确定时调用轻量 LLM（8s 超时，3 次失败后熔断 60s）

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

#### 自适应阈值

每收集 20 条反馈自动调整参数：
- 误判多 → 提高置信度阈值（更保守）
- 全部正确 → 适当降低阈值（更果断）
- 调整幅度非对称（+0.03 / -0.02），宁可保守

### 回复中的话题标记

每条 AI 回复末尾显示当前话题：`📌 话题: Redis缓存编码`

引用带话题标记的消息回复时，系统自动路由到该话题。

### FAQ

**Q: 话题太多了怎么办？**
系统自动清理 7 天不活跃的话题。也可以 `/end 标签` 手动结束或 `/endall` 清空。

**Q: 为什么有时候系统没有自动新建话题？**
Sticky Session 设计：不确定时优先留在当前话题（代价更低）。用 `/newtopic` 手动创建，系统会学习。

**Q: 关键词是怎么来的？**
从消息中自动提取（名词、术语），随着对话积累越来越准。被反馈纠正过的关键词会降权。

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
├── index.ts              # 插件入口，注册命令和 hooks
├── src/
│   ├── classifier.ts     # 分层分类器 (L0-L3 + circuit breaker)
│   ├── commands.ts       # 斜杠命令处理
│   ├── hook-handler.ts   # before_dispatch hook 主逻辑
│   ├── topic-registry.ts # 话题注册表 (CRUD + 持久化)
│   ├── feedback-store.ts # V4: 反馈收集 + 自适应阈值
│   ├── context-bridge.ts # V4: Soft Fork 生命周期
│   ├── llm-client.ts     # LLM 调用封装
│   ├── utils.ts          # 工具函数
│   └── types.ts          # 类型定义
├── tests/
│   └── v4.test.ts        # V4 功能测试 (30 cases)
├── deploy.sh             # 一键部署（兼容各种容器）
├── bootstrap.sh          # 完整安装（patch gateway + 注册插件）
├── redeploy.sh           # 代码热更新（不重新 patch）
└── patch-gateway.sh      # Gateway JS 补丁
```

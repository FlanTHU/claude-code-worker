---
name: tennis123-monitor
description: |
  监控 Tennis123 北京网球比赛，筛选低强度可报名场次并推送。
  TRIGGER when: "查看待推送网球"、"跑一次网球监控"、"网球比赛状态"、"推送网球比赛"、"网球监控"、"tennis123"、"网球提醒"、"查网球"、"网球筛选"
---

# Tennis123 Monitor Skill

## 功能概述

监控 [Tennis123](https://tennis123.net) 北京地区网球比赛，按规则筛选低强度可报名场次，结果存入 SQLite 数据库，支持飞书推送。

## 业务规则

| 维度     | 规则                                                         |
|----------|--------------------------------------------------------------|
| 城市     | 北京                                                         |
| 时间窗口 | 工作日 20:00–22:00；周末 09:00–22:00（Asia/Shanghai）        |
| 级别赛制 | 2.5 / 3.0 单打，状态为「报名中」                             |
| 距离     | 参考点 昌平东小口（116.38, 40.06），直线 ≤ 20 km             |
| 强度     | 综合强度 < 0.42（胜率×0.6 + 场次归一化×0.4，≥4人且每人≥8场）|

## 文件位置

```
/root/.openclaw/skills/tennis123-monitor/
├── SKILL.md
├── scripts/
│   ├── scraper.py     # CDP 爬虫（CloakBrowser）
│   ├── rules.py       # 规则引擎
│   ├── db.py          # SQLite 操作
│   ├── monitor.py     # 主入口
│   └── notify.py      # 飞书推送准备
└── requirements.txt
```

数据库路径：`/root/.openclaw/workspace/tennis123-monitor.db`

## 使用方式

### 1. 查看待推送比赛

```python
import sys
sys.path.insert(0, '/root/.openclaw/skills/tennis123-monitor/scripts')
sys.path.insert(0, '/root/.openclaw/workspace/lib/python')
from monitor import query_pending_matches, format_pending_text
records = query_pending_matches()
print(format_pending_text(records))
```

### 2. 执行一次完整监控（会启动 CloakBrowser，约需 2-5 分钟）

```python
import sys
sys.path.insert(0, '/root/.openclaw/skills/tennis123-monitor/scripts')
sys.path.insert(0, '/root/.openclaw/workspace/lib/python')
from monitor import run_once
result = run_once()
print(result)
```

### 3. 查看任务状态

```python
import sys
sys.path.insert(0, '/root/.openclaw/skills/tennis123-monitor/scripts')
from monitor import get_job_status
import json
print(json.dumps(get_job_status(), ensure_ascii=False, indent=2, default=str))
```

### 4. 推送待推送比赛到飞书（调用工具发送）

Step 1：获取推送内容
```python
import sys, json
sys.path.insert(0, '/root/.openclaw/skills/tennis123-monitor/scripts')
sys.path.insert(0, '/root/.openclaw/workspace/lib/python')
from notify import prepare_feishu_payload
payload = prepare_feishu_payload()
print(json.dumps(payload, ensure_ascii=False, indent=2))
```

Step 2：使用 `feishu_im_message` 工具发送
- action: send
- receive_id_type: open_id
- receive_id: payload["open_id"]
- msg_type: payload["msg_type"]
- content: payload["content"]

Step 3：标记已发送
```python
from notify import mark_records_notified
mark_records_notified(payload["record_ids"])
```

## 技术说明

### 反爬绕过方案（CloakBrowser CDP）

Tennis123 对爬虫有 HTTP 468 防护，采用以下方案绕过：

1. 使用 CloakBrowser headless Chromium 渲染页面
2. 通过 CDP（Chrome DevTools Protocol）获取渲染后的 innerText
3. Node.js + ws 库建立 WebSocket 连接（`/tmp/wsmod/node_modules/ws`）

关键环境变量：
- `LD_LIBRARY_PATH=/tmp/mylibs2`（必须设置，否则 Chrome 无法启动）

### 数据库表结构

**pending_notifications**：待推送比赛
- match_id, match_name, start_time, location, level, format, status
- raw_url, reason（通过原因）, match_json（完整数据）
- notified（是否已推送）, created_at

**job_runs**：任务运行记录
- fetched_count, passed_count, duration_sec, status, error_msg

## 常见问题

**Q: 抓取返回空内容**
A: Chrome 可能启动失败，检查 `/tmp/mylibs2` 是否存在，Chrome 二进制是否可执行。

**Q: 比赛列表为空**
A: Tennis123 反爬严格，监控器会自动启用 ID 探测作为兜底策略。

**Q: 规则强度检查总是通过（数据不足）**
A: 正常现象，当报名者 <4 人或每人 <8 场时，强度检查宽松通过。

**Q: 如何设置定时执行**
A: 在 OpenClaw 中创建 cron 任务，每 2 小时执行 `run_once()`。

## 版本历史

- v1.0.0 (2026-05-15)：初始版本，CDP 爬虫 + 规则引擎 + SQLite + 飞书推送

"""
notify.py - 飞书推送模块
通过 OpenClaw feishu_im_message 工具发送待推送比赛通知
实际发送由 OpenClaw skill 主动调用工具完成
"""
import sys, os
sys.path.insert(0, '/root/.openclaw/workspace/lib/python')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import json
import logging
from typing import List, Optional

from db import init_db, query_pending, mark_notified

logger = logging.getLogger(__name__)

DEFAULT_OPEN_ID = "ou_5e5571dd73a904c2ff4bd975c8a6dc13"


def format_match_card(record: dict) -> str:
    """
    将一条待推送记录格式化为飞书富文本消息
    返回 feishu post 格式的 JSON 字符串
    """
    name = record.get('match_name', '未知比赛')
    start_time = record.get('start_time', '-')
    location = record.get('location', '-')
    level = record.get('level', '-')
    fmt = record.get('format', '-')
    url = record.get('raw_url', '')
    reason = record.get('reason', '')
    created_at = record.get('created_at', '')

    content = [
        [{"tag": "text", "text": f"📅 时间：{start_time}"}],
        [{"tag": "text", "text": f"📍 地点：{location}"}],
        [{"tag": "text", "text": f"🏆 级别：{level} {fmt}"}],
        [{"tag": "text", "text": f"✅ 筛选理由：{reason[:100] if reason else '-'}"}],
    ]
    if url:
        content.append([
            {"tag": "text", "text": "🔗 详情："},
            {"tag": "a", "text": "点击查看", "href": url},
        ])
    if created_at:
        content.append([{"tag": "text", "text": f"🕐 收录时间：{created_at}"}])

    post = {
        "zh_cn": {
            "title": f"🎾 低强度比赛推荐：{name}",
            "content": content,
        }
    }
    return json.dumps(post, ensure_ascii=False)


def build_summary_message(records: List[dict]) -> str:
    """
    将多条待推送记录组合成一条汇总文本消息
    """
    if not records:
        return "📭 暂无待推送网球比赛"

    lines = [f"🎾 Tennis123 低强度比赛推荐（共 {len(records)} 场）\n"]
    for i, r in enumerate(records, 1):
        name = r.get('match_name', '未知')
        start_time = r.get('start_time', '-')
        location = r.get('location', '-')
        level = r.get('level', '-')
        fmt = r.get('format', '-')
        url = r.get('raw_url', '')
        lines.append(
            f"{i}. 【{name}】\n"
            f"   时间: {start_time}\n"
            f"   地点: {location}\n"
            f"   级别: {level} {fmt}\n"
            f"   链接: {url}\n"
        )
    return "\n".join(lines)


def get_pending_for_notify() -> List[dict]:
    """获取待推送记录（供 OpenClaw skill 调用）"""
    init_db()
    return query_pending(include_notified=False)


def mark_records_notified(record_ids: List[int]):
    """批量标记已通知"""
    for rid in record_ids:
        mark_notified(rid)
    logger.info(f"已标记 {len(record_ids)} 条记录为已通知")


# ─────────────────────────────────────────────────────────────────────────────
# 以下函数供 OpenClaw skill 的 Python 脚本调用
# 实际飞书发送通过 skill 调用 feishu_im_message 工具完成
# ─────────────────────────────────────────────────────────────────────────────

def prepare_feishu_payload(open_id: str = DEFAULT_OPEN_ID) -> dict:
    """
    准备飞书推送内容
    返回 {"open_id": str, "msg_type": str, "content": str, "record_ids": list}
    供 OpenClaw skill 读取后调用 feishu_im_message 工具
    """
    records = get_pending_for_notify()
    if not records:
        return {"open_id": open_id, "msg_type": "text",
                "content": json.dumps({"text": "📭 暂无待推送网球比赛"}),
                "record_ids": []}

    summary = build_summary_message(records)
    record_ids = [r['id'] for r in records]

    return {
        "open_id": open_id,
        "msg_type": "text",
        "content": json.dumps({"text": summary}, ensure_ascii=False),
        "record_ids": record_ids,
    }


if __name__ == '__main__':
    """
    直接运行时，输出待推送内容（不实际发送）
    实际发送由 OpenClaw skill 完成
    """
    logging.basicConfig(level=logging.INFO)
    payload = prepare_feishu_payload()
    print("=== 待推送内容 ===")
    if payload["record_ids"]:
        content = json.loads(payload["content"])
        print(content.get("text", ""))
        print(f"\n共 {len(payload['record_ids'])} 条记录待推送")
    else:
        print("暂无待推送内容")

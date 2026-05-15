"""
monitor.py - 主入口
提供 run_once(), query_pending(), get_job_status() 三个核心函数
"""
import sys, os
sys.path.insert(0, '/root/.openclaw/workspace/lib/python')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import time
import logging
import json
from typing import List, Dict

from scraper import fetch_match_list, fetch_match_detail
from rules import apply_rules
from db import init_db, save_pending, query_pending, save_job_run, get_recent_jobs, get_stats

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
logger = logging.getLogger(__name__)


def run_once(verbose: bool = True) -> Dict:
    """
    执行一次完整的监控任务：
    1. 抓取比赛列表
    2. 逐一抓取详情
    3. 规则过滤
    4. 入库 pending_notifications
    返回运行摘要
    """
    init_db()
    start_ts = time.time()

    summary = {
        "fetched": 0,
        "passed": 0,
        "failed_fetch": 0,
        "new_pending": 0,
        "status": "ok",
        "error": None,
        "matches_passed": [],
    }

    try:
        # Step 1: 获取比赛 ID 列表
        logger.info("=== 开始抓取比赛列表 ===")
        match_ids = fetch_match_list()
        logger.info(f"获取到 {len(match_ids)} 个比赛 ID: {match_ids}")

        if not match_ids:
            logger.warning("比赛列表为空，跳过")
            summary["status"] = "partial"
            summary["error"] = "比赛列表为空"
            save_job_run(0, 0, time.time() - start_ts, 'partial', '比赛列表为空')
            return summary

        # Step 2 & 3: 逐一抓取并过滤
        for mid in match_ids:
            logger.info(f"--- 处理 match_id={mid} ---")
            try:
                match = fetch_match_detail(mid)
                if match.get("status") == "fetch_failed":
                    summary["failed_fetch"] += 1
                    logger.warning(f"match_id={mid} 抓取失败")
                    continue

                summary["fetched"] += 1

                # 规则过滤
                passed, reason = apply_rules(match)
                if verbose:
                    logger.info(f"match_id={mid} 规则结果: {'通过' if passed else '未通过'} | {reason}")

                if passed:
                    summary["passed"] += 1
                    new = save_pending(match, reason)
                    if new:
                        summary["new_pending"] += 1
                        summary["matches_passed"].append({
                            "id": mid,
                            "name": match.get("name", ""),
                            "start_time": match.get("start_time", ""),
                            "location": match.get("location", ""),
                            "level": match.get("level", ""),
                        })

            except Exception as e:
                logger.error(f"处理 match_id={mid} 异常: {e}", exc_info=True)
                summary["failed_fetch"] += 1
                continue

    except Exception as e:
        logger.error(f"run_once 全局异常: {e}", exc_info=True)
        summary["status"] = "error"
        summary["error"] = str(e)

    duration = time.time() - start_ts
    save_job_run(
        fetched=summary["fetched"],
        passed=summary["passed"],
        duration=duration,
        status=summary["status"],
        error_msg=summary["error"],
    )

    logger.info(
        f"=== 本次任务完成 | 耗时 {duration:.1f}s | "
        f"抓取 {summary['fetched']} 场 | 通过 {summary['passed']} 场 | "
        f"新增待推送 {summary['new_pending']} 条 ==="
    )
    return summary


def query_pending_matches(include_notified: bool = False) -> List[dict]:
    """查询待推送比赛列表"""
    init_db()
    return query_pending(include_notified=include_notified)


def get_job_status(limit: int = 5) -> dict:
    """获取任务状态与统计"""
    init_db()
    return {
        "stats": get_stats(),
        "recent_jobs": get_recent_jobs(limit=limit),
    }


def format_pending_text(records: List[dict]) -> str:
    """格式化待推送记录为可读文本"""
    if not records:
        return "📭 暂无待推送比赛"

    lines = [f"🎾 共 {len(records)} 场待推送比赛：\n"]
    for r in records:
        lines.append(
            f"【{r.get('match_name', '未知')}】\n"
            f"  时间: {r.get('start_time', '-')}\n"
            f"  地点: {r.get('location', '-')}\n"
            f"  级别: {r.get('level', '-')} {r.get('format', '-')}\n"
            f"  链接: {r.get('raw_url', '-')}\n"
            f"  收录: {r.get('created_at', '-')}\n"
        )
    return "\n".join(lines)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Tennis123 Monitor')
    parser.add_argument('--run-once', action='store_true', help='执行一次监控任务')
    parser.add_argument('--query', action='store_true', help='查询待推送比赛')
    parser.add_argument('--status', action='store_true', help='查看任务状态')
    args = parser.parse_args()

    if args.run_once:
        result = run_once()
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.query:
        records = query_pending_matches()
        print(format_pending_text(records))
    elif args.status:
        status = get_job_status()
        print(json.dumps(status, ensure_ascii=False, indent=2, default=str))
    else:
        parser.print_help()

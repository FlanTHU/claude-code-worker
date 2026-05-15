"""
db.py - SQLite 数据库操作
表：pending_notifications, job_runs
"""
import sqlite3
import json
import logging
from datetime import datetime, timedelta
from typing import List, Optional

logger = logging.getLogger(__name__)

DB_PATH = '/root/.openclaw/workspace/tennis123-monitor.db'


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """初始化数据库表结构"""
    conn = get_conn()
    try:
        c = conn.cursor()
        c.executescript("""
        CREATE TABLE IF NOT EXISTS pending_notifications (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id    INTEGER NOT NULL,
            match_name  TEXT,
            start_time  TEXT,
            location    TEXT,
            level       TEXT,
            format      TEXT,
            status      TEXT,
            raw_url     TEXT,
            reason      TEXT,        -- 通过的规则原因
            match_json  TEXT,        -- 完整比赛 JSON
            notified    INTEGER DEFAULT 0,
            notified_at TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_match_id
            ON pending_notifications(match_id);

        CREATE TABLE IF NOT EXISTS job_runs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            run_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            fetched_count   INTEGER DEFAULT 0,
            passed_count    INTEGER DEFAULT 0,
            error_msg       TEXT,
            duration_sec    REAL,
            status          TEXT DEFAULT 'ok'   -- ok / error / partial
        );
        """)
        conn.commit()
        logger.info(f"数据库初始化完成: {DB_PATH}")
    finally:
        conn.close()


def save_pending(match: dict, reason: str) -> bool:
    """
    将通过规则的比赛写入 pending_notifications
    同一 match_id 24 小时内去重（UPDATE 通知字段，不重复插入）
    返回 True 表示新增，False 表示已存在（忽略）
    """
    conn = get_conn()
    try:
        c = conn.cursor()
        # 查是否已有未通知记录（24 小时内）
        cutoff = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
        c.execute(
            "SELECT id, notified FROM pending_notifications "
            "WHERE match_id = ? AND created_at > ?",
            (match.get("id"), cutoff)
        )
        row = c.fetchone()
        if row:
            logger.info(f"match_id={match.get('id')} 24h 内已存在，跳过")
            return False

        c.execute("""
            INSERT OR IGNORE INTO pending_notifications
                (match_id, match_name, start_time, location, level, format,
                 status, raw_url, reason, match_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            match.get("id"),
            match.get("name", ""),
            match.get("start_time", ""),
            match.get("location", ""),
            match.get("level", ""),
            match.get("format", ""),
            match.get("status", ""),
            match.get("raw_url", ""),
            reason,
            json.dumps(match, ensure_ascii=False),
        ))
        conn.commit()
        inserted = c.rowcount > 0
        if inserted:
            logger.info(f"新增待推送: match_id={match.get('id')} {match.get('name', '')}")
        return inserted
    finally:
        conn.close()


def query_pending(include_notified: bool = False) -> List[dict]:
    """查询待推送（默认只查未通知的）"""
    conn = get_conn()
    try:
        c = conn.cursor()
        if include_notified:
            c.execute("SELECT * FROM pending_notifications ORDER BY created_at DESC LIMIT 50")
        else:
            c.execute(
                "SELECT * FROM pending_notifications WHERE notified = 0 "
                "ORDER BY created_at DESC LIMIT 50"
            )
        return [dict(r) for r in c.fetchall()]
    finally:
        conn.close()


def mark_notified(record_id: int):
    """标记为已通知"""
    conn = get_conn()
    try:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute(
            "UPDATE pending_notifications SET notified=1, notified_at=? WHERE id=?",
            (now, record_id)
        )
        conn.commit()
    finally:
        conn.close()


def save_job_run(fetched: int, passed: int, duration: float,
                 status: str = 'ok', error_msg: Optional[str] = None):
    """记录任务运行结果"""
    conn = get_conn()
    try:
        conn.execute("""
            INSERT INTO job_runs (fetched_count, passed_count, duration_sec, status, error_msg)
            VALUES (?, ?, ?, ?, ?)
        """, (fetched, passed, duration, status, error_msg))
        conn.commit()
    finally:
        conn.close()


def get_recent_jobs(limit: int = 10) -> List[dict]:
    """获取最近的任务记录"""
    conn = get_conn()
    try:
        c = conn.cursor()
        c.execute(
            "SELECT * FROM job_runs ORDER BY id DESC LIMIT ?", (limit,)
        )
        return [dict(r) for r in c.fetchall()]
    finally:
        conn.close()


def get_stats() -> dict:
    """获取汇总统计"""
    conn = get_conn()
    try:
        c = conn.cursor()
        c.execute("SELECT COUNT(*) as total, SUM(notified) as notified FROM pending_notifications")
        row = dict(c.fetchone())
        c.execute("SELECT COUNT(*) as runs FROM job_runs WHERE status='ok'")
        row['ok_runs'] = c.fetchone()['runs']
        c.execute("SELECT run_at FROM job_runs ORDER BY id DESC LIMIT 1")
        last = c.fetchone()
        row['last_run'] = last['run_at'] if last else None
        return row
    finally:
        conn.close()


if __name__ == '__main__':
    init_db()
    print("数据库初始化完成")
    print("统计:", get_stats())

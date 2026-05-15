"""
rules.py - 比赛筛选规则引擎
规则：时间窗口、级别、赛制、距离、强度
"""
import math
import logging
from datetime import datetime
from typing import Tuple

try:
    from zoneinfo import ZoneInfo
except ImportError:
    from backports.zoneinfo import ZoneInfo  # Python < 3.9

logger = logging.getLogger(__name__)

# ── 配置 ──────────────────────────────────────────────────────────────────────

TZ = ZoneInfo("Asia/Shanghai")

# 时间窗口
WEEKDAY_START = 20   # 工作日 20:00
WEEKDAY_END   = 22
WEEKEND_START = 9    # 周末 09:00
WEEKEND_END   = 22

# 级别白名单
ALLOWED_LEVELS = {"2.5", "3.0"}

# 赛制白名单
ALLOWED_FORMATS = {"单打"}

# 参考坐标（昌平区东小口街道）
REF_LAT = 40.06
REF_LON = 116.38
MAX_DISTANCE_KM = 20.0

# 强度阈值
WIN_WEIGHT  = 0.6
GAME_WEIGHT = 0.4
INTENSITY_THRESHOLD = 0.42   # 综合强度低于此值才算低强度
MIN_PLAYERS   = 4            # 至少 4 名有效报名者
MIN_GAMES_PER = 8            # 每人至少 8 场


# ── Haversine 距离 ────────────────────────────────────────────────────────────

def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """返回两点之间的直线距离（km）"""
    R = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2
         + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2))
         * math.sin(d_lon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


# ── 地理坐标查找（简版，不调高德 API） ───────────────────────────────────────

# 部分北京网球场参考坐标（可扩展）
VENUE_COORDS = {
    "东小口": (40.06, 116.38),
    "昌平":   (40.22, 116.23),
    "朝阳":   (39.93, 116.48),
    "海淀":   (39.96, 116.30),
    "丰台":   (39.86, 116.29),
    "通州":   (39.91, 116.66),
    "顺义":   (40.13, 116.65),
    "大兴":   (39.73, 116.34),
    "石景山": (39.91, 116.22),
    "门头沟": (39.94, 116.10),
    "房山":   (39.74, 116.14),
    "怀柔":   (40.32, 116.63),
    "密云":   (40.37, 116.84),
    "平谷":   (40.14, 117.11),
    "延庆":   (40.46, 115.97),
    "西城":   (39.91, 116.37),
    "东城":   (39.93, 116.42),
}

def location_to_coords(location: str) -> Tuple[float, float]:
    """简单关键词匹配，返回 (lat, lon)；找不到返回参考坐标"""
    for keyword, coords in VENUE_COORDS.items():
        if keyword in location:
            return coords
    return (REF_LAT, REF_LON)  # 默认同参考点


# ── 规则检查函数 ──────────────────────────────────────────────────────────────

def check_time_window(match: dict) -> Tuple[bool, str]:
    """检查比赛时间是否在可接受窗口内"""
    start_time_str = match.get("start_time", "")
    if not start_time_str:
        return False, "无开始时间信息"
    try:
        # 支持 "YYYY-MM-DD HH:MM" 和 "YYYY/MM/DD HH:MM"
        start_time_str = start_time_str.replace("/", "-")
        dt = datetime.strptime(start_time_str, "%Y-%m-%d %H:%M")
        dt = dt.replace(tzinfo=TZ)
    except ValueError:
        return False, f"时间格式无法解析: {start_time_str}"

    weekday = dt.weekday()  # 0=Mon, 6=Sun
    hour = dt.hour

    if weekday < 5:  # 工作日
        ok = WEEKDAY_START <= hour < WEEKDAY_END
        if not ok:
            return False, f"工作日时间 {hour}:00 不在 {WEEKDAY_START}-{WEEKDAY_END} 窗口"
    else:  # 周末
        ok = WEEKEND_START <= hour < WEEKEND_END
        if not ok:
            return False, f"周末时间 {hour}:00 不在 {WEEKEND_START}-{WEEKEND_END} 窗口"

    return True, "时间窗口符合"


def check_level(match: dict) -> Tuple[bool, str]:
    """检查级别是否在白名单"""
    level = str(match.get("level", "")).strip()
    if level in ALLOWED_LEVELS:
        return True, f"级别 {level} 符合"
    return False, f"级别 {level!r} 不在白名单 {ALLOWED_LEVELS}"


def check_format(match: dict) -> Tuple[bool, str]:
    """检查赛制是否为单打"""
    fmt = str(match.get("format", "")).strip()
    if fmt in ALLOWED_FORMATS:
        return True, f"赛制 {fmt} 符合"
    return False, f"赛制 {fmt!r} 不是单打"


def check_status(match: dict) -> Tuple[bool, str]:
    """检查报名状态"""
    status = match.get("status", "")
    if status == "报名中":
        return True, "报名中"
    return False, f"状态为 {status!r}，非报名中"


def check_distance(match: dict) -> Tuple[bool, str]:
    """检查场地距离"""
    location = match.get("location", "")
    if not location:
        return True, "无地点信息，默认通过距离检查"  # 宽松处理

    lat, lon = location_to_coords(location)
    dist = haversine(REF_LAT, REF_LON, lat, lon)
    if dist <= MAX_DISTANCE_KM:
        return True, f"距离 {dist:.1f}km ≤ {MAX_DISTANCE_KM}km"
    return False, f"距离 {dist:.1f}km > {MAX_DISTANCE_KM}km"


def check_intensity(match: dict) -> Tuple[bool, str]:
    """
    检查报名者综合强度
    综合强度 = 胜率*0.6 + 场次归一化*0.4
    场次归一化 = min(total / 50, 1.0)  # 用 50 场作为满场参考
    """
    registrants = match.get("registrants", [])
    # 过滤有效报名者（至少 MIN_GAMES_PER 场）
    valid = [r for r in registrants if r.get("total", 0) >= MIN_GAMES_PER]

    if len(valid) < MIN_PLAYERS:
        return True, f"有效报名者 {len(valid)} 人 < {MIN_PLAYERS}，强度数据不足，默认通过"

    scores = []
    for r in valid:
        win_rate = r.get("win_rate", 0.0)
        total = r.get("total", 0)
        game_norm = min(total / 50.0, 1.0)
        score = WIN_WEIGHT * win_rate + GAME_WEIGHT * game_norm
        scores.append(score)

    avg_intensity = sum(scores) / len(scores)
    if avg_intensity < INTENSITY_THRESHOLD:
        return True, f"平均强度 {avg_intensity:.3f} < {INTENSITY_THRESHOLD}（{len(valid)} 名有效报名者）"
    return False, f"平均强度 {avg_intensity:.3f} ≥ {INTENSITY_THRESHOLD}，强度过高"


# ── 主入口 ────────────────────────────────────────────────────────────────────

def apply_rules(match: dict) -> Tuple[bool, str]:
    """
    对一场比赛应用所有规则
    返回 (passed: bool, reason: str)
    """
    checks = [
        ("状态", check_status),
        ("级别", check_level),
        ("赛制", check_format),
        ("时间窗口", check_time_window),
        ("距离", check_distance),
        ("强度", check_intensity),
    ]

    reasons = []
    for name, fn in checks:
        try:
            ok, msg = fn(match)
        except Exception as e:
            logger.warning(f"规则 {name} 执行异常: {e}")
            ok, msg = True, f"{name} 检查异常（宽松通过）"
        if not ok:
            return False, f"[{name}] {msg}"
        reasons.append(f"{name}: {msg}")

    return True, " | ".join(reasons)


if __name__ == '__main__':
    # 快速自测
    sample = {
        "id": 99999,
        "name": "测试比赛",
        "start_time": "2026-05-17 20:00",  # 周六 20:00
        "location": "东小口网球场",
        "level": "3.0",
        "format": "单打",
        "status": "报名中",
        "registrants": [
            {"name": "张三", "wins": 3, "total": 10, "win_rate": 0.3},
            {"name": "李四", "wins": 4, "total": 12, "win_rate": 0.33},
            {"name": "王五", "wins": 5, "total": 15, "win_rate": 0.33},
            {"name": "赵六", "wins": 2, "total": 9, "win_rate": 0.22},
        ],
    }
    passed, reason = apply_rules(sample)
    print(f"通过: {passed}")
    print(f"原因: {reason}")

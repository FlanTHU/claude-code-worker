"""
scraper.py - Tennis123 CDP 爬虫
使用 CloakBrowser headless Chromium + Node.js CDP WebSocket 绕过 HTTP 468 反爬
"""
import sys, os
sys.path.insert(0, '/root/.openclaw/workspace/lib/python')
os.environ.setdefault('CLOAKBROWSER_CACHE_DIR', '/root/.openclaw/workspace/.cloakbrowser')

CHROME_BIN = '/root/.openclaw/workspace/.cloakbrowser/chromium-146.0.7680.177.3/chrome'
LD_LIB = '/tmp/mylibs2'
WS_LIB = '/tmp/wsmod/node_modules/ws'

import subprocess
import random
import time
import json
import shutil
import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)

try:
    import httpx
except ImportError:
    httpx = None


def start_chrome(url: str, port: int = None):
    """启动 headless Chromium，返回 (proc, port)"""
    if port is None:
        port = random.randint(9300, 9999)
    userdata = f'/tmp/cloakbrowser-{port}'
    os.makedirs(userdata, exist_ok=True)
    env = os.environ.copy()
    env['LD_LIBRARY_PATH'] = LD_LIB
    proc = subprocess.Popen(
        [
            CHROME_BIN,
            '--headless', '--no-sandbox',
            f'--user-data-dir={userdata}',
            '--disable-gpu', '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            f'--remote-debugging-port={port}',
            url,
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(10)  # 等待页面渲染完成
    return proc, port


def get_page_content(port: int) -> Optional[str]:
    """通过 CDP 获取页面 innerText，使用 Node.js + ws 库"""
    if httpx is None:
        # 降级到 curl
        r = subprocess.run(
            ['curl', '-s', f'http://localhost:{port}/json'],
            capture_output=True, text=True, timeout=5
        )
        pages = json.loads(r.stdout)
    else:
        r = httpx.get(f'http://localhost:{port}/json', timeout=5)
        pages = r.json()

    if not pages:
        logger.warning("CDP /json 返回空页面列表")
        return None

    ws_url = pages[0]['webSocketDebuggerUrl']

    # Node.js 脚本：通过 CDP WebSocket 获取 innerText
    script = f"""
const WebSocket = require('{WS_LIB}');
const ws = new WebSocket('{ws_url}');
ws.on('open', () => setTimeout(() => {{
  ws.send(JSON.stringify({{
    id: 1,
    method: 'Runtime.evaluate',
    params: {{ expression: 'document.body.innerText', returnByValue: true }}
  }}));
}}, 2000));
ws.on('message', d => {{
  const m = JSON.parse(d);
  if (m.id === 1) {{
    process.stdout.write(m.result && m.result.result ? (m.result.result.value || '') : '');
    ws.close();
    process.exit(0);
  }}
}});
ws.on('error', e => {{ process.stderr.write(e.message); process.exit(1); }});
setTimeout(() => process.exit(1), 15000);
"""
    result = subprocess.run(
        ['node', '-e', script],
        capture_output=True, text=True, timeout=20
    )
    if result.returncode != 0:
        logger.warning(f"Node.js CDP 错误: {result.stderr[:200]}")
    return result.stdout


def fetch_page(url: str) -> Optional[str]:
    """抓取页面，返回 innerText"""
    proc, port = start_chrome(url, port=None)
    try:
        content = get_page_content(port)
        return content
    except Exception as e:
        logger.error(f"fetch_page 失败 {url}: {e}")
        return None
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(f'/tmp/cloakbrowser-{port}', ignore_errors=True)


def parse_match_detail(text: str, match_id: int) -> dict:
    """
    从详情页 innerText 解析比赛信息（基于实际页面结构）

    页面典型结构：
      首页\n分级赛\n团体赛\n排行榜\n搜索用户\n联系方式\n登录\n注册
      首页  赛事 详细
      [比赛名称]
      级别：XX  人数：N  类型：单打
      所在球场： [球场名]
      比赛章程
      开始时间：YYYY年M月D号 HH:MM
      状态：[状态文字]
      报名费: ...
      ...
      序号\t会员\t级别\t积分\t胜负
      [编号]\t[姓名]\t[级别]\t[积分]\t[胜X负Y]
    """
    result = {
        "id": match_id,
        "name": "",
        "start_time": "",
        "location": "",
        "level": "unknown",
        "format": "unknown",
        "status": "unknown",
        "registrants": [],
        "raw_url": f"https://tennis123.net/match/detail/{match_id}",
    }
    if not text:
        return result

    lines = [l.strip() for l in text.splitlines() if l.strip()]

    # ── 比赛名称："首页  赛事 详细" 后的第一行非空行 ────────────────────
    nav_words = {'首页', '分级赛', '团体赛', '排行榜', '搜索用户',
                 '联系方式', '登录', '注册', '赛事 详细', '首页  赛事 详细'}
    found_header = False
    for line in lines:
        if '赛事' in line and '详细' in line:
            found_header = True
            continue
        if found_header and line and line not in nav_words:
            result["name"] = line
            break

    # 兜底：用包含比赛关键词的行
    if not result["name"]:
        for line in lines:
            if any(x in line for x in ['第', '站', '北京', '单打', '双打']) and len(line) > 5:
                if line not in nav_words:
                    result["name"] = line
                    break

    # ── 级别（从名称或专用行提取） ────────────────────────────────────────
    # 先从 "级别：..." 行提取
    for line in lines:
        if line.startswith('级别：') or line.startswith('级别:'):
            # 有时格式为 "级别：\xa0\xa0 人数：5\xa0 类型：单打"
            m = re.search(r'(\d\.\d)', line)
            if m:
                result["level"] = m.group(1)
            # 赛制
            if '单打' in line:
                result["format"] = "单打"
            elif '双打' in line:
                result["format"] = "双打"
            break

    # 兜底：从比赛名称提取
    if result["level"] == "unknown":
        for line in lines[:15]:
            m = re.search(r'(\d\.\d)', line)
            if m:
                result["level"] = m.group(1)
                break

    # 兜底：赛制
    if result["format"] == "unknown":
        for line in lines:
            if '单打' in line:
                result["format"] = "单打"
                break
            elif '双打' in line:
                result["format"] = "双打"
                break

    # ── 球场/地点："所在球场：" 行 ──────────────────────────────────────
    for line in lines:
        if '所在球场' in line or '球场：' in line or '球场:' in line:
            # 去掉前缀
            loc = re.sub(r'^所在球场[：:：]\s*', '', line).strip()
            loc = re.sub(r'\s*导航\s*$', '', loc).strip()
            if loc:
                result["location"] = loc
            break

    # 兜底：从名称行提取括号内的场地信息
    if not result["location"] and result["name"]:
        m = re.search(r'[（(]([^）)]+)[）)]', result["name"])
        if m:
            result["location"] = m.group(1)

    # ── 开始时间："开始时间：YYYY年M月D号 HH:MM" ─────────────────────────
    # 也支持 "YYYY/MM/DD HH:MM" 格式
    for line in lines:
        if '开始时间' in line:
            # 中文格式：2026年3月18号 21:00
            m_cn = re.search(r'(\d{4})年(\d{1,2})月(\d{1,2})[号日]\s*(\d{1,2}:\d{2})', line)
            if m_cn:
                y, mo, d, t = m_cn.groups()
                result["start_time"] = f"{y}-{int(mo):02d}-{int(d):02d} {t}"
                break
            # 数字格式
            m_num = re.search(r'(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(\d{1,2}:\d{2})', line)
            if m_num:
                date_part = m_num.group(1).replace('/', '-')
                result["start_time"] = f"{date_part} {m_num.group(2)}"
                break

    # 兜底：从名称中提取时间（如 "2026/05/15周五21点"）
    if not result["start_time"] and result["name"]:
        m = re.search(r'(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})[号日]?[^\d]*(\d{1,2})点', result["name"])
        if m:
            y, mo, d, h = m.groups()
            result["start_time"] = f"{y}-{int(mo):02d}-{int(d):02d} {int(h):02d}:00"

    # ── 状态："状态：XXX" ─────────────────────────────────────────────────
    for line in lines:
        if line.startswith('状态：') or line.startswith('状态:'):
            status_val = re.sub(r'^状态[：:]\s*', '', line).strip()
            # 标准化状态
            if '报名中' in status_val or '报名' in status_val:
                result["status"] = "报名中"
            elif '结束' in status_val or '已结束' in status_val:
                result["status"] = "已结束"
            elif '进行中' in status_val:
                result["status"] = "进行中"
            elif '截止' in status_val:
                result["status"] = "报名截止"
            elif '报满' in status_val or '已满' in status_val:
                result["status"] = "报满"
            else:
                result["status"] = status_val
            break

    # ── 报名者解析：表格格式 ──────────────────────────────────────────────
    # 表头：序号\t会员\t级别\t积分\t胜负
    # 数据行：1\t张三\t3.0\t1234\t胜5负3
    registrants = []
    in_player_table = False
    win_loss_pattern = re.compile(r'胜(\d+)\s*负(\d+)')

    for line in lines:
        if '序号' in line and '会员' in line and '胜负' in line:
            in_player_table = True
            continue
        if not in_player_table:
            continue
        # 结束条件
        if '我要报名' in line or '用户评论' in line or '评论' in line:
            break
        if '目前还没有人报名' in line or '没有人报名' in line:
            break

        # 解析数据行（tab 分隔）
        parts = line.split('\t')
        if len(parts) >= 4:
            player_name = parts[1].strip() if len(parts) > 1 else ''
            player_level = parts[2].strip() if len(parts) > 2 else ''
            win_loss_str = parts[-1].strip() if parts else ''

            m = win_loss_pattern.search(win_loss_str)
            if m and player_name:
                wins = int(m.group(1))
                losses = int(m.group(2))
                total = wins + losses
                registrants.append({
                    "name": player_name,
                    "level": player_level,
                    "wins": wins,
                    "losses": losses,
                    "total": total,
                    "win_rate": wins / total if total > 0 else 0.0,
                })

    result["registrants"] = registrants
    return result


def fetch_match_detail(match_id: int) -> dict:
    """抓取并解析指定 match_id 的比赛详情"""
    url = f"https://tennis123.net/match/detail/{match_id}"
    logger.info(f"抓取详情页: {url}")
    text = fetch_page(url)
    if not text:
        logger.warning(f"详情页内容为空: match_id={match_id}")
        return {"id": match_id, "status": "fetch_failed", "raw_url": url}
    return parse_match_detail(text, match_id)


def parse_match_list_text(text: str) -> list:
    """
    从列表页 innerText 提取比赛 ID 列表
    URL 格式: /match/detail/{id}
    """
    if not text:
        return []
    ids = re.findall(r'/match/detail/(\d+)', text)
    # 去重保序
    seen = set()
    result = []
    for i in ids:
        if i not in seen:
            seen.add(i)
            result.append(int(i))
    return result


def fetch_match_list() -> list:
    """
    抓取北京地区报名中比赛列表，返回 match_id 列表
    策略：先抓列表页，再尝试 ID 区间探测（兜底）
    """
    # 1. 主列表页
    list_urls = [
        "https://tennis123.net/match?city=北京&status=enrolling",
        "https://tennis123.net/match?city=%E5%8C%97%E4%BA%AC&status=enrolling",
        "https://tennis123.net/match",
    ]

    match_ids = []
    for url in list_urls:
        logger.info(f"抓取列表页: {url}")
        text = fetch_page(url)
        if text:
            ids = parse_match_list_text(text)
            if ids:
                logger.info(f"列表页获取到 {len(ids)} 个比赛 ID")
                match_ids = ids
                break

    if match_ids:
        return match_ids

    # 2. 兜底：ID 区间探测（从高 ID 向低 ID，仅检测少量）
    logger.info("列表页为空，启动 ID 探测（最多探测 20 个）")
    # 从已知 seed ID 开始，向上探测
    seed_ids = [57931, 57861, 57324, 56994, 56810]
    max_id = max(seed_ids) + 50
    min_id = max(seed_ids) - 100
    step = 3
    probed = []
    count = 0
    for mid in range(max_id, min_id, -step):
        if count >= 20:
            break
        url = f"https://tennis123.net/match/detail/{mid}"
        text = fetch_page(url)
        if text and '北京' in text and ('报名中' in text or '报名截止' not in text):
            probed.append(mid)
            logger.info(f"探测命中: {mid}")
        count += 1

    return probed if probed else seed_ids[:3]


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    import sys
    mid = int(sys.argv[1]) if len(sys.argv) > 1 else 57931
    result = fetch_match_detail(mid)
    print(json.dumps(result, ensure_ascii=False, indent=2))

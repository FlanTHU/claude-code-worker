"""
scraper.py - Tennis123 CDP 爬虫
使用 CloakBrowser headless Chromium + Node.js CDP WebSocket 绕过 HTTP 468 反爬
"""
import sys, os
sys.path.insert(0, '/root/.openclaw/workspace/lib/python')
os.environ.setdefault('CLOAKBROWSER_CACHE_DIR', '/root/.openclaw/workspace/.cloakbrowser')

CHROME_BIN = '/root/.openclaw/workspace/.cloakbrowser/chromium-146.0.7680.177.3/chrome'
LD_LIB = '/root/.openclaw/workspace/libs'  # 持久路径（原 /tmp/mylibs2）
WS_LIB = '/tmp/wsmod/node_modules/ws'

import subprocess
import random
import time
import json
import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)

try:
    import httpx
except ImportError:
    httpx = None


class ChromeSingleton:
    """单例 Chrome，用 CDP Page.navigate 切换页面避免重复启动开销"""
    _proc = None
    _port = None

    @classmethod
    def get(cls):
        if cls._proc is None or cls._proc.poll() is not None:
            cls._start()
        return cls

    @classmethod
    def _start(cls):
        cls._port = random.randint(9300, 9399)
        userdata = f'/tmp/chrome-singleton-{cls._port}'
        os.makedirs(userdata, exist_ok=True)
        env = os.environ.copy()
        env['LD_LIBRARY_PATH'] = LD_LIB
        cls._proc = subprocess.Popen(
            [
                CHROME_BIN, '--headless', '--no-sandbox',
                f'--user-data-dir={userdata}',
                '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
                '--disable-background-networking', '--disable-default-apps',
                f'--remote-debugging-port={cls._port}',
                'about:blank',
            ],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(5)
        logger.info(f"ChromeSingleton 已启动 pid={cls._proc.pid} port={cls._port}")

    @classmethod
    def _get_ws_url(cls) -> Optional[str]:
        try:
            if httpx is not None:
                r = httpx.get(f'http://localhost:{cls._port}/json', timeout=5)
                pages = r.json()
            else:
                r = subprocess.run(
                    ['curl', '-s', f'http://localhost:{cls._port}/json'],
                    capture_output=True, text=True, timeout=5,
                )
                pages = json.loads(r.stdout)
            if pages:
                return pages[0]['webSocketDebuggerUrl']
        except Exception as e:
            logger.warning(f"获取 CDP WS URL 失败: {e}")
        return None

    @classmethod
    def _do_navigate(cls, url: str, wait: int) -> Optional[str]:
        ws_url = cls._get_ws_url()
        if not ws_url:
            return None

        total_wait_ms = wait * 1000
        js_extra_ms = 3000   # loadEventFired 后额外等待 JS 渲染
        timeout_ms = total_wait_ms + 8000

        script = f"""
const WebSocket = require('{WS_LIB}');
const ws = new WebSocket('{ws_url}');
let done = false;
let contentRequested = false;
let msgId = 1;

function finish(text) {{
  if (done) return;
  done = true;
  process.stdout.write(text || '');
  try {{ ws.close(); }} catch(e) {{}}
  process.exit(0);
}}

function getContent() {{
  if (contentRequested) return;
  contentRequested = true;
  ws.send(JSON.stringify({{
    id: 99, method: 'Runtime.evaluate',
    params: {{ expression: 'document.body.innerText', returnByValue: true }}
  }}));
}}

ws.on('open', () => {{
  ws.send(JSON.stringify({{ id: msgId++, method: 'Page.enable', params: {{}} }}));
  ws.send(JSON.stringify({{ id: msgId++, method: 'Page.navigate', params: {{ url: '{url}' }} }}));
}});

ws.on('message', d => {{
  const m = JSON.parse(d);
  if (m.method === 'Page.loadEventFired') {{
    setTimeout(getContent, {js_extra_ms});
  }}
  if (m.id === 99) {{
    finish(m.result && m.result.result ? (m.result.result.value || '') : '');
  }}
}});

ws.on('error', e => {{ process.stderr.write(String(e)); process.exit(1); }});
setTimeout(getContent, {total_wait_ms});
setTimeout(() => {{ if (!done) process.exit(1); }}, {timeout_ms});
"""
        result = subprocess.run(
            ['node', '-e', script],
            capture_output=True, text=True, timeout=wait + 12,
        )
        if result.returncode != 0 and result.stderr:
            logger.warning(f"Node.js CDP 错误: {result.stderr[:200]}")
        return result.stdout or None

    @classmethod
    def navigate_and_get(cls, url: str, wait: int = 8) -> Optional[str]:
        """导航到 URL，等待加载，返回页面 innerText；空内容自动重启重试一次"""
        for attempt in range(2):
            if cls._proc is None or cls._proc.poll() is not None:
                cls._start()
            content = cls._do_navigate(url, wait)
            if content and len(content.strip()) > 10:
                return content
            if attempt == 0:
                logger.warning(f"页面内容为空，重启 Chrome 重试: {url}")
                cls.shutdown()
        return None

    @classmethod
    def shutdown(cls):
        if cls._proc:
            cls._proc.terminate()
            try:
                cls._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls._proc.kill()
            cls._proc = None
            cls._port = None
            logger.info("ChromeSingleton 已关闭")


def fetch_page(url: str) -> Optional[str]:
    """抓取页面，返回 innerText（通过 ChromeSingleton）"""
    return ChromeSingleton.get().navigate_and_get(url)


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
    for line in lines:
        if line.startswith('级别：') or line.startswith('级别:'):
            m = re.search(r'(\d\.\d)', line)
            if m:
                result["level"] = m.group(1)
            if '单打' in line:
                result["format"] = "单打"
            elif '双打' in line:
                result["format"] = "双打"
            break

    if result["level"] == "unknown":
        for line in lines[:15]:
            m = re.search(r'(\d\.\d)', line)
            if m:
                result["level"] = m.group(1)
                break

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
            loc = re.sub(r'^所在球场[：:：]\s*', '', line).strip()
            loc = re.sub(r'\s*导航\s*$', '', loc).strip()
            if loc:
                result["location"] = loc
            break

    if not result["location"] and result["name"]:
        m = re.search(r'[（(]([^）)]+)[）)]', result["name"])
        if m:
            result["location"] = m.group(1)

    # ── 开始时间 ─────────────────────────────────────────────────────────
    for line in lines:
        if '开始时间' in line:
            m_cn = re.search(r'(\d{4})年(\d{1,2})月(\d{1,2})[号日]\s*(\d{1,2}:\d{2})', line)
            if m_cn:
                y, mo, d, t = m_cn.groups()
                result["start_time"] = f"{y}-{int(mo):02d}-{int(d):02d} {t}"
                break
            m_num = re.search(r'(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(\d{1,2}:\d{2})', line)
            if m_num:
                date_part = m_num.group(1).replace('/', '-')
                result["start_time"] = f"{date_part} {m_num.group(2)}"
                break

    if not result["start_time"] and result["name"]:
        m = re.search(r'(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})[号日]?[^\d]*(\d{1,2})点', result["name"])
        if m:
            y, mo, d, h = m.groups()
            result["start_time"] = f"{y}-{int(mo):02d}-{int(d):02d} {int(h):02d}:00"

    # ── 状态 ─────────────────────────────────────────────────────────────
    for line in lines:
        if line.startswith('状态：') or line.startswith('状态:'):
            status_val = re.sub(r'^状态[：:]\s*', '', line).strip()
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

    # ── 报名者解析 ────────────────────────────────────────────────────────
    registrants = []
    in_player_table = False
    win_loss_pattern = re.compile(r'胜(\d+)\s*负(\d+)')

    for line in lines:
        if '序号' in line and '会员' in line and '胜负' in line:
            in_player_table = True
            continue
        if not in_player_table:
            continue
        if '我要报名' in line or '用户评论' in line or '评论' in line:
            break
        if '目前还没有人报名' in line or '没有人报名' in line:
            break

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
    """从列表页 innerText 提取比赛 ID 列表"""
    if not text:
        return []
    ids = re.findall(r'/match/detail/(\d+)', text)
    seen = set()
    result = []
    for i in ids:
        if i not in seen:
            seen.add(i)
            result.append(int(i))
    return result


def fetch_match_list(start_id: int = None) -> list:
    """
    抓取北京地区报名中比赛列表，返回 match_id 列表。
    start_id: 上次扫描的最高 ID，列表页为空时从 start_id+1 向上探测。
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

    # 2. 兜底：向上探测 ID（从 last_scanned_id+1 或 seed+1 开始）
    if start_id is not None:
        scan_from = start_id + 1
        logger.info(f"列表页为空，从 last_id={start_id} 向上扫描")
    else:
        seed_ids = [57931, 57861, 57324, 56994, 56810]
        scan_from = max(seed_ids) + 1
        logger.info(f"列表页为空，从 seed 向上扫描（起点 {scan_from}）")

    probed = []
    for mid in range(scan_from, scan_from + 30):
        if len(probed) >= 20:
            break
        url = f"https://tennis123.net/match/detail/{mid}"
        text = fetch_page(url)
        if not text or len(text.strip()) < 50:
            continue
        if '展德' in text:
            logger.info(f"探测 {mid}: 展德场次，跳过")
            continue
        if '北京' in text:
            probed.append(mid)
            logger.info(f"探测命中: {mid}")

    if probed:
        return probed
    # 最终兜底：返回空（由 monitor 处理）
    return []


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    import sys
    mid = int(sys.argv[1]) if len(sys.argv) > 1 else 57931
    result = fetch_match_detail(mid)
    print(json.dumps(result, ensure_ascii=False, indent=2))

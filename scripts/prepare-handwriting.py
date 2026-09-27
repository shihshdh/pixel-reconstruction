"""展示页诗句的手写笔画：把每个场景的一句当地诗句转成按书写顺序排列的单线笔画（像 iPhone 开机的 hello / 你好）。

    python scripts/prepare-handwriting.py

输出 lib/handwriting.generated.json，由 components/HandwrittenTagline.tsx 逐笔画出。需要 numpy、pillow、scikit-image。

- 拉丁文字：用单线手写体 Sacramento（SIL OFL）渲染成大图，骨架化得到笔画中心线，在交叉点按“最顺”的方向把线段
  接成长笔画；每个单词内从左到右书写，i 的点、重音符号、t 的横这类小笔画在单词写完后再补上，和真人写字一样。
- 汉字：用 Make Me a Hanzi 的笔顺中线（hanzi-writer-data，Arphic Public License），按真实笔顺一笔一划。
- 日文（假名与汉字）：用 KanjiVG 的笔画（CC BY-SA 3.0，© Ulrich Apel），本身就是按笔顺排列的中线。
- 两者都输出为以 100 为字高的坐标，前端用同一种圆头单线描出来。

字体与笔顺数据第一次运行时下载到 artifacts/handwriting/（不入库）；许可证文本见 lib/handwriting-licenses/。
"""
import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from skimage.morphology import skeletonize

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "artifacts" / "handwriting"
OUT = ROOT / "lib" / "handwriting.generated.json"
FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/sacramento/Sacramento-Regular.ttf"
HANZI_URL = "https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0/{}.json"
KANJIVG_URL = "https://raw.githubusercontent.com/KanjiVG/kanjivg/master/kanji/{:05x}.svg"

# 与 lib/landing-scenes.ts 的场景 id 对应。每个场景一句写这个地方的诗，用当地语言；不知道在哪的场景用英文。
# 都是公有领域的作品（作者去世超过 70 年、或 1929 年前发表）。“/” 处换行。
TAGLINES = {
    "victoria": ("zh-Hant", "會當凌絕頂，一覽眾山小。", "杜甫〈望嶽〉"),
    # 芭蕉在江户（今东京）深川的草庵所作：花云如海，钟声是上野来的还是浅草来的
    "shibuya": ("ja", "花の雲 鐘は上野か 浅草か", "松尾芭蕉"),
    "kelingking": ("id", "Aku mau hidup seribu tahun lagi", "Chairil Anwar · Aku"),
    "london": ("en-GB", "Earth has not anything to show more fair", "William Wordsworth · Composed upon Westminster Bridge"),
    "louvre": ("fr", "Là, tout n'est qu'ordre et beauté,/Luxe, calme et volupté.", "Charles Baudelaire · L'Invitation au voyage"),
    "seine": ("fr", "Un cygne qui s'était évadé de sa cage,", "Charles Baudelaire · Le Cygne"),
    "california": ("en-US", "Facing west from California's shores,", "Walt Whitman · Facing West from California's Shores"),
    "harbor": ("en", "Sunset and evening star,/And one clear call for me!", "Alfred Tennyson · Crossing the Bar"),
    "nice": ("fr", "La mer, la mer, toujours recommencée", "Paul Valéry · Le Cimetière marin"),
}

RENDER = 260          # 拉丁文字渲染字号（像素），骨架在这个尺度上提取
UNIT = 100 / RENDER   # 输出坐标：字号 = 100


def fetch(url, path):
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url) as response:
            path.write_bytes(response.read())
    return path


# ---------------------------------------------------------------- 拉丁文字

NEIGHBORS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def trace_skeleton(skel):
    """骨架像素 → 节点之间的折线（端点、交叉点为节点；没有节点的闭环单独处理）。"""
    h, w = skel.shape
    pts = set(zip(*np.nonzero(skel)))

    def nbrs(p):
        y, x = p
        return [(y + dy, x + dx) for dy, dx in NEIGHBORS if (y + dy, x + dx) in pts]

    degree = {p: len(nbrs(p)) for p in pts}
    nodes = {p for p, d in degree.items() if d != 2}
    # 相邻的交叉点像素合成一个节点
    cluster = {}
    for p in nodes:
        if p in cluster or degree[p] < 3:
            continue
        stack, members = [p], []
        cluster[p] = p
        while stack:
            q = stack.pop()
            members.append(q)
            for n in nbrs(q):
                if n in nodes and degree[n] >= 3 and n not in cluster:
                    cluster[n] = p
                    stack.append(n)
    for p in nodes:
        cluster.setdefault(p, p)

    # 孤立的骨架像素：很小的点（句点）
    edges, used = [{"a": p, "b": p, "pts": [p]} for p in nodes if degree[p] == 0], set()
    for start in nodes:
        for n in nbrs(start):
            if (start, n) in used:
                continue
            if n in nodes and cluster[n] == cluster[start]:
                continue
            path, prev, cur = [start], start, n
            used.add((start, n))
            while True:
                path.append(cur)
                if cur in nodes:
                    used.add((cur, prev))
                    break
                nxt = [q for q in nbrs(cur) if q != prev and q not in path[-3:]]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
            edges.append({"a": cluster[path[0]], "b": cluster[path[-1]], "pts": path})
    # 闭环（字母 o 之类，全是度为 2 的像素）
    seen = {q for e in edges for q in e["pts"]}
    for p in pts:
        if p in seen or degree[p] != 2:
            continue
        path, prev, cur = [p], None, p
        while True:
            nxt = [q for q in nbrs(cur) if q != prev and q not in path[-3:]]
            if not nxt or (nxt[0] == p and len(path) > 3):
                break
            prev, cur = cur, nxt[0]
            if cur in path:
                break
            path.append(cur)
        seen.update(path)
        path.append(p)
        edges.append({"a": None, "b": None, "pts": path})
    return edges


def direction(pts, at_start, reach=10):
    """边在一端的切线方向（指向边外）。"""
    seq = pts if at_start else pts[::-1]
    a, b = np.array(seq[0], float), np.array(seq[min(reach, len(seq) - 1)], float)
    v = a - b
    n = np.linalg.norm(v)
    return v / n if n else v


def chain_edges(edges, stroke_px):
    """去掉骨架毛刺，再在节点处把方向最顺的两条边接成一笔。"""
    edges = [e for e in edges if not (len(e["pts"]) < stroke_px * 1.6 and (e["a"] is None) != (e["b"] is None) or
                                      (len(e["pts"]) < stroke_px * 1.6 and e["a"] != e["b"] and
                                       sum(1 for f in edges if e["a"] in (f["a"], f["b"])) > 1 and
                                       sum(1 for f in edges if e["b"] in (f["a"], f["b"])) == 1))]
    ends = {}
    for i, e in enumerate(edges):
        if e["a"] is None:
            continue
        ends.setdefault(e["a"], []).append((i, True))
        ends.setdefault(e["b"], []).append((i, False))
    link = {}
    for node, incident in ends.items():
        pairs = []
        for x in range(len(incident)):
            for y in range(x + 1, len(incident)):
                (i, si), (j, sj) = incident[x], incident[y]
                if i == j:
                    continue
                # 一条边走进节点、另一条走出：两条外指方向越接近相反越顺
                cos = float(np.dot(direction(edges[i]["pts"], si), direction(edges[j]["pts"], sj)))
                pairs.append((cos, incident[x], incident[y]))
        pairs.sort()
        taken = set()
        for cos, p, q in pairs:
            if cos > -0.35 or p in taken or q in taken:
                continue
            taken.update([p, q])
            link[p], link[q] = q, p
    strokes, done = [], set()
    for i, e in enumerate(edges):
        if i in done:
            continue
        # 找到这条链的一个自由端
        cur, start_side = i, True
        visited = {i}
        while (cur, start_side) in link:
            j, side = link[(cur, start_side)]
            if j in visited:
                break
            visited.add(j)
            cur, start_side = j, not side
        # 从自由端出发沿链走
        pts, side = [], start_side
        while True:
            done.add(cur)
            seg = edges[cur]["pts"] if side else edges[cur]["pts"][::-1]
            pts.extend(seg if not pts else seg[1:])
            nxt = link.get((cur, not side))
            if not nxt or nxt[0] in done:
                break
            cur, side = nxt[0], nxt[1]
        strokes.append(pts)
    return strokes


def smooth(points, passes=3):
    p = np.array(points, float)
    closed = len(p) > 3 and np.allclose(p[0], p[-1])
    for _ in range(passes):
        if closed:
            p = (np.roll(p, 1, 0) + 2 * p + np.roll(p, -1, 0)) / 4
        else:
            q = p.copy()
            q[1:-1] = (p[:-2] + 2 * p[1:-1] + p[2:]) / 4
            p = q
    return p


def simplify(p, tolerance):
    """Ramer–Douglas–Peucker"""
    if len(p) < 3:
        return p
    a, b = p[0], p[-1]
    ab = b - a
    n = np.linalg.norm(ab)
    rel = p - a
    d = np.abs(ab[0] * rel[:, 1] - ab[1] * rel[:, 0]) / n if n else np.linalg.norm(rel, axis=1)
    i = int(np.argmax(d))
    if d[i] > tolerance:
        return np.vstack([simplify(p[:i + 1], tolerance)[:-1], simplify(p[i:], tolerance)])
    return np.array([a, b])


LEADING = 1.02  # 行距（字号的倍数）；手写体的升部降部本来就长，行距不必大


def latin(text, font_path):
    font = ImageFont.truetype(str(font_path), RENDER)
    pad = RENDER // 2
    lines = text.split("/")
    width = int(max(font.getlength(line) for line in lines)) + pad * 2
    height = int(RENDER * (1.6 + LEADING * (len(lines) - 1)))
    baseline = int(RENDER * 1.05)
    image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(image)
    for i, line in enumerate(lines):
        draw.text((pad, baseline + i * RENDER * LEADING), line, font=font, fill=255, anchor="ls")
    ink = np.asarray(image) > 110
    # 笔画粗细：用于去毛刺
    from scipy.ndimage import distance_transform_edt
    thickness = float(np.median(distance_transform_edt(ink)[skeletonize(ink)])) * 2
    edges = trace_skeleton(skeletonize(ink))
    # 太短的多半是骨架毛刺；但独立成块的短笔画是句点、感叹号的点，要留下
    from scipy.ndimage import label
    blobs, _ = label(ink)
    chained = chain_edges(edges, thickness)
    owners = {}
    for s in chained:
        owners.setdefault(blobs[s[0]], []).append(s)
    raw = [s for s in chained if len(s) > thickness * .8 or len(owners[blobs[s[0]]]) == 1]
    raw = [s if len(s) > 2 else [s[0], (s[0][0] + 1, s[0][1] + 1)] for s in raw]

    # 单词在横向上的范围（按排版推算），笔画按所属单词分组
    # 单词的范围：(行, 左, 右)
    words = []
    for i, line in enumerate(lines):
        x = pad
        for token in line.split(" "):
            w = font.getlength(token)
            words.append((i, x, x + w))
            x += w + font.getlength(" ")
    line_of = lambda y: max(0, min(len(lines) - 1, int(round((y - baseline + RENDER * .3) / (RENDER * LEADING)))))

    strokes = []
    for s in raw:
        p = smooth([(x, y) for y, x in s])
        p = simplify(p, .7)
        length = float(np.sum(np.linalg.norm(np.diff(p, axis=0), axis=1)))
        xs = p[:, 0]
        center = float(xs.mean())
        row = line_of(float(np.median(p[:, 1])))
        word = min(range(len(words)), key=lambda k: (words[k][0] != row, 0 if words[k][1] - 4 <= center <= words[k][2] + 4 else min(abs(center - words[k][1]), abs(center - words[k][2]))))
        # 小笔画（点、重音、t 的横、撇号、句点）在单词写完后补
        top = float(p[:, 1].min())
        small = length < RENDER * .42 or (np.ptp(p[:, 1]) < RENDER * .12 and length < RENDER * .7)
        # 书写方向：从左端开始
        if p[0, 0] > p[-1, 0] + 2:
            p = p[::-1]
        strokes.append({"word": word, "small": small, "x": float(xs.min()), "top": top, "p": p, "len": length})
    strokes.sort(key=lambda s: (s["word"], s["small"], s["x"]))
    xmin = min(float(s["p"][:, 0].min()) for s in strokes) - thickness
    ymin = min(float(s["p"][:, 1].min()) for s in strokes) - thickness
    xmax = max(float(s["p"][:, 0].max()) for s in strokes) + thickness
    ymax = max(float(s["p"][:, 1].max()) for s in strokes) + thickness
    out = []
    for s in strokes:
        q = (s["p"] - [xmin, ymin]) * UNIT
        out.append({"d": path_d(q), "len": round(s["len"] * UNIT, 1), "gap": "word" if s is strokes[0] or s["word"] != prev_word else "stroke"})
        prev_word = s["word"]
    return {"w": round((xmax - xmin) * UNIT, 1), "h": round((ymax - ymin) * UNIT, 1), "weight": round(thickness * UNIT * 1.15, 2), "strokes": out}


# ---------------------------------------------------------------- 汉字

def catmull(points, samples=6):
    p = np.array(points, float)
    if len(p) < 3:
        return p
    ext = np.vstack([p[0], p, p[-1]])
    out = [p[0]]
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for t in np.linspace(0, 1, samples + 1)[1:]:
            t2, t3 = t * t, t * t * t
            out.append(.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    return np.array(out)


def hanzi(text):
    size = 100 / 1024          # 1024 的字框缩到字高 100
    advance = 1024 * .96
    strokes, x = [], 0.0
    for ch in text:
        if ch in "，。":
            # 标点不在笔顺数据里：句号一个小圈，逗号一个小钩
            cx = x + 1024 * .22
            if ch == "。":
                t = np.linspace(-.6 * math.pi, 1.45 * math.pi, 28)
                pts = np.c_[cx + 70 * np.cos(t), 830 + 70 * np.sin(t)]
            else:
                pts = catmull([(cx - 5, 740), (cx + 45, 790), (cx + 30, 880), (cx - 40, 950)])
            strokes.append((pts, "word"))
            x += advance * .5
            continue
        data = json.loads(fetch(HANZI_URL.format(urllib.parse.quote(ch)), CACHE / f"{ord(ch):x}.json").read_text("utf-8"))
        for i, median in enumerate(data["medians"]):
            # 数据坐标 y 向上，原点在字框底部往下 124 处
            pts = catmull([(x + mx, 900 - my) for mx, my in median])
            strokes.append((pts, "word" if i == 0 else "stroke"))
        x += advance
    out = []
    for pts, gap in strokes:
        q = pts * size
        length = float(np.sum(np.linalg.norm(np.diff(q, axis=0), axis=1)))
        out.append({"d": path_d(q), "len": round(length, 1), "gap": gap})
    return {"w": round(x * size, 1), "h": 100.0, "weight": 5.2, "strokes": out}


def svg_path_points(d, samples=10):
    """KanjiVG 的路径只用到 M/m、C/c、S/s、L/l：展开成折线"""
    import re
    tokens = re.findall(r"[MmCcSsLl]|-?\d*\.?\d+(?:e-?\d+)?", d)
    pts, i, cmd = [], 0, None
    cur = np.zeros(2); ctrl = None
    def nums(n):
        nonlocal i
        vals = [float(v) for v in tokens[i:i + n]]
        i += n
        return np.array(vals).reshape(-1, 2)
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]; i += 1
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M":
            cur = nums(2)[0] + (cur if rel and pts else 0); pts.append(cur.copy()); ctrl = None
            cmd = "l" if rel else "L"
        elif c == "L":
            cur = nums(2)[0] + (cur if rel else 0); pts.append(cur.copy()); ctrl = None
        elif c in "CS":
            if c == "C":
                p1, p2, p3 = nums(6) + (cur if rel else 0)
            else:
                p2, p3 = nums(4) + (cur if rel else 0)
                p1 = 2 * cur - ctrl if ctrl is not None else cur.copy()
            for t in np.linspace(0, 1, samples + 1)[1:]:
                pts.append((1 - t) ** 3 * cur + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3)
            ctrl, cur = p2, p3
    return np.array(pts)


def kana(text):
    import re
    size = 100 / 109          # KanjiVG 的字框是 109
    advance = 109 * .98
    strokes, x, gap = [], 0.0, "word"
    for ch in text:
        if ch == " ":
            x += advance * .45
            continue
        svg = fetch(KANJIVG_URL.format(ord(ch)), CACHE / f"kvg-{ord(ch):05x}.svg").read_text("utf-8")
        body = svg[svg.index("StrokePaths"):svg.index("StrokeNumbers")]
        for i, d in enumerate(re.findall(r'<path[^>]* d="([^"]+)"', body)):
            strokes.append((svg_path_points(d) + [x, 0], "word" if i == 0 else "stroke"))
        x += advance
    out = []
    for pts, g in strokes:
        q = pts * size
        length = float(np.sum(np.linalg.norm(np.diff(q, axis=0), axis=1)))
        out.append({"d": path_d(q), "len": round(length, 1), "gap": g})
    return {"w": round(x * size, 1), "h": 100.0, "weight": 4.8, "strokes": out}


def path_d(q):
    # 化简到 0.25 个单位（字高 100）以内，肉眼看不出差别，数据小一半
    q = simplify(np.asarray(q, float), .25) if len(q) > 2 else np.asarray(q, float)
    return "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in q)


def main():
    font = fetch(FONT_URL, CACHE / "Sacramento-Regular.ttf")
    result = {}
    for scene, (lang, text, source) in TAGLINES.items():
        data = hanzi(text) if lang.startswith("zh") else kana(text) if lang == "ja" else latin(text, font)
        result[scene] = {"lang": lang, "text": text.replace("/", "\n"), "source": source, **data}
        print(f"{scene:11s} {lang:6s} strokes={len(data['strokes']):3d} size={data['w']}x{data['h']}  {text}")
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""分析 raw 数据: 按月统计投稿量/项目类型/状态, 输出趋势数据"""
import json, glob, re, os
from collections import defaultdict, Counter

RAW = os.path.expanduser("~/文档/MyVault/知识/大家都在做什么/raw")

# 项目类型关键词 (从标题/描述里匹配)
CATEGORIES = {
    "AI工具": ["ai", "llm", "gpt", "claude", "agent", "大模型", "模型", "提示词", "prompt", "智能", "chatgpt", "copilot", "deepseek"],
    "开发工具": ["cli", "命令行", "ide", "编辑器", "调试", "测试", "编译器", "数据库", "框架", "sdk", "api", "库"],
    "效率工具": ["效率", "笔记", "todo", "待办", "日历", "记账", "输入法", "截图", "剪贴板", "搜索", "自动化"],
    "AI编程": ["vibe", "codex", "cursor", "编码", "编程", "代码", "harness", "skill"],
    "音视频": ["视频", "音频", "音乐", "转码", "字幕", "剪辑", "直播"],
    "图像设计": ["图片", "图像", "设计", "绘图", "海报", "logo", "照片", "ps", "封面"],
    "游戏": ["游戏", "3d", "rpg", "休闲", "小游戏", "模拟"],
    "浏览器插件": ["浏览器", "插件", "扩展", "chrome", "edge", "油猴"],
    "网络安全": ["安全", "加密", "隐私", "破解", "逆向", "vpn", "防火墙"],
    "数据/AI生成": ["生图", "生视频", "生成", "ai绘画", "ai视频"],
    "其他": [],
}

def categorize(text):
    t = text.lower()
    for cat, kws in CATEGORIES.items():
        if cat == "其他": continue
        if any(k.lower() in t for k in kws):
            return cat
    return "其他"

def main():
    files = sorted(glob.glob(os.path.join(RAW, "*.json")))
    # 按月统计
    month = defaultdict(lambda: {"total": 0, "cats": Counter(), "status": Counter(), "sources": Counter()})
    for f in files:
        date = os.path.basename(f).replace(".json", "")
        m = date[:7]
        d = json.load(open(f))
        for r in d["results"]:
            src = r["sourceName"]
            for it in r.get("items", []):
                month[m]["total"] += 1
                month[m]["sources"][src.split("·")[-1]] += 1
                text = (it.get("title", "") + " " + it.get("summary", ""))[:200]
                month[m]["cats"][categorize(text)] += 1
                for tag in it.get("tags", []):
                    if tag in ("已上线", "开发中", "已关闭"):
                        month[m]["status"][tag] += 1

    # 输出
    for m in sorted(month):
        v = month[m]
        print(f"\n## {m} (共{v['total']}条)")
        print(f"来源: {dict(v['sources'])}")
        print(f"状态: {dict(v['status'])}")
        top_cats = v['cats'].most_common(8)
        print(f"项目类型TOP: {', '.join(f'{c}({n})' for c,n in top_cats)}")

if __name__ == "__main__":
    main()

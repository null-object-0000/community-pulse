#!/usr/bin/env python3
"""给 LLM 生成趋势分析用的完整数据 (按月: 量/类型/代表项目)"""
import json, glob, os
from collections import defaultdict, Counter

# 仓库根从脚本位置推导，不写死本机路径。
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
RAW = os.path.join(ROOT, "知识", "大家都在做什么", "raw")
CATEGORIES = {
    "AI工具": ["ai", "llm", "gpt", "claude", "agent", "大模型", "模型", "提示词", "prompt", "智能", "chatgpt", "copilot", "deepseek", "mcp"],
    "开发工具": ["cli", "命令行", "ide", "编辑器", "调试", "测试", "编译器", "数据库", "框架", "sdk", "api", "库", "git"],
    "效率工具": ["效率", "笔记", "todo", "待办", "日历", "记账", "输入法", "截图", "剪贴板", "搜索", "自动化", "同步"],
    "AI编程": ["vibe", "codex", "cursor", "编码", "编程", "代码", "harness", "skill", "agent 编程"],
    "音视频": ["视频", "音频", "音乐", "转码", "字幕", "剪辑", "直播", "配音"],
    "图像设计": ["图片", "图像", "设计", "绘图", "海报", "logo", "照片", "封面"],
    "游戏": ["游戏", "3d", "rpg", "小游戏", "模拟", "休闲"],
    "浏览器插件": ["浏览器", "插件", "扩展", "chrome", "edge", "油猴"],
    "安全隐私": ["安全", "加密", "隐私", "破解", "逆向", "vpn", "防火墙", "备份"],
    "AI生成内容": ["生图", "生视频", "ai绘画", "ai视频", "生成器", "文案", "写作"],
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
    month = defaultdict(lambda: {"total": 0, "cats": Counter(), "samples": []})
    for f in files:
        date = os.path.basename(f).replace(".json", "")
        m = date[:7]
        d = json.load(open(f))
        for r in d["results"]:
            for it in r.get("items", []):
                month[m]["total"] += 1
                text = (it.get("title", "") + " " + it.get("summary", ""))[:200]
                month[m]["cats"][categorize(text)] += 1
                # 收集代表项目标题 (去重, 最多30个/月)
                t = it.get("title", "")[:60]
                if t and t not in [s["title"] for s in month[m]["samples"]]:
                    month[m]["samples"].append({"title": t, "src": r["sourceName"].split("·")[-1]})

    out = []
    for m in sorted(month):
        v = month[m]
        out.append(f"【{m}】共{v['total']}条")
        out.append(f"类型分布: " + ", ".join(f"{c}({n})" for c, n in v['cats'].most_common(10)))
        out.append(f"代表项目(前25):")
        for s in v["samples"][:25]:
            out.append(f"  - [{s['src']}] {s['title']}")
    print("\n".join(out))

if __name__ == "__main__":
    main()

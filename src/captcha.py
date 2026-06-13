# !/usr/bin/env python
# -*-coding:utf-8 -*-

"""
# File       : jy_click.py
# Time       ：2023/11/13 16:49
# Author     ：yujia
# version    ：python 3.6
# Description：
"""
import os
import numpy as np
from functools import lru_cache
from typing import List, Dict, Any, Optional
from PIL import Image, ImageDraw, ImageFont

from src.utils import ver_onnx
from src.utils import yolo_onnx
from src.utils import matchingMode


# 跨平台 CJK 字体候选（按优先级）。原代码写死 Linux 路径，在 Windows/Mac 上会
# OSError 回退到 load_default()，而该位图字体根本无法渲染汉字——会把每个提示字
# 都渲染成同一张空白图，导致孪生网络对所有字给出相同分数、点击顺序完全错乱。
_CJK_FONT_CANDIDATES = [
    # Windows —— 腾讯点选验证码的字形接近隶书，优先用 SimLi(隶书) 渲染，字形最接近，
    # 孪生网络匹配更准；其余黑体/雅黑等作为兜底。
    r"C:\Windows\Fonts\SIMLI.TTF",     # 隶书
    r"C:\Windows\Fonts\STLITI.TTF",    # 华文隶书
    r"C:\Windows\Fonts\simhei.ttf",    # 黑体
    r"C:\Windows\Fonts\msyh.ttc",      # 微软雅黑
    r"C:\Windows\Fonts\simsun.ttc",    # 宋体
    r"C:\Windows\Fonts\Deng.ttf",      # 等线
    # Linux
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/arphic/ukai.ttc",
    # macOS
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
]


@lru_cache(maxsize=None)
def _load_cjk_font(font_size: int) -> ImageFont.FreeTypeFont:
    """返回第一个可用的 CJK 字体。找不到时直接抛错，避免静默回退到无法渲染
    汉字的 load_default()。"""
    for fp in _CJK_FONT_CANDIDATES:
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, font_size)
            except OSError:
                continue
    raise OSError(
        "未找到可用的 CJK 字体，无法渲染提示文字用于排序。请在 _CJK_FONT_CANDIDATES "
        "中添加本机的中文字体路径（如 C:/Windows/Fonts/msyh.ttc）。"
    )


def _render_char(char: str, size: int = 48) -> np.ndarray:
    """将单个字符渲染为白底黑字图片，返回 BGR numpy 数组"""
    img = Image.new('RGB', (size, size), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    font = _load_cjk_font(size - 8)
    bbox = draw.textbbox((0, 0), char, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((size - tw) / 2, (size - th) / 2 - bbox[1]), char, fill=(0, 0, 0), font=font)
    return np.array(img)[:, :, ::-1]  # RGB -> BGR


def _iou(a: List[float], b: List[float]) -> float:
    """两个框 [x1,y1,x2,y2,...] 的交并比"""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _dedup_overlapping(dets: List[List[float]], iou_thresh: float = 0.5) -> List[List[float]]:
    """去除 YOLO 对同一字符的重叠重复框。det 形如 [x1,y1,x2,y2,conf,cls]：
    按置信度降序贪心保留，与已保留框 IoU 超过阈值的视为重复并丢弃。"""
    kept: List[List[float]] = []
    for det in sorted(dets, key=lambda d: d[4] if len(d) > 4 else 0.0, reverse=True):
        if all(_iou(det, k) < iou_thresh for k in kept):
            kept.append(det)
    return kept


class TextSelectCaptcha(object):
    def __init__(self, per_path: str = 'pre_model_v7.onnx', yolo_path: str = 'best_v3.onnx') -> None:
        save_path = os.path.join(os.path.dirname(__file__), '../model')
        path = lambda a, b: os.path.join(a, b)
        per_path = path(save_path, per_path)
        yolo_path = path(save_path, yolo_path)
        self.yolo = yolo_onnx.YOLO(yolo_path)
        self.pre = ver_onnx.PreONNX(per_path)

    def detection(self, image_path: str) -> List[List[float]]:
        img = matchingMode.open_image(image_path)
        data = self.yolo.inference(img)
        return data

    def run(self, image_path: str, click_text: Optional[str] = None) -> List[List[float]]:
        img = matchingMode.open_image(image_path)
        data = self.yolo.inference(img)
        print(data)
        target_boxes = [item[:4] for item in data if len(item) >= 6 and item[5] == 2]
        char_dets = _dedup_overlapping([item for item in data if len(item) >= 6 and item[5] == 0])
        char_boxes = [item[:4] for item in char_dets]
        char_boxes.sort(key=lambda box: box[0])
        print(f"检测到 {len(target_boxes)} 个目标，{len(char_boxes)} 个字符")
        if not char_boxes:
            return []
        chars = [img[int(box[1]):int(box[3]), int(box[0]):int(box[2])] for box in char_boxes]
        if target_boxes:
            img_targets = [img[int(box[1]):int(box[3]), int(box[0]):int(box[2])] for box in target_boxes]
            slys = self.pre.reason_all_batch(chars, img_targets)
        elif click_text:
            chars_to_click = [c for c in click_text.replace(' ', '') if c.strip()]
            img_targets = [_render_char(c) for c in chars_to_click]
            slys = self.pre.reason_all_batch(chars, img_targets)
            print("渲染匹配分数:")
            for i, c in enumerate(chars_to_click):
                col_scores = [slys[j][i] for j in range(len(slys))]
                scores = sorted(enumerate(col_scores), key=lambda x: -x[1])
                print(f"  '{c}' -> 最佳: char{scores[0][0]}({scores[0][1]:.3f}), 次佳: char{scores[1][0]}({scores[1][1]:.3f})" if len(scores) >= 2 else f"  '{c}' -> char{scores[0][0]}({scores[0][1]:.3f})")
        else:
            return char_boxes
        sorted_result = matchingMode.find_overall_index_fast(slys)
        # 按 target 顺序排列（target_index 越小 → 越先点击）
        sorted_result.sort(key=lambda x: x[1])
        if click_text:
            chars_to_click = [c for c in click_text.replace(' ', '') if c.strip()]
            print(chars_to_click)
            sorted_result = sorted_result[:len(chars_to_click)]
        result = [char_boxes[i] for i, _ in sorted_result]
        return result

    def run_dict(self, image_path: str, click_text: Optional[str] = None) -> Dict[str, Any]:
        img = matchingMode.open_image(image_path)
        h, w, _ = img.shape
        result = self.run(image_path, click_text=click_text)
        return {
            "imgW": w,
            "imgH": h,
            "point": [{"x_rel": (x1 + x2) / 2, "y_rel": (y1 + y2) / 2} for x1, y1, x2, y2 in result],
            "corp": [{"x1": x1, "y1": y1, "x2": x2, "y2": y2} for x1, y1, x2, y2 in result],
        }


if __name__ == '__main__':
    from src.drawing import drow_img
    cap = TextSelectCaptcha()
    image_path = r"../docs/res.jpg"
    result = cap.run(image_path)
    print(result)
    drow_img(image_path, result)
    print(cap.run_dict(image_path))
# !/usr/bin/env python
# -*-coding:utf-8 -*-

"""
# File       : demo.py
# Time       ：2023/4/21 14:56
# Author     ：yujia
# version    ：python 3.6
# Description：
"""
from src.captcha import TextSelectCaptcha
from src.drawing import drow_img
import time
import json
import cv2


s = time.time()
cap = TextSelectCaptcha()
print("加载模型耗时：", time.time() - s)


image_path = "docs/cap_union_new_getcapbysig.png"
s = time.time()
click_text = "澄 豹 雹"

result = cap.run(image_path, click_text)
print(f"推理耗时：{int((time.time() - s) *1000)}ms", )
print("文字坐标：", result, f"耗时：{int((time.time() - s) * 1000)}ms", )
drow_img(image_path, result)
print("生成图片res2.jpg")
result = cap.run_dict(image_path)
data = json.dumps(result, indent=4, ensure_ascii=False)

# 在图像上绘制所有检测目标（含类别标注）
detections = cap.detection(image_path)
img = cv2.imread(image_path)
for det in detections:
    x1, y1, x2, y2 = [int(v) for v in det[:4]]
    conf = det[4]
    cls_id = int(det[5]) if len(det) >= 6 else -1
    color = (0, 0, 255) if cls_id == 0 else (255, 0, 0)  # 红色=class0, 蓝色=其他
    label = f"cls{cls_id} {conf:.2f}"
    cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
    cv2.putText(img, label, (x1, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
cv2.imwrite("res_det.jpg", img)
print(f"检测标注图已保存: res_det.jpg ({len(detections)} 个目标)")

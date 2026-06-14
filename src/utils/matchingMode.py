# !/usr/bin/env python
# -*-coding:utf-8 -*-

"""
# File       : matchingMode.py
# Time       ：2024/8/18 20:10
# Author     ：yujia
# version    ：python 3.6
# Description：
"""
import numpy as np
import cv2
from itertools import permutations
from typing import List, Tuple


def _greedy_assignment(mat: np.ndarray, n_cols: int, k: int) -> List[Tuple[int, int]]:
    """贪心：每次取全局最大值，划掉所在行列，重复 k 次（规模大时回退用）"""
    mat = mat.copy()
    index = []
    for _ in range(k):
        flat_idx = int(np.argmax(mat))
        row, col = divmod(flat_idx, n_cols)
        index.append((row, col))
        mat[row, :] = -np.inf
        mat[:, col] = -np.inf
    return index


def _optimal_assignment(mat: np.ndarray, n_rows: int, n_cols: int) -> List[Tuple[int, int]]:
    """枚举所有合法搭配，返回使所选 min(n_rows,n_cols) 对总分最大的分配。
    字数很少（3~5），全排列开销可忽略，且避免贪心的局部错配。"""
    best_score = -np.inf
    best: List[Tuple[int, int]] = []
    if n_rows <= n_cols:
        for cols in permutations(range(n_cols), n_rows):
            s = sum(mat[r, c] for r, c in zip(range(n_rows), cols))
            if s > best_score:
                best_score = s
                best = [(r, c) for r, c in zip(range(n_rows), cols)]
    else:
        for rows in permutations(range(n_rows), n_cols):
            s = sum(mat[r, c] for r, c in zip(rows, range(n_cols)))
            if s > best_score:
                best_score = s
                best = [(r, c) for r, c in zip(rows, range(n_cols))]
    return best


def find_overall_index_fast(matrix: List[List[float]]) -> List[Tuple[int, int]]:
    """求字符框与提示字之间的最优一一对应（总相似度最大）。
    返回 [(row=字符框索引, col=提示字索引), ...]，按 row 排序。"""
    if not matrix:
        return []

    mat = np.array(matrix, dtype=np.float64)
    n_rows, n_cols = mat.shape
    k = min(n_rows, n_cols)
    # 小规模用最优分配；异常大时回退贪心，避免组合爆炸
    if max(n_rows, n_cols) <= 9:
        index = _optimal_assignment(mat, n_rows, n_cols)
    else:
        index = _greedy_assignment(mat, n_cols, k)
    index.sort(key=lambda x: x[0])
    return index


def open_image(file, flags=cv2.IMREAD_COLOR):
    """
    使用 OpenCV 读取图像，支持中文路径、numpy数组、bytes。

    Args:
        file: 输入，可以是文件路径（str 或 Path）、numpy 数组、bytes 数据
        flags: cv2.imdecode 的标志，默认为彩色（cv2.IMREAD_COLOR）

    Returns:
        np.ndarray: OpenCV 格式的图像（BGR 通道）
    """
    if isinstance(file, np.ndarray):
        # 已经是 numpy 数组，直接返回（假设其为合法图像）
        return file
    elif isinstance(file, bytes):
        # 从 bytes 数据解码
        data = np.frombuffer(file, dtype=np.uint8)
        img = cv2.imdecode(data, flags)
        return img
    else:
        # 文件路径（字符串或 Path 对象），以二进制方式读取，避免中文路径问题
        path = str(file)
        with open(path, 'rb') as f:
            data = np.frombuffer(f.read(), dtype=np.uint8)
        img = cv2.imdecode(data, flags)
        return img
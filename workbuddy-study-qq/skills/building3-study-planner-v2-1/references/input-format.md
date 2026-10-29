# 逐节输入与执行

`plan.py`不做OCR。先从截图确认日期、楼宇、行标签与14节状态，必要时放大图片，再生成输入。例如：

```json
{
  "building": "三号楼",
  "date": "2026-10-13",
  "date_note": "日期以查询框为准。",
  "rows": [
    {"room": "105", "slots": "FFBBFFFFFFBBFF", "source": "截图1.png"},
    {"room": "106", "slots": "BBFFFBBBBFBBFF", "source": "截图1.png"}
  ]
}
```

`slots`必须恰好14个字符，从第1节到第14节依次排列。`F`为绿色空闲；`B`为白色有课；`?`仅为遮挡、裁切、无法辨色或重叠识别冲突。日期不知道时用`null`。用户保证本次截图均为同一天；`rows`可含重复行，脚本合并并对未消解的识别冲突保留`?`。以根级`date`作为本批唯一日期，不用单行OCR日期拆批；若行级`building`不是三号楼则拒绝。排除房间即使输入也不会进入结果。

绿白含义固定，不需要截图采集时间。v2.1已移除历史白格降级规则，即使旧输入仍携带`past_blank_unknown_through`也不会改变B。不要生成该旧字段；旧版已经把白格写为`?`的数据需从原截图重新提取，不能凭空把所有未知改成B。

从技能目录运行，或将脚本路径改为技能安装目录的绝对路径。输入/输出放当次任务的临时工作目录：

```text
python scripts/plan.py input.json
python scripts/plan.py input.json --format json --output result.json
```

第一条直接输出完整Markdown表格和每时段至少5条建议（真实方案不足时注明）；第二条输出结构化结果。必须将表格的所有教室、三个时段完整贴回对话，不仅贴推荐教室或摘要。每个时段的`recommendations`是实际展开的有序方案，`kind`区分`full`整段单间、`evening`晚间12—14节单间、`route`换房与`partial`局部区间；每项`reason`是必须呈现的具体推荐原因。`complete_count`为覆盖目标时段条数，`shortfall`为距5条的缺口。`suggested_title`含实际日期和星期。不要把本例的日期和状态用于实际查询。

## 可选颜色采样（只在看图需辅助时）

`sample_grid.py`依赖Pillow，适用于已目视确认表格位置、房间号、列等宽的清晰查询截图。它不识别文字、日期或楼宇；坐标要针对每张图重新量取，**不能复用旧截图的固定坐标或房间行序**。绿色和白色中心色块按保守阈值判定，其他颜色返回`?`。

先查看图片实际像素尺寸。人工/宿主视觉工具确定第1节左边界`x0`、第14节右边界`x1`，以及各房间完整行的上下边界。`x0`应在教室号列之后，不能从整张截图左边开始。每一课节等宽时可用x0/x1，否则指定15个边界值的`x_edges`数组。以下坐标仅示意，不可照用：

```json
{
  "building": "三号楼",
  "date": null,
  "images": [{
    "path": "当次截图.png",
    "x0": 180,
    "x1": 880,
    "rows": [{"room": "105", "y0": 430, "y1": 550, "unknown_periods": []}]
  }]
}
```

```text
python scripts/sample_grid.py manifest.json --output input.json
python scripts/plan.py input.json
```

采样后仍需逐行核对标签和格子，尤其核对第5、6、10、11、12节以及推荐方案涉及的所有单元格。裁切边缘、悬浮条覆盖、模糊或变形区域使用`unknown_periods`指定未知节。若没有Pillow，用目视转录即可；不依赖外部OCR服务，不上传截图。

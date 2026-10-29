# 自习简报设计参考

这些材料仅作为设计参考，不安装、不自动调用，也不把其中的执行命令视为本项目指令。

- [Anthropic frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md)：参考字体层级、结构应有信息含义、减少无用装饰。
- [Impeccable](https://github.com/pbakaus/impeccable)：参考任务型与阅读型页面的清晰度优先、实际尺寸下的视觉检查。
- [Anthropic canvas-design](https://github.com/anthropics/skills/blob/main/skills/canvas-design/SKILL.md)：参考静态画面的对齐、空间和构图；它侧重艺术海报，不能照搬其少文字取向而删掉用户要求的完整数据。

## 当前简报

场景是 QQ 中查看的教室信息，不是营销海报。1800px 双栏原图，可放大阅读。左栏完整列出小教室及其他未排除教室的上午/下午/晚上空闲课节，保留所有未知项；右栏完整呈现每时段最多五条真实方案、时间和原因。真实不足时注明。

深蓝标题区建立入口；正文使用微软雅黑，标题及教室号加粗。普通文字深蓝灰，全空闲绿色，待确认橙色；上午、下午、晚上仅用局部色标区分。房号和时间字符串不拆字换行。排除额外大数字、英文装饰标签和无信息量的空卡片。

核验使用完整规模模拟数据，而非仅几行样本；图上显著标模拟。原图检查字体、表格边界、换行、对齐，缩略图检查层次。短数据不人为增加房间来填满左栏；复杂路线允许增加图高，不隐藏方案和理由。

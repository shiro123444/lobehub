import type { PresentationActivity } from '@/types/presentationActivity';

import type { AtomicOperationEvent } from '../atomic-runtime';

const labels: Record<string, string> = {
  'context.readFile': '读取参考材料',
  'context.readSkill': '读取创作技能',
  'context.search': '搜索相关资料',
  'planning.update': '调整创作方向',
  'planning.outline': '组织逐页大纲',
  'presentation.template.list': '查找参考模板',
  'presentation.template.resolve': '读取模板规范',
  'presentation.template.render': '查看模板页面',
  'presentation.template.analyzeVisual': '分析模板的视觉与组件',
  'presentation.template.extractComponent': '提取模板组件',
  'presentation.template.inspectNative': '识别模板中的可编辑内容',
  'presentation.template.extractAssets': '提取模板素材',
  'assets.generate': '生成视觉素材',
  'assets.removeBackground': '处理素材的透明背景',
  'assets.transform': '调整素材尺寸与裁切',
  'assets.compose': '组合视觉素材',
  'assets.applyMask': '处理素材区域',
};

export const presentationActivity = (event: AtomicOperationEvent): PresentationActivity => ({
  operation: event.name,
  state: event.state,
  text:
    event.state === 'failed'
      ? `${labels[event.name] ?? '当前操作'}未完成，正在调整`
      : event.state === 'completed'
        ? `${labels[event.name] ?? '当前操作'}已完成`
        : `正在${labels[event.name] ?? '处理创作任务'}`,
});

'use strict';

/**
 * LLM 两条消费链路的提示词与响应解析:
 *   1. 独立技能中文概述(仅中文界面;非中文界面以 frontmatter 描述代替,不走 LLM)
 *   2. 无归属记录技能的候选仓库推断(带置信度)
 * UApiPro 翻译接口不得充当摘要模型(见 spec)。
 */

const SUMMARY_SYSTEM = `你是技能(skill)文档编目员。用户给你一个 Claude/Agent 技能的 SKILL.md 元信息与正文开头,请输出严格的 JSON:
{"summary": "<2-3 句中文概述,信息密度优先,回答它是什么、什么时候用>", "categories": ["<1-2 个分类>"]}
只输出 JSON,不要输出其他内容。分类必须且只能从这 7 个一级分类里选:开发与工程(编码/测试/调试/规格/项目管理等一切工程向)、写作沟通、学习研究、设计创意、数据分析、生活效率、其他;拿不准就给「其他」,不要自拟。`;

function buildSummaryMessages(entity) {
  const body = String(entity.description || '');
  return [
    { role: 'system', content: SUMMARY_SYSTEM },
    {
      role: 'user',
      content: `技能名: ${entity.name}\nfrontmatter 描述: ${body}\n\n正文前 3000 字符:\n${(entity.bodyPreview || '').slice(0, 3000)}`,
    },
  ];
}

function parseSummary(obj) {
  if (!obj || typeof obj.summary !== 'string') return null;
  const categories = Array.isArray(obj.categories)
    ? obj.categories.filter((c) => typeof c === 'string' && c.trim()).slice(0, 3)
    : [];
  return { summary: obj.summary.trim(), categories };
}

const INFERENCE_SYSTEM = `你是技能仓库归属推断器。用户给你一个无安装记录的技能的 SKILL.md 内容和一个已知仓库列表,请推断它最可能来自哪个仓库。
输出严格 JSON:{"repo": "<owner/repo 或 null>", "confidence": "high|medium|low", "alternatives": ["<owner/repo>", ...]}
依据:技能名、内容风格、提到过的仓库/作者/URL。没把握就给 low 或 null,不要编造。只输出 JSON。`;

function buildInferenceMessages(entity, knownRepos) {
  return [
    { role: 'system', content: INFERENCE_SYSTEM },
    {
      role: 'user',
      content: `已知仓库列表:\n${(knownRepos || []).join('\n')}\n\n技能名: ${entity.name}\nSKILL.md 前 4000 字符:\n${(entity.bodyPreview || '').slice(0, 4000)}`,
    },
  ];
}

function parseInference(obj) {
  if (!obj || typeof obj.repo !== 'string' || !obj.repo.trim()) return null;
  const confidence = ['high', 'medium', 'low'].includes(obj.confidence) ? obj.confidence : 'medium';
  const alternatives = Array.isArray(obj.alternatives)
    ? obj.alternatives.filter((r) => typeof r === 'string' && r.trim()).slice(0, 3)
    : [];
  return { repo: obj.repo.trim(), confidence, alternatives };
}

module.exports = {
  buildSummaryMessages,
  parseSummary,
  buildInferenceMessages,
  parseInference,
};

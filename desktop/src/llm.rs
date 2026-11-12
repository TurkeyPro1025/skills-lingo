//! OpenAI 兼容 LLM 适配器 + 两条消费链路的提示词/解析(与 Node llm/provider.js、tasks.js 对齐)。

use serde_json::{json, Value};

#[derive(Clone)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

pub struct LlmProvider {
    client: reqwest::Client,
}

#[derive(Debug)]
pub struct LlmError {
    pub code: &'static str,
    pub message: String,
}

impl LlmProvider {
    pub fn new() -> Self {
        Self { client: reqwest::Client::new() }
    }

    pub fn configured(cfg: &LlmConfig) -> bool {
        !cfg.base_url.is_empty() && !cfg.api_key.is_empty() && !cfg.model.is_empty()
    }

    pub async fn chat(&self, cfg: &LlmConfig, messages: &[(String, String)]) -> Result<String, LlmError> {
        if !Self::configured(cfg) {
            return Err(LlmError { code: "provider_unconfigured", message: "LLM provider 未配置".into() });
        }
        let base = cfg.base_url.trim_end_matches('/');
        let msgs: Vec<Value> = messages
            .iter()
            .map(|(role, content)| json!({ "role": role, "content": content }))
            .collect();
        let res = self
            .client
            .post(format!("{base}/chat/completions"))
            .header("Authorization", format!("Bearer {}", cfg.api_key))
            .json(&json!({ "model": cfg.model, "messages": msgs, "temperature": 0.3 }))
            .timeout(std::time::Duration::from_millis(120_000))
            .send()
            .await
            .map_err(|e| LlmError { code: "network", message: e.to_string() })?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let detail = res.text().await.unwrap_or_default();
            return Err(LlmError {
                code: "http",
                message: format!("LLM 服务返回 {status}: {}", &detail[..detail.len().min(300)]),
            });
        }
        let body: Value = res.json().await.map_err(|e| LlmError { code: "network", message: e.to_string() })?;
        let content = body
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str());
        match content {
            Some(c) => Ok(c.to_string()),
            None => Err(LlmError { code: "bad_response", message: "LLM 响应缺少 choices[0].message.content".into() }),
        }
    }

    pub async fn chat_json(&self, cfg: &LlmConfig, messages: &[(String, String)]) -> Result<Value, LlmError> {
        let raw = self.chat(cfg, messages).await?;
        Ok(extract_json(&raw).unwrap_or(Value::Null))
    }
}

/// 提取第一个 JSON 对象(fenced 块优先)
pub fn extract_json(text: &str) -> Option<Value> {
    let mut candidates: Vec<String> = Vec::new();
    let fenced = regex::Regex::new(r"(?s)```(?:json)?\s*(.*?)```").unwrap();
    if let Some(m) = fenced.captures(text) {
        candidates.push(m.get(1).unwrap().as_str().to_string());
    }
    if let (Some(first), Some(last)) = (text.find('{'), text.rfind('}')) {
        if last > first {
            candidates.push(text[first..=last].to_string());
        }
    }
    candidates.push(text.to_string());
    for c in candidates {
        if let Ok(v) = serde_json::from_str::<Value>(c.trim()) {
            return Some(v);
        }
    }
    None
}

/* ---------- 提示词与响应解析(tasks.js) ---------- */

const SUMMARY_SYSTEM: &str = "你是技能(skill)文档编目员。用户给你一个 Claude/Agent 技能的 SKILL.md 元信息与正文开头,请输出严格的 JSON:\n{\"summary\": \"<2-3 句中文概述,信息密度优先,回答它是什么、什么时候用>\", \"categories\": [\"<1-2 个分类>\"]}\n只输出 JSON,不要输出其他内容。分类必须且只能从这 7 个一级分类里选:开发与工程(编码/测试/调试/规格/项目管理等一切工程向)、写作沟通、学习研究、设计创意、数据分析、生活效率、其他;拿不准就给「其他」,不要自拟。";

const INFERENCE_SYSTEM: &str = "你是技能仓库归属推断器。用户给你一个无安装记录的技能的 SKILL.md 内容和一个已知仓库列表,请推断它最可能来自哪个仓库。\n输出严格 JSON:{\"repo\": \"<owner/repo 或 null>\", \"confidence\": \"high|medium|low\", \"alternatives\": [\"<owner/repo>\", ...]}\n依据:技能名、内容风格、提到过的仓库/作者/URL。没把握就给 low 或 null,不要编造。只输出 JSON。";

pub fn build_summary_messages(entity: &crate::scanner::Entity) -> Vec<(String, String)> {
    let preview: String = entity.body_preview.chars().take(3000).collect();
    vec![
        ("system".into(), SUMMARY_SYSTEM.to_string()),
        (
            "user".into(),
            format!(
                "技能名: {}\nfrontmatter 描述: {}\n\n正文前 3000 字符:\n{}",
                entity.name, entity.description, preview
            ),
        ),
    ]
}

pub struct ParsedSummary {
    pub summary: String,
    pub categories: Vec<String>,
}

pub fn parse_summary(obj: &Value) -> Option<ParsedSummary> {
    let summary = obj.get("summary")?.as_str()?.trim().to_string();
    let categories = obj
        .get("categories")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|c| c.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .take(3)
                .collect()
        })
        .unwrap_or_default();
    Some(ParsedSummary { summary, categories })
}

pub fn build_inference_messages(entity: &crate::scanner::Entity, known_repos: &[String]) -> Vec<(String, String)> {
    let preview: String = entity.body_preview.chars().take(4000).collect();
    vec![
        ("system".into(), INFERENCE_SYSTEM.to_string()),
        (
            "user".into(),
            format!(
                "已知仓库列表:\n{}\n\n技能名: {}\nSKILL.md 前 4000 字符:\n{}",
                known_repos.join("\n"),
                entity.name,
                preview
            ),
        ),
    ]
}

pub struct ParsedInference {
    pub repo: String,
    pub confidence: String,
    pub alternatives: Vec<String>,
}

pub fn parse_inference(obj: &Value) -> Option<ParsedInference> {
    let repo = obj.get("repo")?.as_str()?.trim().to_string();
    if repo.is_empty() {
        return None;
    }
    let confidence = obj
        .get("confidence")
        .and_then(|v| v.as_str())
        .filter(|c| ["high", "medium", "low"].contains(&c.to_string().as_str()))
        .unwrap_or("medium")
        .to_string();
    let alternatives = obj
        .get("alternatives")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|c| c.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .take(3)
                .collect()
        })
        .unwrap_or_default();
    Some(ParsedInference { repo, confidence, alternatives })
}

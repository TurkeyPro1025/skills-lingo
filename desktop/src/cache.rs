//! JSON 缓存层(与 Node cache.js 布局兼容):索引 / 每技能每语言一文件 / 译文 / overrides / 状态。
//! 密钥绝不写入任何缓存文件。

use crate::util::{read_json_if_exists, write_json_atomic};
use serde_json::{json, Map, Value};
use std::path::PathBuf;

#[derive(Clone)]
pub struct Cache {
    pub root: PathBuf,
    pub skills_dir: PathBuf,
    pub translations_dir: PathBuf,
}

impl Cache {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self {
            root: data_dir.to_path_buf(),
            skills_dir: data_dir.join("skills"),
            translations_dir: data_dir.join("translations"),
        }
    }

    pub fn ensure_dirs(&self) {
        let _ = std::fs::create_dir_all(&self.root);
        let _ = std::fs::create_dir_all(&self.skills_dir);
        let _ = std::fs::create_dir_all(&self.translations_dir);
    }

    pub fn read_index(&self) -> Option<serde_json::Value> {
        read_json_if_exists(&self.root.join("index.json"))
    }
    pub fn write_index(&self, index: &serde_json::Value) {
        let _ = write_json_atomic(&self.root.join("index.json"), index);
    }

    // ---- LLM 推断增量缓存:hash 与结果绑定,逐条实时落盘 ----
    // index.json 只在整轮分析(归属+概述+翻译)末尾写入,推断若不单独落盘,
    // 中途退出会让已烧掉的 LLM 调用全部作废,下轮从 0 重推。
    fn inference_file(&self) -> PathBuf {
        self.root.join("inference.json")
    }

    pub fn read_inference(&self) -> Value {
        read_json_if_exists(&self.inference_file())
            .filter(|v| v.get("entries").map(|e| e.is_object()).unwrap_or(false))
            .unwrap_or_else(|| json!({ "version": 1, "entries": {} }))
    }

    pub fn append_inference(&self, id: &str, content_hash: &str, result: &Value) {
        let mut d = self.read_inference();
        d["entries"][id] = json!({ "hash": content_hash, "result": result.clone() });
        let _ = write_json_atomic(&self.inference_file(), &d);
    }

    pub fn reset_inference(&self) {
        let _ = write_json_atomic(&self.inference_file(), &json!({ "version": 1, "entries": {} }));
    }

    // ---- 每技能每语言一文件(概述/分类,记录内容哈希做增量) ----
    // v1 布局 skills/{id}.json 是中文概述;读取中文时懒迁移到 skills/{id}/zh.json,
    // 英文等其它语言只读自己的语言段,不会误用中文概述。
    fn skill_file(&self, id: &str, lang: &str) -> PathBuf {
        self.skills_dir.join(id).join(format!("{lang}.json"))
    }

    fn legacy_skill_file(&self, id: &str) -> PathBuf {
        self.skills_dir.join(format!("{id}.json"))
    }

    pub fn read_skill(&self, id: &str, lang: &str) -> Option<Value> {
        if let Some(hit) = read_json_if_exists(&self.skill_file(id, lang)) {
            return Some(hit);
        }
        if lang != "zh" {
            return None;
        }
        let legacy = read_json_if_exists(&self.legacy_skill_file(id))?;
        let _ = write_json_atomic(&self.skill_file(id, "zh"), &legacy);
        Some(legacy)
    }

    pub fn write_skill(&self, id: &str, lang: &str, data: &Value) {
        let _ = write_json_atomic(&self.skill_file(id, lang), data);
    }

    // ---- 语言相关的元数据翻译缓存:仓库简介 / 分类标签(按源文本哈希失效) ----
    fn repo_summaries_file(&self, lang: &str) -> PathBuf {
        self.root.join("summaries").join("repos").join(format!("{lang}.json"))
    }

    pub fn read_repo_summaries(&self, lang: &str) -> Value {
        read_json_if_exists(&self.repo_summaries_file(lang))
            .filter(|v| v.get("entries").map(|e| e.is_object()).unwrap_or(false))
            .unwrap_or_else(|| json!({ "version": 1, "lang": lang, "entries": {} }))
    }

    pub fn write_repo_summaries(&self, lang: &str, data: &Value) {
        let out = json!({
            "version": 1,
            "lang": lang,
            "entries": data.get("entries").cloned().unwrap_or(json!({})),
        });
        let _ = write_json_atomic(&self.repo_summaries_file(lang), &out);
    }

    fn label_map_file(&self, lang: &str) -> PathBuf {
        self.root.join("summaries").join("labels").join(format!("{lang}.json"))
    }

    pub fn read_label_map(&self, lang: &str) -> Map<String, Value> {
        read_json_if_exists(&self.label_map_file(lang))
            .and_then(|v| v.get("labels").and_then(|l| l.as_object()).cloned())
            .unwrap_or_default()
    }

    pub fn write_label_map(&self, lang: &str, labels: &Map<String, Value>) {
        let out = json!({ "version": 1, "lang": lang, "labels": labels });
        let _ = write_json_atomic(&self.label_map_file(lang), &out);
    }

    pub fn read_overrides(&self) -> serde_json::Value {
        match read_json_if_exists(&self.root.join("overrides.json")) {
            Some(v) if v.get("entries").map(|e| e.is_object()).unwrap_or(false) => v,
            _ => serde_json::json!({ "version": 1, "entries": {} }),
        }
    }
    pub fn write_overrides(&self, data: &serde_json::Value) {
        let _ = write_json_atomic(&self.root.join("overrides.json"), data);
    }

    pub fn read_state(&self) -> serde_json::Value {
        read_json_if_exists(&self.root.join("state.json")).unwrap_or_else(|| serde_json::json!({
            "version": 1,
            "consentTranslate": false,
            "creditsUsed": 0,
            "apiCalls": 0,
            "lastAnalysis": null,
        }))
    }
    pub fn write_state(&self, state: &serde_json::Value) {
        let _ = write_json_atomic(&self.root.join("state.json"), state);
    }
}

//! 翻译管线(与 Node translate/pipeline.js 对齐):
//! 块级解析 → 行内保护 → 分块打包 → 拆回按 ID 关联 → 缓存。
//! 缓存键 = 技能 id + 语言 + 文档内容哈希;并发翻译共享同一 in-flight 任务。

use crate::translate_blocks::{parse_blocks, protect_inline, restore_inline, Block};
use crate::uapipro::UApiProProvider;
use crate::util::{detect_language, now_iso, read_json_if_exists, sha1_hex, write_json_atomic};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

const CACHE_VERSION: i64 = 2;
const CHUNK_MARGIN: usize = 100;
/// 打包目标字符数:uapipro 在 Cloudflare 后,大包(origin 处理慢)易 524 超时——
/// 实测 ~4700 字符即触发。按 3000 打包:首包成功率与响应速度都更好,6 并发下吞吐不吃亏
const PACK_TARGET: usize = 3000;

/// 打包上限:接口硬限(1 万)与 524 规避目标的较小者
fn pack_max_chars(provider: &UApiProProvider) -> usize {
    provider.cfg.max_chars_per_call.saturating_sub(CHUNK_MARGIN).min(PACK_TARGET)
}

pub struct PipelineError {
    pub code: &'static str,
    pub message: String,
    pub params: Option<Value>,
}

impl PipelineError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), params: None }
    }

    pub fn with_params(code: &'static str, message: impl Into<String>, params: Value) -> Self {
        Self { code, message: message.into(), params: Some(params) }
    }
}

pub struct Pipeline {
    pub provider: Arc<UApiProProvider>,
    pub cache_dir: PathBuf,
    inflight: Mutex<std::collections::HashSet<String>>,
    /// 单文档翻译实时进度(经 /api/status 暴露给查看器横幅);None = 无进行中的翻译。
    /// creditsEstimated = 打包调用数 × 每次调用积分(若发生逐块降级,实际消耗会更多)。
    doc_progress: std::sync::Mutex<Option<Value>>,
}

impl Pipeline {
    pub fn new(provider: Arc<UApiProProvider>, cache_dir: PathBuf) -> Self {
        Self {
            provider,
            cache_dir,
            inflight: Mutex::new(std::collections::HashSet::new()),
            doc_progress: std::sync::Mutex::new(None),
        }
    }

    /// 当前文档翻译进度快照(供 GET /translate 判断 started/预计积分)
    pub fn doc_progress(&self) -> Option<Value> {
        self.doc_progress.lock().unwrap().clone()
    }

    /// 渐进拉取支持:返回缓存条目(部分完成也返回),供 GET /translate 使用
    pub fn cached_translation(&self, skill_id: &str, lang: &str, doc_hash: &str) -> Option<Value> {
        self.read_cache(skill_id, doc_hash, lang)
    }

    fn cache_file(&self, skill_id: &str, lang: &str, doc_hash: &str) -> PathBuf {
        self.cache_dir
            .join("translations")
            .join(skill_id)
            .join(lang)
            .join(format!("{doc_hash}.json"))
    }

    /// v1 布局(无语言段)的旧文件:只按中文解释,英文请求不得误命中中文译文
    fn legacy_cache_file(&self, skill_id: &str, doc_hash: &str) -> PathBuf {
        self.cache_dir
            .join("translations")
            .join(skill_id)
            .join(format!("{doc_hash}.json"))
    }

    /// 读缓存;docHash 不匹配(内容已变)即视为 miss。中文请求可懒迁移 v1 旧文件。
    fn read_cache(&self, skill_id: &str, doc_hash: &str, lang: &str) -> Option<Value> {
        if let Some(hit) = read_json_if_exists(&self.cache_file(skill_id, lang, doc_hash)) {
            let ok = hit.get("version").and_then(|v| v.as_i64()) == Some(CACHE_VERSION)
                && hit.get("lang").and_then(|v| v.as_str()) == Some(lang)
                && hit.get("docHash").and_then(|v| v.as_str()) == Some(doc_hash);
            if ok {
                return Some(hit);
            }
        }
        if lang != "zh" {
            return None;
        }
        let legacy = read_json_if_exists(&self.legacy_cache_file(skill_id, doc_hash))?;
        let legacy_ok = legacy.get("version").and_then(|v| v.as_i64()) == Some(1)
            && legacy.get("docHash").and_then(|v| v.as_str()) == Some(doc_hash);
        if !legacy_ok {
            return None;
        }
        // 旧缓存必为中文译文:迁移到新路径,中文缓存与积分无损
        let mut migrated = legacy.clone();
        if let Some(obj) = migrated.as_object_mut() {
            obj.insert("version".into(), json!(CACHE_VERSION));
            obj.insert("lang".into(), json!("zh"));
        }
        self.write_cache(&migrated);
        let _ = std::fs::remove_file(self.legacy_cache_file(skill_id, doc_hash));
        Some(migrated)
    }

    fn write_cache(&self, entry: &Value) {
        let id = entry.get("skillId").and_then(|v| v.as_str()).unwrap_or_default();
        let lang = entry.get("lang").and_then(|v| v.as_str()).unwrap_or("zh");
        let hash = entry.get("docHash").and_then(|v| v.as_str()).unwrap_or_default();
        let _ = write_json_atomic(&self.cache_file(id, lang, hash), entry);
    }

    /// 确保某文档有目标语言译文:缓存命中直接返回,否则翻译并写缓存(in-flight 去重)。
    /// 文档语言与目标语言一致时单栏直出、不翻译、不耗积分。
    pub async fn ensure_translation(
        &self,
        entity_id: &str,
        entity_real_path: &std::path::Path,
        doc_rel_path: &str,
        api_key: &str,
        consented: bool,
        lang: &str,
    ) -> Result<Value, PipelineError> {
        let doc_path = entity_real_path.join(doc_rel_path);
        let raw = match std::fs::read_to_string(&doc_path) {
            Ok(r) => r,
            Err(_) => {
                return Err(PipelineError::with_params(
                    "doc_unreadable",
                    format!("文档不可读: {doc_rel_path}"),
                    json!({ "path": doc_rel_path }),
                ))
            }
        };
        let doc_hash = sha1_hex(&raw);
        if detect_language(&raw) == lang {
            return Ok(json!({
                "language": lang, "cached": true, "blocks": null, "reason": "same_language",
            }));
        }

        // 完整缓存直接返回;部分缓存(上次翻译中断,存在 pending 块)保留待续翻
        let cached_entry = self.read_cache(entity_id, &doc_hash, lang);
        if let Some(c) = &cached_entry {
            let has_pending = c
                .get("blocks")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().any(|b| b.get("status").and_then(|s| s.as_str()) == Some("pending")))
                .unwrap_or(false);
            if !has_pending {
                let mut out = c.clone();
                out.as_object_mut().unwrap().insert("cached".into(), Value::Bool(true));
                return Ok(out);
            }
        }

        if !self.provider.configured(api_key) {
            return Err(PipelineError::new(
                "provider_unconfigured",
                "翻译 provider 未配置(API key 缺失)",
            ));
        }
        if !consented {
            return Err(PipelineError::new("consent_required", "需要用户同意隐私提示后才能翻译"));
        }

        let inflight_key = format!("{entity_id}\0{lang}\0{doc_hash}");
        {
            let guard = self.inflight.lock().await;
            if guard.contains(&inflight_key) {
                drop(guard);
                // 等待另一任务完成,然后读它的缓存(与 Node 共享同一 Promise 等价)。
                // 注意过滤中途落盘的部分缓存(存在 pending 块):对方仍在翻译,不能当完整结果
                let mut spins = 0;
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                    if let Some(done) = self.read_cache(entity_id, &doc_hash, lang) {
                        let has_pending = done
                            .get("blocks")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().any(|b| b.get("status").and_then(|s| s.as_str()) == Some("pending")))
                            .unwrap_or(false);
                        if !has_pending {
                            let mut out = done;
                            out.as_object_mut().unwrap().insert("cached".into(), Value::Bool(true));
                            return Ok(out);
                        }
                    }
                    spins += 1;
                    let still = self.inflight.lock().await.contains(&inflight_key);
                    if !still || spins > 500 {
                        break;
                    }
                }
                // 仍无结果(对方失败):落回自己翻
            }
        }

        {
            let mut guard = self.inflight.lock().await;
            guard.insert(inflight_key.clone());
        }
        // 部分缓存续翻剩余块;否则全新翻译
        let result = match cached_entry {
            Some(partial) => {
                let mut v = self.resume_translation(entity_id, doc_rel_path, partial, api_key, lang).await;
                v.as_object_mut().unwrap().insert("cached".into(), Value::Bool(true));
                Ok(v)
            }
            None => {
                self.translate_doc(entity_id, entity_real_path, doc_rel_path, &raw, &doc_hash, api_key, lang)
                    .await
            }
        };
        {
            let mut guard = self.inflight.lock().await;
            guard.remove(&inflight_key);
        }
        match result {
            Ok(mut v) => {
                v.as_object_mut()
                    .unwrap()
                    .entry("cached".to_string())
                    .or_insert_with(|| Value::Bool(false));
                Ok(v)
            }
            Err(e) => Err(e),
        }
    }

    async fn translate_doc(
        &self,
        entity_id: &str,
        entity_real_path: &std::path::Path,
        doc_rel_path: &str,
        raw: &str,
        doc_hash: &str,
        api_key: &str,
        lang: &str,
    ) -> Result<Value, PipelineError> {
        let fm = crate::frontmatter::parse_frontmatter(raw);
        let blocks = parse_blocks(&fm.body, 6000);
        let translatable: Vec<&Block> = blocks.iter().filter(|b| b.translatable).collect();

        let blocks_json: Vec<Value> = blocks
            .iter()
            .map(|b| {
                json!({
                    "id": b.id,
                    "type": b.kind,
                    "src": b.text,
                    "translated": "",
                    "status": if b.translatable { "pending" } else { "original" },
                })
            })
            .collect();
        let mut result = json!({
            "version": CACHE_VERSION,
            "lang": lang,
            "skillId": entity_id,
            "realPath": entity_real_path.to_string_lossy(),
            "docRelPath": doc_rel_path,
            "docHash": doc_hash,
            "provider": "uapipro",
            "createdAt": now_iso(),
            "blocks": blocks_json,
            "calls": 0,
            "credits": 0,
        });

        let max_chars = pack_max_chars(&self.provider);
        let chunks_owned: Vec<Vec<(String, String)>> = pack_chunks(&translatable, max_chars)
            .into_iter()
            .map(|c| c.into_iter().map(|b| (b.id.clone(), b.text.clone())).collect())
            .collect();
        self.run_chunks(entity_id, doc_rel_path, chunks_owned, &mut result, api_key, lang, 0, translatable.len() as u64)
            .await;
        self.write_cache(&result);
        Ok(result)
    }

    /// 续翻:以部分缓存为底,把 pending 块继续打包翻译(与首轮同并发/同落盘策略)
    async fn resume_translation(
        &self,
        entity_id: &str,
        doc_rel_path: &str,
        mut cached: Value,
        api_key: &str,
        lang: &str,
    ) -> Value {
        let pending: Vec<(String, String)> = cached
            .get("blocks")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|b| b.get("status").and_then(|s| s.as_str()) == Some("pending"))
                    .filter_map(|b| {
                        Some((b.get("id")?.as_str()?.to_string(), b.get("src")?.as_str()?.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let total = cached
            .get("blocks")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter(|b| b.get("status").and_then(|s| s.as_str()) != Some("original")).count())
            .unwrap_or(0) as u64;
        let resumed = pending.len();
        let pseudo: Vec<Block> = pending
            .into_iter()
            .map(|(id, text)| Block { id, kind: "paragraph".into(), text, translatable: true, items: None })
            .collect();
        let refs: Vec<&Block> = pseudo.iter().collect();
        let max_chars = pack_max_chars(&self.provider);
        let chunks_owned: Vec<Vec<(String, String)>> = pack_chunks(&refs, max_chars)
            .into_iter()
            .map(|c| c.into_iter().map(|b| (b.id.clone(), b.text.clone())).collect())
            .collect();
        self.run_chunks(entity_id, doc_rel_path, chunks_owned, &mut cached, api_key, lang, total - resumed as u64, total)
            .await;
        self.write_cache(&cached);
        let mut out = cached;
        out.as_object_mut().unwrap().insert("resumed".into(), json!(resumed));
        out
    }

    /// 并发翻译一组打包块并合并进 result。每包完成即落盘(部分结果经 GET 端点渐进取回,
    /// 中断后由 resume_translation 续翻,已烧积分不浪费)。发射间隔/并发上限由 provider 闸控制。
    async fn run_chunks(
        &self,
        entity_id: &str,
        doc_rel_path: &str,
        chunks: Vec<Vec<(String, String)>>,
        result: &mut Value,
        api_key: &str,
        lang: &str,
        done_start: u64,
        total: u64,
    ) {
        let credits_per_call = self.provider.cfg.credits_per_call;
        *self.doc_progress.lock().unwrap() = Some(json!({
            "skillId": entity_id,
            "doc": doc_rel_path,
            "done": done_start,
            "total": total,
            "callsDone": 0,
            "callsTotal": chunks.len(),
            "creditsEstimated": chunks.len() as u64 * credits_per_call,
        }));
        let mut set: tokio::task::JoinSet<ChunkOutcome> = tokio::task::JoinSet::new();
        for chunk in chunks {
            let provider = self.provider.clone();
            let api_key = api_key.to_string();
            let lang = lang.to_string();
            set.spawn(async move { translate_chunk_owned(provider, chunk, api_key, lang).await });
        }
        let mut done = done_start;
        while let Some(res) = set.join_next().await {
            // spawn 异常:该包保持 pending,下次续翻
            let Ok(outcome) = res else { continue };
            done += outcome.blocks.len() as u64;
            merge_chunk_outcome(result, outcome);
            let calls = result.get("calls").and_then(|v| v.as_u64()).unwrap_or(0);
            if let Some(p) = self.doc_progress.lock().unwrap().as_mut() {
                p["done"] = json!(done);
                p["callsDone"] = json!(calls);
            }
            self.write_cache(result); // 逐包快照落盘:并发下均为完整快照,后写覆盖先写
        }
        *self.doc_progress.lock().unwrap() = None;
    }

    /// 批量翻译短文本(概述/分类/仓库简介):贴满单次字符上限打包,⟦S n⟧/⟦E⟧ 分隔。
    /// 返回与输入等长的数组;失败或超长项为 null,由调用方回退原文并在下次分析重试。
    pub async fn translate_texts(&self, texts: &[String], lang: &str, api_key: &str) -> Vec<Option<String>> {
        let mut out: Vec<Option<String>> = texts.iter().map(|_| None).collect();
        if texts.is_empty() {
            return out;
        }
        let max = pack_max_chars(&self.provider);
        let mut chunks: Vec<Vec<(usize, String, crate::translate_blocks::ProtectMap)>> = Vec::new();
        let mut cur: Vec<(usize, String, crate::translate_blocks::ProtectMap)> = Vec::new();
        let mut cur_len = 0usize;
        for (i, text) in texts.iter().enumerate() {
            if text.trim().is_empty() {
                out[i] = Some(text.clone());
                continue;
            }
            let (masked, map) = protect_inline(text);
            let add = masked.chars().count() + 16;
            if add > max {
                continue;
            }
            if !cur.is_empty() && cur_len + add > max {
                chunks.push(std::mem::take(&mut cur));
                cur_len = 0;
            }
            cur.push((i, masked, map));
            cur_len += add;
        }
        if !cur.is_empty() {
            chunks.push(cur);
        }

        for chunk in chunks {
            let joined = chunk
                .iter()
                .enumerate()
                .map(|(n, (_, m, _))| format!("⟦S{n}⟧\n{m}"))
                .collect::<Vec<_>>()
                .join("\n⟦E⟧\n");
            // 整包失败:该包的项保持 null,不拖垮其他包
            let Ok((translated, _)) = self.provider.translate_text(&joined, api_key, Some(lang)).await else {
                continue;
            };
            let Some(parts) = split_by_separators(&translated, chunk.len()) else {
                continue;
            };
            for ((i, _masked, map), part) in chunk.iter().zip(parts.iter()) {
                out[*i] = Some(restore_inline(part, map).trim().to_string());
            }
        }
        out
    }

    /// 重试失败块:只重译 status=failed 的块,合并进缓存
    pub async fn retry_failed(
        &self,
        entity_id: &str,
        entity_real_path: &std::path::Path,
        doc_rel_path: &str,
        api_key: &str,
        consented: bool,
        lang: &str,
    ) -> Result<Value, PipelineError> {
        if !self.provider.configured(api_key) {
            return Err(PipelineError::new("provider_unconfigured", "翻译 provider 未配置"));
        }
        if !consented {
            return Err(PipelineError::new("consent_required", "需要用户同意隐私提示后才能翻译"));
        }
        let raw = std::fs::read_to_string(entity_real_path.join(doc_rel_path))
            .map_err(|_| PipelineError::with_params("doc_unreadable", format!("文档不可读: {doc_rel_path}"), json!({ "path": doc_rel_path })))?;
        let doc_hash = sha1_hex(&raw);
        let mut cached = match self.read_cache(entity_id, &doc_hash, lang) {
            Some(c) => c,
            None => {
                return self
                    .ensure_translation(entity_id, entity_real_path, doc_rel_path, api_key, consented, lang)
                    .await
            }
        };

        let failed: Vec<(String, String, String)> = cached
            .get("blocks")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|b| b.get("status").and_then(|s| s.as_str()) == Some("failed"))
                    .filter_map(|b| {
                        Some((
                            b.get("id")?.as_str()?.to_string(),
                            b.get("src")?.as_str()?.to_string(),
                            b.get("type").and_then(|t| t.as_str()).unwrap_or("paragraph").to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if failed.is_empty() {
            let mut out = cached;
            out.as_object_mut().unwrap().insert("cached".into(), Value::Bool(true));
            out.as_object_mut().unwrap().insert("retried".into(), json!(0));
            return Ok(out);
        }

        // 构造伪块走同一并发打包路径
        let pseudo: Vec<Block> = failed
            .iter()
            .map(|(id, text, kind)| Block {
                id: id.clone(),
                kind: kind.clone(),
                text: text.clone(),
                translatable: true,
                items: None,
            })
            .collect();
        let refs: Vec<&Block> = pseudo.iter().collect();
        let total = cached
            .get("blocks")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter(|b| b.get("status").and_then(|s| s.as_str()) != Some("original")).count())
            .unwrap_or(0) as u64;
        let max_chars = pack_max_chars(&self.provider);
        let chunks_owned: Vec<Vec<(String, String)>> = pack_chunks(&refs, max_chars)
            .into_iter()
            .map(|c| c.into_iter().map(|b| (b.id.clone(), b.text.clone())).collect())
            .collect();
        self.run_chunks(entity_id, doc_rel_path, chunks_owned, &mut cached, api_key, lang, total - failed.len() as u64, total)
            .await;
        self.write_cache(&cached);
        let mut out = cached;
        out.as_object_mut().unwrap().insert("cached".into(), Value::Bool(true));
        out.as_object_mut().unwrap().insert("retried".into(), json!(failed.len()));
        Ok(out)
    }
}

/// 单包并发翻译结果(与 result 解耦,便于 JoinSet 并发执行)
struct ChunkOutcome {
    /// (块 id, 译文, 状态 ok/failed, 失败原因)
    blocks: Vec<(String, String, String, Option<String>)>,
    calls: u64,
    credits: u64,
    /// 降级分包等诊断告警(合并进 result.warnings 随缓存落盘)
    warnings: Vec<String>,
}

/// 翻译一包块(owned,可并发执行):打包调用(失败重试一次)→ 仍失败二分分包递归 → 单块直调。
/// 直接逐块降级会让 N 块文档烧 N 倍积分(实测 27 块 = 108 积分),二分把爆炸压回对数级。
async fn translate_chunk_owned(
    provider: std::sync::Arc<UApiProProvider>,
    chunk: Vec<(String, String)>,
    api_key: String,
    lang: String,
) -> ChunkOutcome {
    let masked: Vec<_> = chunk.iter().map(|(_, text)| protect_inline(text)).collect();
    let joined = masked
        .iter()
        .enumerate()
        .map(|(i, (m, _))| format!("⟦S{i}⟧\n{m}"))
        .collect::<Vec<_>>()
        .join("\n⟦E⟧\n");

    let mut last_err = String::new();
    for _attempt in 0..2 {
        match provider.translate_text(&joined, &api_key, Some(&lang)).await {
            Ok((text, credits)) => {
                if let Some(parts) = split_by_separators(&text, masked.len()) {
                    let mut out = ChunkOutcome { blocks: Vec::new(), calls: 1, credits, warnings: Vec::new() };
                    for (((id, _), (_, map)), part) in chunk.iter().zip(masked.iter()).zip(parts.iter()) {
                        out.blocks.push((id.clone(), restore_inline(part, map), "ok".into(), None));
                    }
                    return out;
                }
                last_err = "分隔符丢失".into();
            }
            Err(e) => last_err = e.message,
        }
    }

    let mut out = ChunkOutcome { blocks: Vec::new(), calls: 0, credits: 0, warnings: Vec::new() };
    // 打包两次失败:告警可见(诊断线索随缓存落盘),再降级
    let detail: String = last_err.chars().take(160).collect();
    out.warnings.push(format!(
        "打包翻译失败({} 块,{} 字符):{};已降级分包重试",
        masked.len(),
        joined.chars().count(),
        detail
    ));

    if chunk.len() > 1 {
        // 二分分包(按字符中点切,两半均衡):更短文本 + 更少分隔符,成功率回升;最坏才退化到单块
        let total_chars: usize = masked.iter().map(|(m, _)| m.chars().count()).sum();
        let mut acc = 0usize;
        let mut mid = 1usize;
        for (i, (m, _)) in masked.iter().enumerate().take(chunk.len() - 1) {
            acc += m.chars().count();
            if acc * 2 >= total_chars {
                mid = i + 1;
                break;
            }
        }
        // async 递归需 Box::pin 固定 future 大小
        let mut left = Box::pin(translate_chunk_owned(provider.clone(), chunk[..mid].to_vec(), api_key.clone(), lang.clone())).await;
        let right = Box::pin(translate_chunk_owned(provider, chunk[mid..].to_vec(), api_key, lang)).await;
        left.blocks.extend(right.blocks);
        left.calls += right.calls;
        left.credits += right.credits;
        left.warnings.extend(right.warnings);
        return left;
    }

    // 单块直调(无分隔符包装)
    let (id, text) = &chunk[0];
    let (_, map) = &masked[0];
    match provider.translate_text(text, &api_key, Some(&lang)).await {
        Ok((t, c)) => {
            out.calls += 1;
            out.credits += c;
            out.blocks.push((id.clone(), restore_inline(&t, map), "ok".into(), None));
        }
        Err(e) => out.blocks.push((id.clone(), String::new(), "failed".into(), Some(e.message))),
    }
    out
}

/// 把单包结果合并进文档级 result(块译文/状态 + calls/credits/warnings 累加)
fn merge_chunk_outcome(result: &mut Value, outcome: ChunkOutcome) {
    if let Some(obj) = result.as_object_mut() {
        let calls = obj.get("calls").and_then(|v| v.as_u64()).unwrap_or(0) + outcome.calls;
        let credits = obj.get("credits").and_then(|v| v.as_u64()).unwrap_or(0) + outcome.credits;
        obj.insert("calls".into(), json!(calls));
        obj.insert("credits".into(), json!(credits));
        if !outcome.warnings.is_empty() {
            let mut warnings = obj.get("warnings").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            warnings.extend(outcome.warnings.into_iter().map(Value::String));
            obj.insert("warnings".into(), json!(warnings));
        }
    }
    for (id, translated, status, error) in outcome.blocks {
        if let Some(arr) = result.get_mut("blocks").and_then(|v| v.as_array_mut()) {
            for b in arr {
                if b.get("id").and_then(|x| x.as_str()) == Some(&id) {
                    if let Some(obj) = b.as_object_mut() {
                        obj.insert("translated".into(), json!(translated));
                        obj.insert("status".into(), json!(status));
                        obj.insert("error".into(), error.map(Value::String).unwrap_or(Value::Null));
                    }
                    break;
                }
            }
        }
    }
}

/// 拆回译文:必须精确得到 n 段,否则返回 None
fn split_by_separators(text: &str, n: usize) -> Option<Vec<String>> {
    let mut parts = Vec::with_capacity(n);
    let mut rest = text;
    for i in 0..n {
        let re = regex::Regex::new(&format!(r"^\s*⟦S{i}⟧\s*\n?")).unwrap();
        let m = re.find(rest)?;
        rest = &rest[m.end()..];
        let end_idx = rest.find("⟦E⟧");
        if i < n - 1 {
            let end = end_idx?;
            parts.push(rest[..end].to_string());
            rest = &rest[end + "⟦E⟧".len()..];
        } else {
            parts.push(match end_idx {
                Some(end) => rest[..end].to_string(),
                None => rest.to_string(),
            });
        }
    }
    Some(parts)
}

fn pack_chunks<'a>(blocks: &[&'a Block], max_chars: usize) -> Vec<Vec<&'a Block>> {
    let mut chunks: Vec<Vec<&Block>> = Vec::new();
    let mut cur: Vec<&Block> = Vec::new();
    let mut cur_len = 0usize;
    let overhead = |n: usize| n * 12 + 20;
    for b in blocks {
        let add = b.text.chars().count() + 12;
        if !cur.is_empty() && cur_len + add + overhead(cur.len() + 1) > max_chars {
            chunks.push(std::mem::take(&mut cur));
            cur_len = 0;
        }
        cur.push(*b);
        cur_len += add;
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks
}

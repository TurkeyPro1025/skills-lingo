//! UApiPro 翻译适配器(与 Node translate/uapipro.js 对齐):4 QPS 发射间隔 + 6 并发(官方上限 7)、计费统计。

use crate::config::TranslateCfg;
use crate::util::Throttle;
use serde_json::Value;

pub struct UApiProProvider {
    pub cfg: TranslateCfg,
    throttle: Throttle,
    /// 并发闸:官方并发上限 7,取配置值(默认 6)留余量;与发射间隔节流互补
    concurrency: tokio::sync::Semaphore,
    pub stats: crate::stats::Counter,
    client: reqwest::Client,
}

#[derive(Debug)]
pub struct TranslateError {
    pub code: String,
    pub message: String,
}

impl UApiProProvider {
    pub fn new(cfg: TranslateCfg) -> Self {
        let qps = cfg.qps;
        let concurrency = cfg.concurrency;
        Self {
            cfg,
            throttle: Throttle::new((1000 / qps as u64).max(1)),
            concurrency: tokio::sync::Semaphore::new(concurrency),
            stats: crate::stats::Counter::default(),
            client: reqwest::Client::new(),
        }
    }

    pub fn configured(&self, api_key: &str) -> bool {
        !api_key.is_empty() && !self.cfg.endpoint.is_empty()
    }

    /// 翻译一段文本(≤ maxCharsPerCall 字符),返回 (译文, 积分)。
    /// target_lang 逐次传入(v1.2.0 跟随界面语言),缺省回落配置里的默认语言。
    pub async fn translate_text(
        &self,
        text: &str,
        api_key: &str,
        target_lang: Option<&str>,
    ) -> Result<(String, u64), TranslateError> {
        if text.chars().count() > self.cfg.max_chars_per_call {
            return Err(TranslateError {
                code: "too_long".into(),
                message: format!(
                    "文本超过单次上限({} > {} 字符),应由管线分块",
                    text.chars().count(),
                    self.cfg.max_chars_per_call
                ),
            });
        }
        // 发射间隔守恒(守 QPS):间隔到点即放行下一个请求,不再串行等响应;
        // 请求本体进并发闸,允许多个在途(官方并发上限 7,默认取 6)
        drop(self.throttle.acquire().await);
        let _permit = self.concurrency.acquire().await.expect("concurrency semaphore");

        let lang = target_lang.unwrap_or(&self.cfg.target_lang);
        let url = format!("{}?target_lang={}", self.cfg.endpoint, lang);
        let mut req = self.client.post(&url).header("Content-Type", "application/json");
        if !api_key.is_empty() {
            req = req.header(&self.cfg.auth_header, format!("{}{}", self.cfg.auth_prefix, api_key));
        }
        let res = req
            .json(&serde_json::json!({
                "text": text,
                "style": self.cfg.style,
                "context": self.cfg.context,
                "preserve_format": self.cfg.preserve_format,
            }))
            .timeout(std::time::Duration::from_millis(self.cfg.timeout_ms))
            .send()
            .await
            .map_err(|e| TranslateError { code: "network".into(), message: e.to_string() })?;

        self.stats.calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.stats.credits.fetch_add(self.cfg.credits_per_call, std::sync::atomic::Ordering::Relaxed);

        let status = res.status().as_u16();
        if !(200..300).contains(&status) {
            self.stats.failures.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let detail = res.text().await.unwrap_or_default();
            let detail = &detail[..detail.len().min(300)];
            return Err(TranslateError {
                code: if status == 429 { "rate_limited".into() } else { format!("http_{status}") },
                message: format!("翻译服务返回 {status}: {detail}"),
            });
        }
        let body: Value = res.json().await.map_err(|e| TranslateError {
            code: "bad_response".into(),
            message: e.to_string(),
        })?;
        match pick_response_field_ref(&body, &self.cfg.response_field) {
            Some(v) if v.is_string() => Ok((v.as_str().unwrap().to_string(), self.cfg.credits_per_call)),
            _ => Err(TranslateError {
                code: "bad_response".into(),
                message: format!("翻译服务响应缺少字段 {}", self.cfg.response_field),
            }),
        }
    }
}

fn pick_response_field_ref<'a>(obj: &'a Value, field_path: &str) -> Option<&'a Value> {
    let mut cur = obj;
    for k in field_path.split('.') {
        cur = cur.get(k)?;
    }
    Some(cur)
}

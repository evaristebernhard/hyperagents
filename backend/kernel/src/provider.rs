use crate::{Error, scheduler::Lease};
use async_trait::async_trait;
use futures_util::StreamExt;
use infinity_provider_protocol::{
    CompletionError, CompletionRequest, ErrorClass, ModelEntry, ModelProvider, ModelStream,
    StreamChunk,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use uuid::Uuid;

#[derive(Clone)]
pub struct BridgeProvider {
    pub db: PgPool,
    pub http: reqwest::Client,
    pub lease: Lease,
    pub model: String,
    pub context: Arc<Value>,
    pub paused: Arc<AtomicBool>,
}
impl BridgeProvider {
    pub async fn context(&self) -> Result<Value, Error> {
        let result = self
            .http
            .post("http://localhost/v1/context")
            .json(&self.fence())
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(result)
    }
    pub fn fence(&self) -> Value {
        json!({"protocol":1,"taskId":self.lease.id,"owner":self.lease.owner,"epoch":self.lease.epoch.to_string()})
    }
    async fn reserve(&self, request: &CompletionRequest) -> Result<(Uuid, i64), Error> {
        let estimated = serde_json::to_vec(request)?.len() as i64;
        let mut tx = self.db.begin().await?;
        crate::scheduler::dispatch(&mut tx, &self.lease).await?;
        let row = sqlx::query(
            "SELECT tokens,reserved_tokens,transfer_bytes FROM tasks WHERE id=$1 FOR UPDATE",
        )
        .bind(self.lease.root)
        .fetch_one(&mut *tx)
        .await?;
        if row.try_get::<i64, _>("transfer_bytes")? >= 64 * 1024 * 1024 {
            return Err("TRANSFER_BUDGET".into());
        }
        let available = 200000i64
            - row.try_get::<i64, _>("tokens")?
            - row.try_get::<i64, _>("reserved_tokens")?
            - estimated;
        if available < 512 {
            return Err("MODEL_BUDGET".into());
        }
        let max = available.min(
            self.context["outputTokens"]
                .as_i64()
                .unwrap_or(32768)
                .clamp(512, 32768),
        );
        let amount = estimated + max;
        let updated = sqlx::query("UPDATE tasks SET model_calls=model_calls+1,reserved_tokens=reserved_tokens+$2 WHERE id=$1 AND model_calls<32 AND tokens+reserved_tokens+$2<=200000 RETURNING id")
            .bind(self.lease.root).bind(amount).execute(&mut *tx).await?;
        if updated.rows_affected() != 1 {
            return Err("MODEL_BUDGET".into());
        }
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO model_attempts(id,task_id,root_id,reserved,status,model,lease_epoch) VALUES($1,$2,$3,$4,'running',$5,$6)")
            .bind(id).bind(self.lease.id).bind(self.lease.root).bind(amount).bind(&self.model).bind(self.lease.epoch).execute(&mut *tx).await?;
        if std::env::var("KERNEL_FAULT").ok().as_deref() == Some("slow_reservation") {
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        }
        tx.commit().await?;
        Ok((id, max))
    }
    async fn settle(
        &self,
        id: Uuid,
        usage: Option<infinity_provider_protocol::Usage>,
        bytes: i64,
        error: Option<&str>,
    ) -> Result<(), Error> {
        let mut tx = self.db.begin().await?;
        crate::scheduler::control_lock(&mut tx).await?;
        let row = sqlx::query("UPDATE model_attempts SET status=$2,usage=$3,error_code=$4,finished_at=now() WHERE id=$1 AND status='running' RETURNING reserved")
            .bind(id).bind(if usage.is_some() && error.is_none() {"completed"} else {"failed"}).bind(usage.map(|u| json!(u))).bind(error.map(crate::scheduler::failure_code)).fetch_optional(&mut *tx).await?;
        if let Some(row) = row {
            let reserved: i64 = row.try_get("reserved")?;
            let charge = usage
                .map(|u| u.total_tokens.max(u.input_tokens + u.output_tokens) as i64)
                .unwrap_or(reserved);
            let transferred:i64=sqlx::query_scalar("UPDATE tasks SET reserved_tokens=reserved_tokens-$2,tokens=tokens+$3,transfer_bytes=transfer_bytes+$4 WHERE id=$1 RETURNING transfer_bytes")
                .bind(self.lease.root).bind(reserved).bind(charge).bind(bytes).fetch_one(&mut *tx).await?;
            if transferred > 64 * 1024 * 1024 {
                tx.commit().await?;
                return Err("TRANSFER_BUDGET".into());
            }
        }
        tx.commit().await?;
        Ok(())
    }
}
#[async_trait]
impl ModelProvider for BridgeProvider {
    async fn list_models(&self) -> Result<Vec<ModelEntry>, Error> {
        Ok(vec![ModelEntry {
            model_id: self.model.clone(),
            display_name: self.model.clone(),
            context_window: 100000,
            max_output_tokens: Some(32768),
            supports_image_input: false,
        }])
    }
    async fn invoke_model(
        &self,
        _: &str,
        mut request: CompletionRequest,
    ) -> Result<ModelStream, CompletionError> {
        if self.paused.load(Ordering::Relaxed) {
            return Err(CompletionError::provider(ErrorClass::Fatal, "TASK_PAUSED"));
        }
        // Budget messages change after settlement; exclude only this advisory text
        // from the cache key. User inputs, tool definitions and history still match.
        let mut cache_request = serde_json::to_value(&request)
            .map_err(|e| CompletionError::provider(ErrorClass::Fatal, e.to_string()))?;
        cache_request.as_object_mut().unwrap().remove("max_tokens");
        if let Some(preamble) = cache_request["preamble"].as_str() {
            cache_request["preamble"] = json!(
                preamble
                    .lines()
                    .filter(|l| !l.starts_with("EXECUTION_BUDGET:"))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
        let request_key = cache_request.to_string();
        let mut gate = self
            .db
            .begin()
            .await
            .map_err(|e| CompletionError::provider(ErrorClass::Fatal, e.to_string()))?;
        crate::scheduler::dispatch(&mut gate, &self.lease)
            .await
            .map_err(|e| CompletionError::provider(ErrorClass::Fatal, e.to_string()))?;
        gate.commit()
            .await
            .map_err(|e| CompletionError::provider(ErrorClass::Fatal, e.to_string()))?;
        let cached: Option<Value> = sqlx::query_scalar(
            "SELECT chunks FROM kernel_model_results WHERE task_id=$1 AND request_hash=md5($2)",
        )
        .bind(self.lease.id)
        .bind(&request_key)
        .fetch_optional(&self.db)
        .await
        .map_err(|e| CompletionError::provider(ErrorClass::Fatal, e.to_string()))?;
        if let Some(cached) = cached {
            let chunks: Vec<StreamChunk> = serde_json::from_value(cached)
                .map_err(|e| CompletionError::provider(ErrorClass::Fatal, e.to_string()))?;
            return Ok(Box::pin(futures_util::stream::iter(
                chunks.into_iter().map(Ok),
            )));
        }
        let (id, max) = self
            .reserve(&request)
            .await
            .map_err(|e| CompletionError::provider(ErrorClass::Fatal, e.to_string()))?;
        request.max_tokens = Some(max as u64);
        let mut body = self.fence();
        body["attemptId"] = json!(id);
        body["request"] = json!(request);
        body["maxTokens"] = json!(max);
        let response = match self
            .http
            .post("http://localhost/v1/model")
            .json(&body)
            .timeout(std::time::Duration::from_secs(245))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                let body: Value = r.json().await.unwrap_or(Value::Null);
                let code = body["error"].as_str().unwrap_or("BRIDGE_REQUEST_FAILED");
                let usage = if code == "TASK_PAUSED" {
                    Some(infinity_provider_protocol::Usage {
                        input_tokens: 0,
                        output_tokens: 0,
                        total_tokens: 0,
                        cached_input_tokens: 0,
                    })
                } else {
                    None
                };
                self.settle(id, usage, 0, Some(code))
                    .await
                    .map_err(|e| CompletionError::provider(ErrorClass::Fatal, e.to_string()))?;
                return Err(CompletionError::provider(ErrorClass::Fatal, code));
            }
            other => {
                self.settle(id, None, 0, Some("BRIDGE_REQUEST_FAILED"))
                    .await
                    .map_err(|e| CompletionError::provider(ErrorClass::Fatal, e.to_string()))?;
                return Err(CompletionError::provider(
                    ErrorClass::Fatal,
                    format!("BRIDGE_REQUEST_FAILED: {:?}", other.map(|r| r.status())),
                ));
            }
        };
        let provider = self.clone();
        Ok(Box::pin(async_stream::stream! {
            let mut stream = response.bytes_stream();
            let mut chunks: Vec<Value> = Vec::new();
            let mut buffer = Vec::new(); let mut usage = None; let mut total = 0i64; let mut transported=0i64; let mut failure = None;
            'read: while let Some(part) = stream.next().await {
                let part = match part { Ok(p) => p, Err(e) => { failure=Some(e.to_string()); break; } };
                total += part.len() as i64;
                if total > 64*1024*1024 { failure=Some("TRANSFER_BUDGET".to_owned()); break; }
                buffer.extend_from_slice(&part);
                while let Some(n) = buffer.iter().position(|b|*b==b'\n') {
                    let line: Vec<_> = buffer.drain(..=n).collect();
                    let value: Value = match serde_json::from_slice(&line) { Ok(v) => v, Err(e) => { failure=Some(e.to_string()); break 'read; } };
                    if let Some(e)=value.get("error") { failure=Some(e.to_string()); break 'read; }
                    transported=transported.max(value["Final"]["transport_bytes"].as_i64().unwrap_or(0));
                    match serde_json::from_value::<StreamChunk>(value.clone()) {
                        Ok(StreamChunk::Final(final_response)) => { usage=final_response.usage; },
                        Ok(_) => chunks.push(value),
                        Err(e) => { failure=Some(e.to_string()); break 'read; }
                    }
                }
            }
            if let Err(e) = provider.settle(id, usage, total.max(transported), failure.as_deref().or(if usage.is_none() { Some("MODEL_STREAM_INTERRUPTED") } else { None })).await { failure=Some(e.to_string()); }
            if let Some(e) = failure { yield Err(CompletionError::provider(ErrorClass::Fatal,e)); }
            else if usage.is_none() { yield Err(CompletionError::provider(ErrorClass::Fatal,"MODEL_STREAM_INTERRUPTED")); }
            else {
                chunks.push(json!(StreamChunk::Final(infinity_provider_protocol::FinalResponse {usage})));
                let saved = async {
                    let mut tx = provider.db.begin().await?;
                    crate::scheduler::fence(&mut tx, &provider.lease).await?;
                    sqlx::query("INSERT INTO kernel_model_results(task_id,request_hash,chunks) VALUES($1,md5($2),$3) ON CONFLICT DO NOTHING")
                        .bind(provider.lease.id).bind(&request_key).bind(json!(chunks)).execute(&mut *tx).await?;
                    tx.commit().await?;
                    Ok::<_,Error>(())
                }.await;
                if let Err(e) = saved { yield Err(CompletionError::provider(ErrorClass::Fatal,e.to_string())); }
                else { for chunk in chunks { yield serde_json::from_value(chunk).map_err(|e| CompletionError::provider(ErrorClass::Fatal,e.to_string())); } }
            }
        }))
    }
}

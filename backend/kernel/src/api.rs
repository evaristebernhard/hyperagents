use crate::{
    Error,
    scheduler::{Lease, VERSION, fence},
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetRequest {
    protocol: u32,
    task_id: Uuid,
    owner: Uuid,
    epoch: String,
    attempt_id: Uuid,
    amount: Option<i64>,
    model: Option<String>,
    usage: Option<Usage>,
    error_code: Option<String>,
}
#[derive(Deserialize)]
struct Usage {
    input: i64,
    output: i64,
}
fn failure(error: Error) -> (StatusCode, Json<Value>) {
    let code = if error.to_string().contains("LEASE_LOST") {
        "LEASE_LOST"
    } else if error.to_string().contains("BUDGET") {
        "MODEL_BUDGET"
    } else {
        "KERNEL_BUDGET_ERROR"
    };
    (StatusCode::CONFLICT, Json(json!({"error":code})))
}
pub fn router(db: PgPool) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/budget/reserve", post(reserve))
        .route("/v1/budget/settle", post(settle))
        .layer(axum::extract::DefaultBodyLimit::max(8192))
        .with_state(db)
}
async fn health(State(db): State<PgPool>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result=async {
        let row=sqlx::query("SELECT count(*) FILTER(WHERE runtime_kind='rust' AND state='queued') AS backlog,count(*) FILTER(WHERE runtime_kind='rust' AND state='running' AND runtime_phase='model') AS active,count(*) FILTER(WHERE runtime_kind='rust' AND state LIKE 'waiting_%') AS sleeping,count(*) FILTER(WHERE state='uncertain') AS uncertain FROM tasks").fetch_one(&db).await?;
        let metrics=sqlx::query("SELECT name,value FROM kernel_metrics ORDER BY name").fetch_all(&db).await?.into_iter().map(|r|(r.get::<String,_>("name"),json!(r.get::<i64,_>("value")))).collect::<serde_json::Map<_,_>>();
        Ok::<_,Error>(json!({"protocol":1,"version":VERSION,"backlog":row.get::<i64,_>("backlog"),"active":row.get::<i64,_>("active"),"sleeping":row.get::<i64,_>("sleeping"),"uncertain":row.get::<i64,_>("uncertain"),"metrics":metrics}))
    }.await;
    result.map(Json).map_err(failure)
}
async fn reserve(
    State(db): State<PgPool>,
    Json(input): Json<BudgetRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result=async {
        if input.protocol!=1 {return Err("PROTOCOL_VERSION".into());}
        let amount=input.amount.ok_or("AMOUNT_REQUIRED")?;
        if !(1..=200000).contains(&amount){return Err("MODEL_BUDGET".into());}
        let mut tx=db.begin().await?;
        let row=sqlx::query("SELECT root_id,workspace_id FROM tasks WHERE id=$1 AND runtime_kind='rust' AND runtime_phase='tools'").bind(input.task_id).fetch_one(&mut *tx).await?;
        let lease=Lease{id:input.task_id,root:row.try_get("root_id")?,workspace:row.try_get("workspace_id")?,owner:input.owner,epoch:input.epoch.parse()?,instructions:0};
        fence(&mut tx,&lease).await?;
        let previous=sqlx::query("SELECT task_id,reserved,status FROM model_attempts WHERE id=$1").bind(input.attempt_id).fetch_optional(&mut *tx).await?;
        if let Some(previous)=previous {
            if previous.get::<Uuid,_>("task_id")!=input.task_id||previous.get::<i64,_>("reserved")!=amount||previous.get::<String,_>("status")!="running" {return Err("ATTEMPT_CONFLICT".into());}
        } else {
            let updated=sqlx::query("UPDATE tasks SET model_calls=model_calls+1,reserved_tokens=reserved_tokens+$2 WHERE id=$1 AND model_calls<32 AND tokens+reserved_tokens+$2<=200000 RETURNING id").bind(lease.root).bind(amount).execute(&mut *tx).await?;
            if updated.rows_affected()!=1{return Err("MODEL_BUDGET".into());}
            sqlx::query("INSERT INTO model_attempts(id,task_id,root_id,reserved,status,model,lease_epoch) VALUES($1,$2,$3,$4,'running',$5,$6)").bind(input.attempt_id).bind(input.task_id).bind(lease.root).bind(amount).bind(input.model).bind(lease.epoch).execute(&mut *tx).await?;
        }
        tx.commit().await?;Ok::<_,Error>(json!({"reserved":amount}))
    }.await;
    result.map(Json).map_err(failure)
}
async fn settle(
    State(db): State<PgPool>,
    Json(input): Json<BudgetRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result=async {
        if input.protocol!=1 {return Err("PROTOCOL_VERSION".into());}
        let usage=input.usage.map(|u|json!({"input":u.input,"output":u.output}));
        if usage.as_ref().is_some_and(|u|u["input"].as_i64().unwrap_or(-1)<0||u["output"].as_i64().unwrap_or(-1)<0){return Err("INVALID_USAGE".into());}
        let mut tx=db.begin().await?;
        let row=sqlx::query("UPDATE model_attempts SET status=$3,usage=$4,error_code=$5,finished_at=now() WHERE id=$1 AND task_id=$2 AND status='running' RETURNING root_id,reserved")
            .bind(input.attempt_id).bind(input.task_id).bind(if usage.is_some()&&input.error_code.is_none(){"completed"}else{"failed"}).bind(&usage).bind(input.error_code).fetch_optional(&mut *tx).await?;
        if let Some(row)=row {
            let root:Uuid=row.try_get("root_id")?;let reserved:i64=row.try_get("reserved")?;
            let amount=usage.as_ref().map(|u|u["input"].as_i64().unwrap_or(0)+u["output"].as_i64().unwrap_or(0)).unwrap_or(reserved);
            sqlx::query("UPDATE tasks SET reserved_tokens=reserved_tokens-$2,tokens=tokens+$3 WHERE id=$1").bind(root).bind(reserved).bind(amount).execute(&mut *tx).await?;
        }
        tx.commit().await?;Ok::<_,Error>(json!({"settled":true}))
    }.await;
    result.map(Json).map_err(failure)
}

use crate::{
    Error,
    provider::BridgeProvider,
    store::{DurableSleep, OutboxTool, PgStores},
};
use infinity_agent_core::{
    message::{
        InfinityMessage, InputMessage, InputMessageContent, SyntheticKind, TaggedSyntheticKind,
    },
    system::{AgentEvent, AgentSystemBuilder, EventCollector, StaticModel, StepOutcome},
    traits::ConversationStore,
};
use infinity_provider_protocol::{
    AssistantContent, ToolDefinition, ToolResult, ToolResultContent, UserContent,
};
use rap_protocol::ThreadId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::sync::atomic::Ordering;
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

pub const VERSION: &str = "infinity-1abc6fc-v1";
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lease {
    pub id: Uuid,
    pub root: Uuid,
    pub workspace: Uuid,
    pub owner: Uuid,
    pub epoch: i64,
    pub instructions: i64,
}
pub async fn fence(tx: &mut Transaction<'_, Postgres>, lease: &Lease) -> Result<(), Error> {
    let valid = sqlx::query("SELECT 1 FROM tasks WHERE id=$1 AND runtime_kind='rust' AND runtime_version=$4 AND state='running' AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>now() AND EXISTS(SELECT 1 FROM tasks root WHERE root.id=tasks.root_id AND root.state NOT IN ('cancelled','failed','succeeded','uncertain')) FOR UPDATE")
        .bind(lease.id).bind(lease.owner).bind(lease.epoch).bind(VERSION).fetch_optional(&mut **tx).await?;
    if valid.is_none() {
        return Err("LEASE_LOST".into());
    }
    Ok(())
}
pub async fn recover(db: &PgPool) -> Result<(), Error> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(730120)")
        .execute(&mut *tx)
        .await?;
    let rows = sqlx::query("UPDATE tasks SET state='queued',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE runtime_kind='rust' AND runtime_phase='model' AND state='running' AND lease_until<now() RETURNING id,root_id")
        .fetch_all(&mut *tx).await?;
    for row in rows {
        let id: Uuid = row.try_get("id")?;
        let root: Uuid = row.try_get("root_id")?;
        let charge = sqlx::query("UPDATE model_attempts SET status='failed',finished_at=now(),error_code='LEASE_EXPIRED' WHERE task_id=$1 AND status='running' RETURNING reserved")
            .bind(id).fetch_all(&mut *tx).await?.iter().map(|r| r.get::<i64,_>("reserved")).sum::<i64>();
        sqlx::query(
            "UPDATE tasks SET tokens=tokens+$2,reserved_tokens=reserved_tokens-$2 WHERE id=$1",
        )
        .bind(root)
        .bind(charge)
        .execute(&mut *tx)
        .await?;
        metric(&mut tx, "lease_lost", 1).await?;
    }
    sqlx::query("UPDATE tasks t SET state='queued',updated_at=now() WHERE t.runtime_kind='rust' AND t.runtime_phase='model' AND t.state='waiting_tool' AND t.wait_reason='kernel_timer' AND EXISTS(SELECT 1 FROM kernel_inputs i WHERE i.task_id=t.id AND i.consumed_at IS NULL AND NOT i.deferred AND i.available_at<=now())")
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn claim(db: &PgPool) -> Result<Option<Lease>, Error> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(730120)")
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT t.id,t.root_id,t.workspace_id FROM tasks t WHERE t.runtime_kind='rust' AND t.runtime_version=$1 AND t.runtime_phase='model' AND t.state='queued' AND EXISTS(SELECT 1 FROM kernel_inputs i WHERE i.task_id=t.id AND i.consumed_at IS NULL AND NOT i.deferred AND i.available_at<=now()) AND (SELECT count(*) FROM tasks WHERE runtime_kind='rust' AND runtime_phase='model' AND state='running')<4 AND (SELECT count(*) FROM tasks x WHERE x.runtime_kind='rust' AND x.runtime_phase='model' AND x.state='running' AND x.workspace_id=t.workspace_id)<2 AND (t.parent_id IS NULL OR EXISTS(SELECT 1 FROM tasks p WHERE p.id=t.parent_id AND p.state NOT IN ('failed','cancelled','succeeded','uncertain'))) ORDER BY (SELECT max(x.updated_at) FROM tasks x WHERE x.workspace_id=t.workspace_id AND x.runtime_kind='rust' AND x.lease_epoch>0) NULLS FIRST,t.updated_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1")
        .bind(VERSION).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let id: Uuid = row.try_get("id")?;
    let root: Uuid = row.try_get("root_id")?;
    let used: i64 = sqlx::query_scalar("SELECT COALESCE(sum(active_ms+CASE WHEN state='running' AND active_since IS NOT NULL THEN GREATEST(0,extract(epoch FROM (LEAST(now(),lease_until)-active_since))*1000)::bigint ELSE 0 END),0)::bigint FROM tasks WHERE root_id=$1")
        .bind(root).fetch_one(&mut *tx).await?;
    if used >= 1_200_000 {
        sqlx::query("UPDATE tasks SET state='failed',error_code='TIME_BUDGET' WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(None);
    }
    let owner = Uuid::new_v4();
    let epoch: i64=sqlx::query_scalar("UPDATE tasks SET state='running',lease_owner=$2,lease_epoch=lease_epoch+1,lease_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1 RETURNING lease_epoch")
        .bind(id).bind(owner).fetch_one(&mut *tx).await?;
    let instructions: i64 =
        sqlx::query_scalar("SELECT COALESCE(max(id),0)::bigint FROM instructions WHERE task_id=$1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    event(&mut tx, id, json!({"type":"state","state":"running"})).await?;
    tx.commit().await?;
    Ok(Some(Lease {
        id,
        root,
        workspace: row.try_get("workspace_id")?,
        owner,
        epoch,
        instructions,
    }))
}
pub async fn heartbeat(db: &PgPool, lease: &Lease) -> Result<(), Error> {
    let used: i64 = sqlx::query_scalar("SELECT COALESCE(sum(active_ms+CASE WHEN state='running' AND active_since IS NOT NULL THEN GREATEST(0,extract(epoch FROM (LEAST(now(),lease_until)-active_since))*1000)::bigint ELSE 0 END),0)::bigint FROM tasks WHERE root_id=$1").bind(lease.root).fetch_one(db).await?;
    if used >= 1_200_000 {
        return Err("TIME_BUDGET".into());
    }
    let q=sqlx::query("UPDATE tasks SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND state='running' AND lease_until>now()")
        .bind(lease.id).bind(lease.owner).bind(lease.epoch).execute(db).await?;
    if q.rows_affected() != 1 {
        return Err("LEASE_LOST".into());
    }
    Ok(())
}
fn tool_input(id: &ThreadId<str>, call: &str, result: Value) -> InputMessage {
    InputMessage {
        group_id: id.to_owned(),
        content: InputMessageContent::User(UserContent::ToolResult(ToolResult {
            id: call.to_owned(),
            call_id: None,
            content: vec![ToolResultContent::text(result.to_string())],
        })),
        metadata: None,
        synthetic: None,
        display_as: None,
        subscription: false,
    }
}
pub async fn run(db: PgPool, http: reqwest::Client, lease: Lease) -> Result<(), Error> {
    let outcome = {
        let result = run_guarded(db.clone(), http, lease.clone());
        tokio::pin!(result);
        let watchdog = async {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tick.tick().await;
                if let Err(error) = heartbeat(&db, &lease).await {
                    return error;
                }
            }
        };
        // Both futures stay polled. Awaiting heartbeat inside a select branch can
        // deadlock on the slice's own short transaction while that slice is suspended.
        tokio::select! {
            outcome=&mut result=>outcome,
            error=watchdog=>Err(error),
            _=tokio::time::sleep(Duration::from_secs(260))=>Err("MODEL_TIMEOUT".into()),
        }
    };
    if let Err(error) = &outcome {
        let mut settlement = db.begin().await?;
        let reserved=sqlx::query("UPDATE model_attempts SET status='failed',finished_at=now(),error_code='SLICE_ABORTED' WHERE task_id=$1 AND lease_epoch=$2 AND status='running' RETURNING reserved")
            .bind(lease.id).bind(lease.epoch).fetch_all(&mut *settlement).await?.iter().map(|r|r.get::<i64,_>("reserved")).sum::<i64>();
        if reserved > 0 {
            sqlx::query(
                "UPDATE tasks SET tokens=tokens+$2,reserved_tokens=reserved_tokens-$2 WHERE id=$1",
            )
            .bind(lease.root)
            .bind(reserved)
            .execute(&mut *settlement)
            .await?;
        }
        settlement.commit().await?;

        let code = if error.to_string().contains("LEASE_LOST") {
            "LEASE_LOST"
        } else if error.to_string().contains("BUDGET") {
            "MODEL_BUDGET"
        } else {
            "KERNEL_SLICE_FAILED"
        };
        if code != "LEASE_LOST" {
            let mut tx = db.begin().await?;
            if fence(&mut tx, &lease).await.is_ok() {
                // Charge all abandoned reservations conservatively before releasing the lease.
                let reserved=sqlx::query("UPDATE model_attempts SET status='failed',finished_at=now(),error_code=$2 WHERE task_id=$1 AND status='running' RETURNING reserved").bind(lease.id).bind(code).fetch_all(&mut *tx).await?.iter().map(|r|r.get::<i64,_>("reserved")).sum::<i64>();
                sqlx::query("UPDATE tasks SET tokens=tokens+$2,reserved_tokens=reserved_tokens-$2 WHERE id=$1").bind(lease.root).bind(reserved).execute(&mut *tx).await?;
                sqlx::query("UPDATE tasks SET state='failed',error_code=$2,lease_owner=NULL,lease_until=NULL WHERE id=$1").bind(lease.id).bind(code).execute(&mut *tx).await?;
                event(&mut tx, lease.id, json!({"type":"error","code":code})).await?;
                event(&mut tx, lease.id, json!({"type":"state","state":"failed"})).await?;
                tx.commit().await?;
            }
        }
    }
    outcome
}
async fn run_guarded(db: PgPool, http: reqwest::Client, lease: Lease) -> Result<(), Error> {
    let store = PgStores::load(&db, lease.root).await?;
    if std::env::var("KERNEL_FAULT").ok().as_deref() == Some("dedup_write") {
        store.fail_processed.store(true, Ordering::Relaxed);
    }
    let tid = ThreadId::from(lease.id.to_string());
    let provider = BridgeProvider {
        db: db.clone(),
        http,
        lease: lease.clone(),
        model: String::new(),
        context: Arc::new(Value::Null),
    };
    let context = provider.context().await?;
    let mut provider = provider;
    provider.model = context["model"].as_str().ok_or("MODEL_MISSING")?.to_owned();
    provider.context = Arc::new(context.clone());
    let rows=sqlx::query("SELECT id,payload,deferred FROM kernel_inputs WHERE task_id=$1 AND consumed_at IS NULL AND available_at<=now() ORDER BY deferred,created_at,id LIMIT 32")
        .bind(lease.id).fetch_all(&db).await?;
    let mut input_ids = Vec::new();
    let mut inputs = Vec::new();
    let is_new = !store.conversations.thread_exists(&tid).await?;
    store.ensure_root_thread(&tid).await?;
    let initial = context["messages"].as_array().ok_or("CONTEXT_MESSAGES")?;
    if is_new {
        // Prior conversation context is durable; the current user prompt is delivered as an input.
        for (n, message) in initial.iter().enumerate() {
            if message["role"] == "system"
                || message["content"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("EXECUTION_BUDGET:")
            {
                continue;
            }
            let text = message["content"].as_str().unwrap_or_default();
            store
                .append_messages(
                    &tid,
                    vec![(
                        if message["role"] == "assistant" {
                            InfinityMessage::Assistant {
                                content: AssistantContent::text(text),
                            }
                        } else {
                            InfinityMessage::User {
                                content: UserContent::text(text),
                            }
                        },
                        format!("seed:{n}"),
                    )],
                )
                .await?;
        }
    }
    for row in rows {
        let id: String = row.try_get("id")?;
        let payload: Value = row.try_get("payload")?;
        let message = match payload["kind"].as_str() {
            Some("start") => InputMessage::user_text(
                tid.clone(),
                "Continue the task above using the available tools. Complete through finish; preserve the user's constraints.",
            ),
            Some("user") => {
                InputMessage::user_text(tid.clone(), payload["text"].as_str().ok_or("INPUT_TEXT")?)
            }
            Some("tool") => tool_input(
                &tid,
                payload["callId"].as_str().ok_or("INPUT_CALL")?,
                payload["result"].clone(),
            ),
            Some("infinity") => serde_json::from_value(payload["message"].clone())?,
            _ => return Err("INPUT_KIND".into()),
        };
        if row.try_get::<bool, _>("deferred")? {
            store
                .deferred
                .lock()
                .expect("bug: deferred mutex poisoned")
                .push((message, id.clone()));
        } else {
            inputs.push((message, id.clone()));
        }
        input_ids.push(id);
    }
    // Compress before another provider request can overflow the task's context.
    // Original inputs stay unconsumed until the compaction child commits its summary.
    let view = store.load_history_with_ancestors(&tid).await?.0;
    let is_compaction = store
        .conversations
        .thread_info(&tid)
        .is_some_and(|i| i.is_compaction);
    if !is_compaction
        && serde_json::to_vec(&view)?.len() > 80000
        && !inputs.iter().any(|(m, _)| {
            m.synthetic
                .as_ref()
                .is_some_and(SyntheticKind::is_compaction_complete)
        })
    {
        store.compacting.store(true, Ordering::Relaxed);
        inputs = vec![(
            InputMessage {
                group_id: tid.clone(),
                content: InputMessageContent::User(UserContent::text("")),
                metadata: None,
                synthetic: Some(SyntheticKind::Tagged(TaggedSyntheticKind::Compaction)),
                display_as: None,
                subscription: false,
            },
            format!("compact:{}:{}", lease.id, lease.epoch),
        )];
        input_ids.clear();
    }
    let prompt = initial
        .iter()
        .filter(|m| {
            m["role"] == "system"
                || m["content"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("EXECUTION_BUDGET:")
        })
        .filter_map(|m| m["content"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let tools: Vec<ToolDefinition> = serde_json::from_value(context["tools"].clone())?;
    let entry = infinity_provider_protocol::ModelEntry {
        model_id: provider.model.clone(),
        display_name: provider.model.clone(),
        context_window: 100000,
        max_output_tokens: Some(32768),
        supports_image_input: false,
    };
    let model = StaticModel::from_entry(Arc::new(provider), &entry);
    use infinity_agent_core::tools::{
        cancel_subscription::CancelSubscriptionTool,
        sleep::SleepUntilEventOrInputTool,
        thread::{CloseThreadTool, ReportToParentTool, SendMessageToChildTool, SpawnThreadTool},
    };
    let may_delegate = tools.iter().any(|t| t.name == "delegate");
    let mut builder = AgentSystemBuilder::new(store.clone(), store.clone(), model, store.clone())
        .without_builtin_tools()
        .extra_system_prompt(prompt)
        .tool(Box::new(DurableSleep {
            store: store.clone(),
        }))
        .tool(Box::new(SleepUntilEventOrInputTool))
        .tool(Box::new(ReportToParentTool {
            conversation_store: store.clone(),
        }))
        .tool(Box::new(CloseThreadTool::<
            _,
            infinity_agent_core::system::NoRapHttp,
        > {
            conversation_store: store.clone(),
            rap_notifier: None,
        }))
        .tool(Box::new(SendMessageToChildTool {
            conversation_store: store.clone(),
        }))
        .tool(Box::new(CancelSubscriptionTool::<
            _,
            infinity_agent_core::system::NoRapHttp,
        > {
            state_store: store.clone(),
            rap_notifier: None,
        }))
        .tools(tools.into_iter().map(|definition| {
            Box::new(OutboxTool {
                definition,
                store: store.clone(),
            }) as Box<dyn infinity_agent_core::tools::Tool<PgStores>>
        }));
    if may_delegate {
        builder = builder.tool(Box::new(SpawnThreadTool {
            conversation_store: store.clone(),
        }));
    }
    let mut system = builder.build();
    let events = EventCollector::new();
    let mut defer = store.clone();
    let outcomes = system.step(inputs, &events, &mut defer).await?;
    let events = events.take();
    if events
        .iter()
        .any(|(_, e)| matches!(e,AgentEvent::Info{text} if text.starts_with("Error:")))
    {
        return Err(format!(
            "COMPLETION_FAILED: {:?}",
            events
                .iter()
                .filter(|(_, e)| matches!(e, AgentEvent::Info { .. }))
                .collect::<Vec<_>>()
        )
        .into());
    }
    commit(&db, &lease, &store, &input_ids, &outcomes, &events).await
}
async fn metric(tx: &mut Transaction<'_, Postgres>, name: &str, n: i64) -> Result<(), Error> {
    sqlx::query("INSERT INTO kernel_metrics(name,value) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET value=kernel_metrics.value+EXCLUDED.value").bind(name).bind(n).execute(&mut **tx).await?;
    Ok(())
}
async fn event(tx: &mut Transaction<'_, Postgres>, id: Uuid, payload: Value) -> Result<(), Error> {
    sqlx::query("INSERT INTO events(task_id,payload) VALUES($1,$2)")
        .bind(id)
        .bind(payload)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
pub async fn commit(
    db: &PgPool,
    lease: &Lease,
    store: &PgStores,
    input_ids: &[String],
    outcomes: &[(ThreadId, StepOutcome)],
    events: &[(ThreadId, AgentEvent)],
) -> Result<(), Error> {
    let snapshots = store.snapshots();
    let outgoing = store
        .outgoing
        .lock()
        .expect("bug: outgoing mutex poisoned")
        .clone();
    let intents = store
        .outbox
        .lock()
        .expect("bug: outbox mutex poisoned")
        .clone();
    let deferred = store
        .deferred
        .lock()
        .expect("bug: deferred mutex poisoned")
        .clone();
    let delayed = store
        .delayed
        .lock()
        .expect("bug: delayed mutex poisoned")
        .clone();
    let mut tx = db.begin().await?;
    fence(&mut tx, lease).await?;
    let new_instruction: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM instructions WHERE task_id=$1 AND id>$2)")
            .bind(lease.id)
            .bind(lease.instructions)
            .fetch_one(&mut *tx)
            .await?;
    if new_instruction {
        sqlx::query("UPDATE tasks SET state='queued',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1").bind(lease.id).execute(&mut *tx).await?;
        metric(&mut tx, "superseded_slices", 1).await?;
        tx.commit().await?;
        return Ok(());
    }
    let step: i32 = sqlx::query_scalar(
        "UPDATE tasks SET step=step+1,instruction_cursor=$2 WHERE id=$1 RETURNING step",
    )
    .bind(lease.id)
    .bind(lease.instructions)
    .fetch_one(&mut *tx)
    .await?;
    // Materialize native Infinity children and their staged input in this transaction.
    for (id, snapshot) in &snapshots {
        let id = Uuid::parse_str(id)?;
        if id != lease.id
            && !store
                .known
                .lock()
                .expect("bug: known mutex poisoned")
                .contains(&id.to_string())
        {
            let parent = snapshot
                .info
                .parent_thread_id
                .as_ref()
                .ok_or("CHILD_PARENT_MISSING")?;
            let parent = Uuid::parse_str(parent.as_str())?;
            let child_count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM tasks WHERE parent_id=$1 AND NOT kernel_internal",
            )
            .bind(parent)
            .fetch_one(&mut *tx)
            .await?;
            if !snapshot.info.is_compaction && (parent != lease.root || child_count >= 2) {
                return Err("DELEGATION_LIMIT".into());
            }
            sqlx::query("INSERT INTO tasks(id,workspace_id,conversation_id,parent_id,root_id,prompt,acceptance,input_file_ids,state,context,runtime_kind,runtime_version,kernel_internal) SELECT $1,workspace_id,conversation_id,id,root_id,'Infinity subtask',acceptance,input_file_ids,'queued',context,'rust',runtime_version,$3 FROM tasks WHERE id=$2")
                .bind(id).bind(parent).bind(snapshot.info.is_compaction).execute(&mut *tx).await?;
            // The built-in's seeded tool result is the start event, not a second user prompt.
            sqlx::query("UPDATE kernel_inputs SET consumed_at=now() WHERE id=$1")
                .bind(format!("start:{id}"))
                .execute(&mut *tx)
                .await?;
        }
        let revision = store
            .revisions
            .lock()
            .expect("bug: revisions mutex poisoned")
            .get(&id.to_string())
            .copied()
            .unwrap_or(0);
        let updated = if revision == 0 {
            sqlx::query("INSERT INTO kernel_threads(task_id,snapshot,revision) VALUES($1,$2,1) ON CONFLICT DO NOTHING")
              .bind(id).bind(serde_json::to_value(snapshot)?).execute(&mut *tx).await?
        } else {
            sqlx::query("UPDATE kernel_threads SET snapshot=$2,revision=revision+1,updated_at=now() WHERE task_id=$1 AND revision=$3")
              .bind(id).bind(serde_json::to_value(snapshot)?).bind(revision).execute(&mut *tx).await?
        };
        if updated.rows_affected() != 1 {
            return Err("SNAPSHOT_CONFLICT".into());
        }
    }
    for id in input_ids {
        sqlx::query("UPDATE kernel_inputs SET consumed_at=now() WHERE id=$1 AND task_id=$2 AND consumed_at IS NULL").bind(id).bind(lease.id).execute(&mut *tx).await?;
    }
    for (message, id) in &deferred {
        sqlx::query(
            "UPDATE kernel_inputs SET consumed_at=NULL,deferred=true WHERE id=$1 AND task_id=$2",
        )
        .bind(id)
        .bind(lease.id)
        .execute(&mut *tx)
        .await?;
        // Newly generated deferrals also survive a restart.
        sqlx::query("INSERT INTO kernel_inputs(id,task_id,payload,deferred) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING")
            .bind(id).bind(lease.id).bind(json!({"kind":"infinity","message":message})).execute(&mut *tx).await?;
    }
    for (message, id) in &outgoing {
        let target = Uuid::parse_str(message.group_id.as_str())?;
        // Native parent/child messaging may never cross a task tree.
        let permitted:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND root_id=$2 AND state NOT IN ('failed','cancelled','succeeded','uncertain'))").bind(target).bind(lease.root).fetch_one(&mut *tx).await?;
        if !permitted {
            continue;
        }
        sqlx::query("SELECT kernel_input($1,$2,$3)")
            .bind(format!("infinity:{target}:{id}"))
            .bind(target)
            .bind(json!({"kind":"infinity","message":message}))
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE tasks SET state='queued' WHERE id=$1 AND state IN ('waiting_user','waiting_tool','waiting_children')").bind(target).execute(&mut *tx).await?;
    }
    for (message, id, delay_ms) in &delayed {
        sqlx::query("INSERT INTO kernel_inputs(id,task_id,payload,available_at) VALUES($1,$2,$3,now()+($4*interval '1 millisecond')) ON CONFLICT DO NOTHING")
            .bind(format!("delay:{}:{id}",lease.id)).bind(lease.id).bind(json!({"kind":"infinity","message":message})).bind(*delay_ms as f64).execute(&mut *tx).await?;
    }
    let mut tool_calls = 0;
    for (_, event) in events {
        if matches!(event, AgentEvent::ToolCall { .. }) {
            tool_calls += 1;
        }
    }
    // Ordinary tools retain existing TS accounting. Synchronous built-ins count here.
    let builtin_calls = (tool_calls as i64 - intents.len() as i64).max(0);
    let updated =
        sqlx::query("UPDATE tasks SET tool_calls=tool_calls+$2 WHERE id=$1 AND tool_calls+$2<=64")
            .bind(lease.root)
            .bind(builtin_calls)
            .execute(&mut *tx)
            .await?;
    if updated.rows_affected() != 1 {
        return Err("TOOL_BUDGET".into());
    }
    for (ordinal, intent) in intents.iter().enumerate() {
        let id = Uuid::parse_str(&intent.id)?;
        sqlx::query("INSERT INTO operations(id,task_id,step,call_id,name,args,status,replay,ordinal) VALUES($1,$2,$3,$4,$5,$6,'prepared',$7,$8)")
            .bind(id).bind(lease.id).bind(step).bind(&intent.call_id).bind(&intent.name).bind(&intent.args)
            .bind(if intent.name=="code_execute" || intent.name=="skill_run" {"uncertain"} else {"safe"}).bind(ordinal as i32).execute(&mut *tx).await?;
        event(
            &mut tx,
            lease.id,
            json!({"type":"tool","operationId":id,"name":intent.name,"status":"prepared"}),
        )
        .await?;
    }
    let snapshot = snapshots
        .iter()
        .find(|(id, _)| *id == lease.id.to_string())
        .map(|(_, s)| s);
    // The compatibility checkpoint is a projection, never the kernel's source of truth.
    if let Some(snapshot) = snapshot {
        let messages = ts_messages(&snapshot.messages);
        sqlx::query(
            "UPDATE tasks SET checkpoint=jsonb_build_object('messages',$2::jsonb) WHERE id=$1",
        )
        .bind(lease.id)
        .bind(json!(messages))
        .execute(&mut *tx)
        .await?;
    }
    let more_inputs:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM kernel_inputs WHERE task_id=$1 AND consumed_at IS NULL AND NOT deferred AND available_at<=now())").bind(lease.id).fetch_one(&mut *tx).await?;
    let has_outgoing = outgoing
        .iter()
        .any(|(m, _)| m.group_id.as_str() == lease.id.to_string());
    let closed = snapshot.is_some_and(|s| s.info.closed);
    let state = if closed {
        "succeeded"
    } else if store.compacting.load(Ordering::Relaxed) || !delayed.is_empty() {
        "waiting_tool"
    } else if !intents.is_empty() || has_outgoing || more_inputs {
        "queued"
    } else {
        // A text answer is not completion: enforce the existing explicit finish contract.
        let last = snapshot.and_then(|s| s.messages.last());
        if matches!(last, Some((InfinityMessage::Assistant { .. }, _))) {
            sqlx::query("SELECT kernel_input($1,$2,$3)").bind(format!("continue:{}:{step}",lease.id)).bind(lease.id)
                .bind(json!({"kind":"user","text":"Use finish to complete with actual artifact IDs, or ask_user if input is required. Text alone does not complete the task."})).execute(&mut *tx).await?;
            "queued"
        } else {
            "waiting_user"
        }
    };
    sqlx::query("UPDATE tasks SET state=$2,runtime_phase=$3,wait_reason=$4,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1")
        .bind(lease.id).bind(state).bind(if intents.is_empty(){"model"}else{"tools"}).bind(if store.compacting.load(Ordering::Relaxed) {Some("kernel_compaction")} else if !delayed.is_empty() {Some("kernel_timer")} else {None::<&str>}).execute(&mut *tx).await?;
    event(&mut tx, lease.id, json!({"type":"state","state":state})).await?;
    for (_, outcome) in outcomes {
        if let StepOutcome::Completed { usage, .. } = outcome {
            event(&mut tx,lease.id,json!({"type":"model","step":step,"model":"rust-kernel","finishReason":if intents.is_empty(){"stop"}else{"tool_calls"},"usage":{"input":usage.map(|u|u.input_tokens).unwrap_or(0),"output":usage.map(|u|u.output_tokens).unwrap_or(0)},"elapsedMs":0})).await?;
        } else {
            metric(&mut tx, "duplicate_events", 1).await?;
        }
    }
    metric(&mut tx, "slices_committed", 1).await?;
    if std::env::var("KERNEL_FAULT").ok().as_deref() == Some("before_commit") {
        std::process::exit(86);
    }
    tx.commit().await?;
    if std::env::var("KERNEL_FAULT").ok().as_deref() == Some("after_commit") {
        std::process::exit(86);
    }
    Ok(())
}
pub fn ts_messages(history: &[(InfinityMessage, String)]) -> Vec<Value> {
    let mut messages = Vec::new();
    for (m, _) in history {
        match m {
            InfinityMessage::User{content:UserContent::Text(t)}=>messages.push(json!({"role":"user","content":t.text})),
            InfinityMessage::Assistant{content:AssistantContent::Text(t)}=>messages.push(json!({"role":"assistant","content":t.text})),
            InfinityMessage::ToolCall{call,..}=>messages.push(json!({"role":"assistant","content":"","toolCalls":[{"id":call.id,"name":call.function.name,"arguments":call.function.arguments.to_string()}]})),
            InfinityMessage::ToolResult{result,..}=>messages.push(json!({"role":"tool","toolCallId":result.id,"content":result.content.iter().filter_map(|c|if let ToolResultContent::Text(t)=c{Some(t.text.as_str())}else{None}).collect::<Vec<_>>().join("\n")})),
            _=>{},
        }
    }
    messages
}

//! Per-slice PostgreSQL stores. Infinity writes a private working set, never live
//! shared state. Scheduler::commit publishes all touched snapshots and messages
//! in one fenced transaction, including synchronous built-in child creation.
use crate::Error;
use async_trait::async_trait;
use infinity_agent_core::{
    message::{InfinityMessage, InputMessage},
    stores::{
        CompactionSummary, InMemoryConversationStore, InMemoryStateStore, InMemoryStoreError,
        ThreadInfo, ThreadState,
    },
    system::{DeferQueue, UserChoice},
    traits::{ConversationStore, InputSender, SpawnContext, StateStore},
};
use rap_protocol::{ChoiceId, ThreadId, ToolCallId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub info: ThreadInfo,
    #[serde(default)]
    pub messages: Vec<(InfinityMessage, String)>,
    #[serde(default)]
    pub compactions: Vec<CompactionSummary>,
    #[serde(default)]
    pub state: ThreadState,
}
#[derive(Clone, Default)]
pub struct PgStores {
    pub conversations: InMemoryConversationStore,
    pub states: InMemoryStateStore,
    pub touched: Arc<Mutex<BTreeSet<String>>>,
    pub known: Arc<Mutex<BTreeSet<String>>>,
    pub revisions: Arc<Mutex<BTreeMap<String, i64>>>,
    pub outgoing: Arc<Mutex<Vec<(InputMessage, String)>>>,
    pub deferred: Arc<Mutex<Vec<(InputMessage, String)>>>,
    pub outbox: Arc<Mutex<Vec<Intent>>>,
    pub delayed: Arc<Mutex<Vec<(InputMessage, String, i64)>>>,
    pub compacting: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
    pub fail_processed: Arc<AtomicBool>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Intent {
    pub id: String,
    pub call_id: String,
    pub name: String,
    pub args: Value,
    pub replay: String,
}
impl PgStores {
    pub async fn load(pool: &PgPool, root: uuid::Uuid) -> Result<Self, Error> {
        let store = Self::default();
        for row in sqlx::query("SELECT k.task_id,k.snapshot,k.revision FROM kernel_threads k JOIN tasks t ON t.id=k.task_id WHERE t.root_id=$1")
            .bind(root).fetch_all(pool).await? {
            let id: uuid::Uuid = row.try_get("task_id")?;
            let snapshot: Snapshot = serde_json::from_value(row.try_get("snapshot")?)?;
            let id = ThreadId::from(id.to_string());
            store.conversations.set_thread_info(&id, snapshot.info);
            store.conversations.set_thread_messages(&id, snapshot.messages);
            store.conversations.set_thread_compaction_summaries(&id, snapshot.compactions);
            store.states.set_thread_state(&id, snapshot.state);
            store.known.lock().expect("bug: known mutex poisoned").insert(id.as_str().to_owned());
            store.revisions.lock().expect("bug: revisions mutex poisoned").insert(id.as_str().to_owned(), row.try_get("revision")?);
        }
        Ok(store)
    }
    fn touch(&self, id: &ThreadId<str>) {
        self.touched
            .lock()
            .expect("bug: touched mutex poisoned")
            .insert(id.as_str().to_owned());
    }
    pub fn snapshots(&self) -> Vec<(String, Snapshot)> {
        self.touched
            .lock()
            .expect("bug: touched mutex poisoned")
            .iter()
            .filter_map(|id| {
                let tid = ThreadId::from_ref(id);
                self.conversations.thread_info(tid).map(|info| {
                    (
                        id.clone(),
                        Snapshot {
                            info,
                            messages: self.conversations.thread_messages(tid).unwrap_or_default(),
                            compactions: self.conversations.thread_compaction_summaries(tid),
                            state: self.states.thread_state(tid),
                        },
                    )
                })
            })
            .collect()
    }
}

#[async_trait]
impl ConversationStore for PgStores {
    type Error = InMemoryStoreError;
    async fn ensure_root_thread(&self, thread_id: &ThreadId<str>) -> Result<(), Self::Error> {
        self.touch(thread_id);
        self.conversations.ensure_root_thread(thread_id).await
    }
    async fn thread_exists(&self, thread_id: &ThreadId<str>) -> Result<bool, Self::Error> {
        self.conversations.thread_exists(thread_id).await
    }
    async fn load_history_up_to(
        &self,
        session_id: &ThreadId<str>,
        start_from: Option<i64>,
        up_to: Option<i64>,
    ) -> Result<Vec<InfinityMessage>, Self::Error> {
        self.conversations
            .load_history_up_to(session_id, start_from, up_to)
            .await
    }
    async fn append_messages(
        &self,
        session_id: &ThreadId<str>,
        messages: Vec<(InfinityMessage, String)>,
    ) -> Result<(), Self::Error> {
        self.touch(session_id);
        self.conversations
            .append_messages(session_id, messages)
            .await
    }
    async fn spawn_thread(
        &self,
        parent_thread_id: &ThreadId<str>,
        spawn_tool_call_id: &ToolCallId<str>,
        is_for_subscription_event: bool,
        context: SpawnContext,
    ) -> Result<ThreadId, Self::Error> {
        let parent = self.conversations.thread_info(parent_thread_id);
        let known = self
            .known
            .lock()
            .expect("bug: known mutex poisoned")
            .clone();
        let count = known
            .iter()
            .filter(|id| {
                !self
                    .conversations
                    .thread_info(ThreadId::from_ref(id.as_str()))
                    .is_some_and(|i| i.is_compaction)
            })
            .count()
            + self
                .touched
                .lock()
                .expect("bug: touched mutex poisoned")
                .iter()
                .filter(|id| !known.contains(*id))
                .count();
        if !self.compacting.load(Ordering::Relaxed)
            && (parent
                .as_ref()
                .is_some_and(|p| p.parent_thread_id.is_some())
                || count >= 3)
        {
            return Err(InMemoryStoreError("DELEGATION_LIMIT".to_owned()));
        }
        let id = self
            .conversations
            .spawn_thread(
                parent_thread_id,
                spawn_tool_call_id,
                is_for_subscription_event,
                context,
            )
            .await?;
        self.touch(&id);
        Ok(id)
    }
    async fn is_thread_closed(&self, thread_id: &ThreadId<str>) -> Result<bool, Self::Error> {
        self.conversations.is_thread_closed(thread_id).await
    }
    async fn close_thread(&self, thread_id: &ThreadId<str>) -> Result<(), Self::Error> {
        if self
            .conversations
            .thread_info(thread_id)
            .is_some_and(|i| i.parent_thread_id.is_none())
        {
            return Err(InMemoryStoreError(
                "Use finish to validate the root task".to_owned(),
            ));
        }
        self.touch(thread_id);
        self.conversations.close_thread(thread_id).await
    }
    async fn is_subscription_event_thread(
        &self,
        thread_id: &ThreadId<str>,
    ) -> Result<bool, Self::Error> {
        self.conversations
            .is_subscription_event_thread(thread_id)
            .await
    }
    async fn is_fresh_context_thread(
        &self,
        thread_id: &ThreadId<str>,
    ) -> Result<bool, Self::Error> {
        self.conversations.is_fresh_context_thread(thread_id).await
    }
    async fn get_thread_parent_info(
        &self,
        thread_id: &ThreadId<str>,
    ) -> Result<Option<(ThreadId, ToolCallId)>, Self::Error> {
        self.conversations.get_thread_parent_info(thread_id).await
    }
    async fn get_ancestor_chain(
        &self,
        thread_id: &ThreadId<str>,
    ) -> Result<Vec<(ThreadId, i64)>, Self::Error> {
        self.conversations.get_ancestor_chain(thread_id).await
    }
    async fn mark_thread_as_compaction(
        &self,
        thread_id: &ThreadId<str>,
    ) -> Result<(), Self::Error> {
        self.touch(thread_id);
        self.conversations
            .mark_thread_as_compaction(thread_id)
            .await
    }
    async fn is_compaction_thread(&self, thread_id: &ThreadId<str>) -> Result<bool, Self::Error> {
        self.conversations.is_compaction_thread(thread_id).await
    }
    async fn get_thread_spawn_order(
        &self,
        thread_id: &ThreadId<str>,
    ) -> Result<Option<i64>, Self::Error> {
        self.conversations.get_thread_spawn_order(thread_id).await
    }
    async fn save_compaction_summary(
        &self,
        thread_id: &ThreadId<str>,
        summary: &str,
        up_to_order: i64,
    ) -> Result<(), Self::Error> {
        self.touch(thread_id);
        self.conversations
            .save_compaction_summary(thread_id, summary, up_to_order)
            .await
    }
    async fn load_latest_compaction_summary_up_to(
        &self,
        thread_id: &ThreadId<str>,
        up_to_order: Option<i64>,
    ) -> Result<Option<(String, i64)>, Self::Error> {
        self.conversations
            .load_latest_compaction_summary_up_to(thread_id, up_to_order)
            .await
    }
}

#[async_trait]
impl StateStore for PgStores {
    type Error = InMemoryStoreError;
    async fn get_processed_ids(
        &self,
        thread_id: &ThreadId<str>,
    ) -> Result<std::collections::HashSet<String>, Self::Error> {
        self.states.get_processed_ids(thread_id).await
    }
    async fn add_processed_message_ids(
        &self,
        thread_id: &ThreadId<str>,
        message_ids: Vec<String>,
    ) -> Result<(), Self::Error> {
        if self.fail_processed.load(Ordering::Relaxed) {
            return Err(InMemoryStoreError("INJECTED_DEDUP_FAILURE".to_owned()));
        }
        self.touch(thread_id);
        self.states
            .add_processed_message_ids(thread_id, message_ids)
            .await
    }
    async fn get_metadata(
        &self,
        root_thread_id: &ThreadId<str>,
    ) -> Result<Option<serde_json::Value>, Self::Error> {
        self.states.get_metadata(root_thread_id).await
    }
    async fn set_metadata(
        &self,
        root_thread_id: &ThreadId<str>,
        metadata: serde_json::Value,
    ) -> Result<(), Self::Error> {
        self.touch(root_thread_id);
        self.states.set_metadata(root_thread_id, metadata).await
    }
    async fn get_active_subscriptions(
        &self,
        thread_id: &ThreadId<str>,
    ) -> Result<Vec<ToolCallId>, Self::Error> {
        self.states.get_active_subscriptions(thread_id).await
    }
    async fn add_active_subscription(
        &self,
        thread_id: &ThreadId<str>,
        tool_call_id: &ToolCallId<str>,
    ) -> Result<(), Self::Error> {
        self.touch(thread_id);
        self.states
            .add_active_subscription(thread_id, tool_call_id)
            .await
    }
    async fn remove_active_subscription(
        &self,
        thread_id: &ThreadId<str>,
        tool_call_id: &ToolCallId<str>,
    ) -> Result<(), Self::Error> {
        self.touch(thread_id);
        self.states
            .remove_active_subscription(thread_id, tool_call_id)
            .await
    }
    async fn add_pending_user_choice(
        &self,
        thread_id: &ThreadId<str>,
        choice: UserChoice,
    ) -> Result<(), Self::Error> {
        self.touch(thread_id);
        self.states.add_pending_user_choice(thread_id, choice).await
    }
    async fn remove_pending_user_choice(
        &self,
        thread_id: &ThreadId<str>,
        choice_id: &ChoiceId<str>,
    ) -> Result<(), Self::Error> {
        self.touch(thread_id);
        self.states
            .remove_pending_user_choice(thread_id, choice_id)
            .await
    }
    async fn get_pending_user_choices(
        &self,
        thread_id: &ThreadId<str>,
    ) -> Result<Vec<UserChoice>, Self::Error> {
        self.states.get_pending_user_choices(thread_id).await
    }
}
#[async_trait]
impl InputSender for PgStores {
    type Error = InMemoryStoreError;
    async fn send_to_input_queue(
        &self,
        message: InputMessage,
        dedup_id: &str,
    ) -> Result<(), Self::Error> {
        self.outgoing
            .lock()
            .expect("bug: outgoing mutex poisoned")
            .push((message, dedup_id.to_owned()));
        Ok(())
    }
}
#[async_trait(?Send)]
impl DeferQueue for PgStores {
    async fn push(&mut self, input: InputMessage, id: String) -> Result<bool, Error> {
        self.deferred
            .lock()
            .expect("bug: deferred mutex poisoned")
            .push((input, id));
        Ok(true)
    }
    async fn drain(&mut self) -> Result<Vec<(InputMessage, String)>, Error> {
        Ok(std::mem::take(
            &mut *self.deferred.lock().expect("bug: deferred mutex poisoned"),
        ))
    }
}
pub struct OutboxTool {
    pub replay: String,
    pub definition: infinity_provider_protocol::ToolDefinition,
    pub store: PgStores,
}
#[async_trait]
impl infinity_agent_core::tools::Tool<PgStores> for OutboxTool {
    fn name(&self) -> &str {
        &self.definition.name
    }
    fn description(&self) -> &str {
        &self.definition.description
    }
    fn parameters(&self) -> Value {
        self.definition.parameters.clone()
    }
    async fn execute(
        &self,
        args: Value,
        id: ToolCallId,
        _call_id: Option<rap_protocol::ProviderCallId>,
        _context: &infinity_agent_core::tools::ToolContext<PgStores>,
    ) -> Result<(), Error> {
        self.store
            .outbox
            .lock()
            .expect("bug: outbox mutex poisoned")
            .push(Intent {
                id: uuid::Uuid::new_v4().to_string(),
                call_id: id.as_str().to_owned(),
                name: self.definition.name.clone(),
                replay: self.replay.clone(),
                args,
            });
        Ok(())
    }
}

pub struct DurableSleep {
    pub store: PgStores,
}
#[async_trait]
impl infinity_agent_core::tools::Tool<PgStores> for DurableSleep {
    fn name(&self) -> &str {
        "sleep"
    }
    fn description(&self) -> &str {
        "Wait a bounded number of seconds without retaining an execution slot. The timer survives service restarts."
    }
    fn parameters(&self) -> Value {
        serde_json::json!({"type":"object","properties":{"seconds":{"type":"number","minimum":0,"maximum":86400},"reason":{"type":"string"}},"required":["seconds"]})
    }
    fn is_passive(&self) -> bool {
        true
    }
    async fn execute(
        &self,
        args: Value,
        id: ToolCallId,
        call_id: Option<rap_protocol::ProviderCallId>,
        context: &infinity_agent_core::tools::ToolContext<PgStores>,
    ) -> Result<(), Error> {
        let seconds = args["seconds"].as_f64().ok_or("SLEEP_SECONDS_REQUIRED")?;
        if !seconds.is_finite() || !(0.0..=86400.0).contains(&seconds) {
            return Err("SLEEP_RANGE".into());
        }
        let message = InputMessage {
            group_id: context.group_id.clone(),
            content: infinity_agent_core::message::InputMessageContent::User(
                infinity_provider_protocol::UserContent::ToolResult(
                    infinity_provider_protocol::ToolResult {
                        id: id.as_str().to_owned(),
                        call_id: call_id.map(|c| c.into_inner()),
                        content: vec![infinity_provider_protocol::ToolResultContent::text(
                            format!("Slept {seconds} seconds"),
                        )],
                    },
                ),
            ),
            metadata: None,
            synthetic: None,
            display_as: None,
            subscription: false,
        };
        self.store
            .delayed
            .lock()
            .expect("bug: delayed mutex poisoned")
            .push((
                message,
                id.as_str().to_owned(),
                (seconds * 1000.0).ceil() as i64,
            ));
        Ok(())
    }
}

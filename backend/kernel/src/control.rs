//! Native tools only mutate the slice's private working set. Admission is
//! serialized with pause; a denied call discards the working set, retaining
//! completed model responses for the next slice.
use crate::{
    Error,
    scheduler::{Lease, dispatch},
    store::PgStores,
};
use async_trait::async_trait;
use infinity_agent_core::tools::{Tool, ToolContext};
use infinity_provider_protocol::{ToolResult, ToolResultContent};
use rap_protocol::{ProviderCallId, ToolCallId};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub struct ControlledTool {
    pub tool: Box<dyn Tool<PgStores>>,
    pub db: PgPool,
    pub lease: Lease,
    pub paused: Arc<AtomicBool>,
}
impl ControlledTool {
    async fn admit(&self) -> Result<(), Error> {
        let mut tx = self.db.begin().await?;
        if let Err(e) = dispatch(&mut tx, &self.lease).await {
            self.paused.store(true, Ordering::Relaxed);
            return Err(e);
        }
        tx.commit().await?;
        Ok(())
    }
}
#[async_trait]
impl Tool<PgStores> for ControlledTool {
    fn name(&self) -> &str {
        self.tool.name()
    }
    fn description(&self) -> &str {
        self.tool.description()
    }
    fn parameters(&self) -> Value {
        self.tool.parameters()
    }
    fn supports_sync(&self) -> bool {
        self.tool.supports_sync()
    }
    fn is_passive(&self) -> bool {
        self.tool.is_passive()
    }
    async fn execute(
        &self,
        args: Value,
        id: ToolCallId,
        call_id: Option<ProviderCallId>,
        context: &ToolContext<PgStores>,
    ) -> Result<(), Error> {
        self.admit().await?;
        self.tool.execute(args, id, call_id, context).await
    }
    async fn execute_synchronous(
        &self,
        args: &Value,
        id: &ToolCallId<str>,
        call_id: Option<&ProviderCallId<str>>,
        context: &ToolContext<PgStores>,
    ) -> Option<ToolResult> {
        if self.admit().await.is_err() {
            // Infinity requires Some for synchronous tools. This private result
            // is discarded with the paused slice and never enters the outbox.
            return Some(ToolResult {
                id: id.as_str().to_owned(),
                call_id: call_id.map(|c| c.as_str().to_owned()),
                content: vec![ToolResultContent::text("TASK_PAUSED")],
            });
        }
        self.tool
            .execute_synchronous(args, id, call_id, context)
            .await
    }
}

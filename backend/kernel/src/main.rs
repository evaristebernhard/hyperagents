mod api;
mod provider;
mod scheduler;
mod store;
use futures_util::{StreamExt, stream::FuturesUnordered};
use sqlx::postgres::{PgListener, PgPoolOptions};
use std::{env, path::PathBuf, time::Duration};
use tokio::net::UnixListener;
pub type Error = Box<dyn std::error::Error + Send + Sync>;
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Error> {
    let database = env::var("DATABASE_URL")?;
    let socket = PathBuf::from(env::var("KERNEL_SOCKET")?);
    let bridge = PathBuf::from(env::var("KERNEL_BRIDGE_SOCKET")?);
    let parent = socket.parent().ok_or("SOCKET_DIRECTORY_REQUIRED")?;
    tokio::fs::create_dir_all(parent).await?;
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await?;
    if tokio::fs::try_exists(&socket).await? {
        if tokio::net::UnixStream::connect(&socket).await.is_ok() {
            return Err("KERNEL_ALREADY_RUNNING".into());
        }
        let m = tokio::fs::symlink_metadata(&socket).await?;
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        if m.uid() != unsafe_uid() || !m.file_type().is_socket() {
            return Err("UNSAFE_SOCKET_PATH".into());
        }
        tokio::fs::remove_file(&socket).await?;
    }
    let listener = UnixListener::bind(&socket)?;
    tokio::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).await?;
    let db = PgPoolOptions::new()
        .max_connections(8)
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query(
                    "SELECT set_config('statement_timeout','15000',false),set_config('idle_in_transaction_session_timeout','15000',false)",
                )
                .execute(connection)
                .await?;
                Ok(())
            })
        })
        .acquire_timeout(Duration::from_secs(10))
        .connect(&database)
        .await?;
    let http = reqwest::Client::builder().unix_socket(bridge).build()?;
    // One bounded listener connection for all sleeping threads. Polling is the fallback.
    let mut notifications = PgListener::connect(&database).await?;
    notifications.listen("hyper_kernel").await?;
    let router = api::router(db.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let local = tokio::task::LocalSet::new();
    local.run_until(async {
        let mut running=FuturesUnordered::new();
        let mut timer=tokio::time::interval(Duration::from_secs(2));
        let mut stopping=false;
        let signal=tokio::signal::ctrl_c();tokio::pin!(signal);
        let mut sigterm=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        loop {
            if !stopping {
                if let Err(e)=scheduler::recover(&db).await {eprintln!("kernel recovery: {e}");}
                while running.len()<4 {
                    match scheduler::claim(&db).await {
                        Ok(Some(lease))=>{
                            let db=db.clone();let http=http.clone();
                            running.push(tokio::task::spawn_local(async move {
                                let id=lease.id;
                                if let Err(e)=scheduler::run(db,http,lease).await {eprintln!("kernel slice {id}: {e}");}
                            }));
                        },
                        Ok(None)=>break,
                        Err(e)=>{eprintln!("kernel claim: {e}");break;},
                    }
                }
            }
            if stopping&&running.is_empty(){break;}
            tokio::select!{
                _=timer.tick()=>{},
                event=notifications.recv(),if !stopping=>{if let Err(e)=event {eprintln!("kernel notifications: {e}");}},
                Some(result)=running.next(),if !running.is_empty()=>{if let Err(e)=result {eprintln!("kernel task: {e}");}},
                _=&mut signal,if !stopping=>{stopping=true;},
                _=sigterm.recv(),if !stopping=>{stopping=true;},
            }
        }
        Ok::<(),Error>(())
    }).await?;
    server.abort();
    db.close().await;
    tokio::fs::remove_file(socket).await?;
    Ok(())
}
fn unsafe_uid() -> u32 {
    // /proc is used only for socket ownership; no libc/unsafe is needed.
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self")
        .expect("/proc/self metadata is required")
        .uid()
}

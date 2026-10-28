import {DatabaseSync,backup} from 'node:sqlite';
import {randomBytes,randomUUID,scrypt as scryptCallback} from 'node:crypto';
import {promisify} from 'node:util';
import {lstatSync,realpathSync,mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Writable} from 'node:stream';
import {createInterface} from 'node:readline/promises';
import {loadLocalEnv} from './env.mjs';
const scrypt=promisify(scryptCallback);
function ownedRegular(filename,directory=false){const st=lstatSync(filename);if(st.isSymbolicLink()||(directory?!st.isDirectory():!st.isFile()))throw Error('Recovery requires real files/directories, not symlinks.');if(typeof process.getuid==='function'&&process.getuid()!==0&&st.uid!==process.getuid())throw Error('Run recovery as the account that owns this data directory.');return st;}
/** Offline-only OS-owner recovery. No HTTP endpoint, no default password, no data reset. */
export async function resetOwnerPassword({dataDir,password}){
 if(typeof password!=='string'||password.length<12||Buffer.byteLength(password)>1024)throw Error('Choose at least 12 characters and at most 1024 UTF-8 bytes.');
 ownedRegular(dataDir,true);const root=realpathSync(dataDir),filename=path.join(root,'workspace.sqlite');ownedRegular(filename);
 const db=new DatabaseSync(filename);let transaction=false;
 try{
  const versions=db.prepare('SELECT version FROM schema_version').all();if(versions.length!==1||versions[0].version!==1)throw Error('Unsupported database schema; recovery made no changes.');
  const owner=db.prepare('SELECT id FROM owner WHERE id=1').get();if(!owner)throw Error('No owner exists. Use the normal first-owner setup instead.');
  db.exec('PRAGMA busy_timeout=5000');
  const directory=path.join(root,'recovery-backups');try{ownedRegular(directory,true);}catch(e){if(e.code!=='ENOENT')throw e;mkdirSync(directory,{mode:0o700});}
  // Refuse insecure pre-existing backup permissions rather than exposing a copy of private data.
  if((lstatSync(directory).mode&0o077)!==0)throw Error('Recovery backup directory must be private (chmod 700).');
  const backupPath=path.join(directory,'before-owner-reset-'+Date.now()+'-'+randomUUID()+'.sqlite');
  // Reserve a private target before SQLite opens it; no existing backup is overwritten.
  const {open}=await import('node:fs/promises');const reserved=await open(backupPath,'wx',0o600);await reserved.close();
  await backup(db,backupPath);chmodSync(backupPath,0o600);
  const salt=randomBytes(32).toString('base64url'),digest=(await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024})).toString('hex');
  db.exec('BEGIN IMMEDIATE');transaction=true;
  const updated=db.prepare('UPDATE owner SET salt=?,digest=? WHERE id=1').run(salt,digest);if(updated.changes!==1)throw Error('Owner changed during recovery; no reset was applied.');
  const removed=db.prepare('DELETE FROM sessions').run();db.exec('COMMIT');transaction=false;
  return {backupPath,invalidatedSessions:Number(removed.changes)};
 }finally{if(transaction)db.exec('ROLLBACK');db.close();}
}
async function main(){
 if(process.argv.length!==2)throw Error('Usage: npm run reset-password (no password arguments).');
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Run password recovery in your own interactive server terminal. Passwords are never accepted as command arguments.');
 loadLocalEnv();const dataDir=path.resolve(process.env.APP_DATA_DIR||'.data');
 console.log('Local owner-password recovery. Stop the app service first.');
 console.log('Data directory: '+dataDir+'\nConversations, files, settings and integrations will be kept. A private database backup will be made; all current sign-in sessions will be invalidated.');
 let muted=false;const output=new Writable({write(chunk,_encoding,done){if(!muted)process.stdout.write(chunk);done();}});output.isTTY=true;output.columns=process.stdout.columns;
 const rl=createInterface({input:process.stdin,output,terminal:true});
 const hidden=async prompt=>{process.stdout.write(prompt);muted=true;try{return await rl.question('');}finally{muted=false;process.stdout.write('\n');}};
 try{
  if((await rl.question('Type RESET to continue: '))!=='RESET'){console.log('Cancelled. Nothing changed.');return;}
  const password=await hidden('New login password (12+ characters; hidden): '),confirmation=await hidden('Repeat new password (hidden): ');
  if(password!==confirmation)throw Error('Passwords did not match. Nothing changed.');
  const result=await resetOwnerPassword({dataDir,password});
  console.log('Owner password updated. Existing sign-in sessions invalidated: '+result.invalidatedSessions+'.');
  console.log('Private pre-reset database backup: '+result.backupPath+'\nRestart the normal app service, then sign in with the password you just chose.');
 }finally{muted=false;rl.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error instanceof Error?error.message:'Password recovery failed.');process.exitCode=1;});

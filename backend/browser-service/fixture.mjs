// Dummy public acceptance site. Never use real credentials here.
import http from "node:http";
if (process.env.BROWSER_FIXTURE !== "1")
  throw new Error("Set BROWSER_FIXTURE=1 for the disposable acceptance site");
const shell = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Browser acceptance fixture</title></head><body style="font:20px system-ui;padding:32px">${body}</body></html>`;
const seed = `<h1>Test session seeded</h1><script>localStorage.setItem('fixture-user','demo');const open=indexedDB.open('fixture',1);open.onupgradeneeded=()=>open.result.createObjectStore('identity');open.onsuccess=()=>{const t=open.result.transaction('identity','readwrite');t.objectStore('identity').put('demo','user');t.oncomplete=()=>location.href='/app';};</script>`;
http
  .createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture").pathname;
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/download") {
      res.setHeader("content-type", "text/csv");
      res.setHeader(
        "content-disposition",
        'attachment; filename="browser-fixture.csv"',
      );
      return res.end("name,value\nfixture,42\n");
    }
    if (path === "/seed") {
      res.setHeader(
        "set-cookie",
        "fixture-session=demo; HttpOnly; SameSite=Lax; Path=/",
      );
      return res.end(shell(seed));
    }
    if (path === "/expire")
      res.setHeader("set-cookie", "fixture-session=; Max-Age=0; Path=/");
    if (path === "/login" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1000) {
          res.writeHead(413);
          return res.end();
        }
      }
      const form = new URLSearchParams(body);
      if (
        form.get("password") === "demo-only" &&
        form.get("otp") === "246810" &&
        form.get("captcha") === "BLUE"
      ) {
        res.setHeader(
          "set-cookie",
          "fixture-session=demo; HttpOnly; SameSite=Lax; Path=/",
        );
        return res.end(shell(seed));
      }
      res.statusCode = 403;
      return res.end(
        shell(
          '<p>Use the displayed dummy values.</p><a href="/">Try again</a>',
        ),
      );
    }
    if (path === "/app")
      return res.end(
        shell(
          `<h1>Test workspace</h1><p id="state">Checking persistent storage…</p><label>Search <input aria-label="Search" id="search"></label><button onclick="document.getElementById('result').textContent='Search: '+document.getElementById('search').value">Search</button><p id="result"></p><select aria-label="Category"><option>All</option><option>Reports</option></select><p><button onclick="alert('Fixture dialog')">Open dialog</button> <a href="/app" target="_blank">Open tab</a> <a href="/download">Download CSV</a></p><input aria-label="Upload fixture" type="file" onchange="document.getElementById('uploaded').textContent=this.files[0]?.name"><p id="uploaded"></p><p><a href="/expire">Expire session</a></p><script>const cookie=${JSON.stringify((req.headers.cookie || "").includes("fixture-session=demo"))},local=localStorage.getItem('fixture-user')==='demo',o=indexedDB.open('fixture',1);o.onupgradeneeded=()=>o.result.createObjectStore('identity');o.onsuccess=()=>{const q=o.result.transaction('identity').objectStore('identity').get('user');q.onsuccess=()=>document.getElementById('state').textContent='cookie='+cookie+' localStorage='+local+' indexedDB='+(q.result==='demo');};</script>`,
        ),
      );
    res.end(
      shell(
        `<h1>Dummy sign-in</h1><p>For acceptance only: password demo-only; verification code 246810; CAPTCHA BLUE. These are not real credentials.</p><form method="post" action="/login"><label>Password <input type="password" name="password"></label><label>Verification code <input name="otp" autocomplete="one-time-code"></label><label>Type BLUE <input name="captcha"></label><button>Sign in</button></form>`,
      ),
    );
  })
  .listen(Number(process.env.PORT || 8090), "0.0.0.0");

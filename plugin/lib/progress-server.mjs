import http from 'node:http';
import { readFile } from 'node:fs/promises';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const resultPath = arg('result');
const port = Number(arg('port', '0'));

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness 更新进度</title>
<style>
:root{color-scheme:dark;font-family:system-ui,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#eef2ff}
.card{width:min(520px,92vw);background:#141b31;border:1px solid #2a3658;border-radius:16px;padding:26px 28px;box-shadow:0 24px 80px #0008}
h1{font-size:19px;margin:0 0 6px}.sub{color:#93a4c8;font-size:13px;margin:0 0 20px}
.badge{display:inline-block;padding:4px 10px;border-radius:999px;background:#25365f;color:#bcd0ff;font-size:12px;margin-bottom:14px}
.msg{font-size:15px;line-height:1.6;min-height:48px;margin:0 0 18px}
.track{height:10px;background:#0a1022;border-radius:999px;overflow:hidden;border:1px solid #263252}
.bar{height:100%;width:0;background:linear-gradient(90deg,#4f7cff,#7aa2ff);transition:width .35s}
.bar.indeterminate{width:38%;animation:move 1.2s ease-in-out infinite}
@keyframes move{0%{margin-left:-38%}100%{margin-left:100%}}
.meta{display:flex;justify-content:space-between;color:#8293b8;font-size:12px;margin-top:10px}
.terminal .badge{background:#153d2a;color:#8ff0bd}.terminal .bar{background:#35d07f}
.failed .badge{background:#4a2028;color:#ffb4c0}.failed .bar{background:#ff6b81}
.note{color:#6f80a6;font-size:12px;margin-top:18px;line-height:1.6}
</style></head><body><main class="card" id="card">
<div class="badge" id="badge">准备中</div><h1>DeepSeek Harness 更新</h1>
<p class="sub">更新期间 Desktop 会关闭，这个窗口会持续显示进度。</p>
<p class="msg" id="message">正在读取更新状态…</p>
<div class="track"><div class="bar indeterminate" id="bar"></div></div>
<div class="meta"><span id="percent"></span><span id="elapsed"></span></div>
<p class="note" id="note">请勿关闭此窗口，直到看到“更新完成”或“更新失败”。</p>
</main><script>
const stages={preparing:'准备更新',downloading:'下载安装包',starting:'启动更新',closing:'关闭 Desktop',installing:'安装核心',updating:'更新插件',verifying:'启动并验证',succeeded:'更新完成',failed:'更新失败','rolled-back':'已回滚','rolling-back':'正在回滚'};
const terminal=new Set(['succeeded','failed','rolled-back']);
let started=Date.now(),runStart=null;
function fmt(n){return n>0?(n/1024/1024).toFixed(1)+' MB':''}
async function tick(){
 try{
  const r=await fetch('/state',{cache:'no-store'}); if(!r.ok) throw new Error();
  const s=await r.json();
  if(s.startedAt&&!runStart)runStart=Date.parse(s.startedAt);
  const state=s.state||'preparing';
  document.getElementById('badge').textContent=stages[state]||state;
  document.getElementById('message').textContent=s.message||stages[state]||'正在更新…';
  const bar=document.getElementById('bar');
  if(typeof s.percent==='number'&&s.percent>=0){bar.classList.remove('indeterminate');bar.style.width=Math.min(100,s.percent)+'%';document.getElementById('percent').textContent=Math.round(s.percent)+'%'+(s.total?' · '+fmt(s.total):'')}
  else {bar.classList.add('indeterminate');document.getElementById('percent').textContent=s.received?fmt(s.received):''}
  const pct=(runStart?Date.now()-runStart:0)/1000;
  document.getElementById('elapsed').textContent=pct>0?Math.floor(pct/60)+':'+String(Math.floor(pct%60)).padStart(2,'0'):'';
  const card=document.getElementById('card');card.classList.toggle('terminal',state==='succeeded'||state==='rolled-back');card.classList.toggle('failed',state==='failed');
  if(terminal.has(state)){document.getElementById('note').textContent='更新流程已结束，可以关闭此窗口。';clearInterval(timer);setTimeout(()=>location.reload(),8000)}
 }catch{document.getElementById('message').textContent='进度服务已结束，请打开 DeepSeek Harness 查看结果。';clearInterval(timer)}
}
const timer=setInterval(tick,800);tick();
</script></body></html>`;

const server = http.createServer(async (request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return response.end(PAGE);
  }
  if (request.url === '/state') {
    try {
      const state = JSON.parse(await readFile(resultPath, 'utf8'));
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(state));
    } catch {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ state: 'preparing', message: '正在准备更新…' }));
    }
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`progress http://127.0.0.1:${port}/`);
});
setTimeout(() => process.exit(0), 30 * 60_000).unref();

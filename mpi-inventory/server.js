// MPI Paper Inventory server. No outside packages: Node 22's built-in http and SQLite.
// Settings (Render > Environment): APP_PASSWORD (staff sign-in), SESSION_SECRET (any long random text), DATA_DIR (where the database file lives, e.g. /var/data).
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DatabaseSync}=require('node:sqlite');
const PORT=process.env.PORT||3000,PASS=process.env.APP_PASSWORD||'',SECRET=process.env.SESSION_SECRET||crypto.randomBytes(32).toString('hex');
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data');fs.mkdirSync(DATA_DIR,{recursive:true});
const db=new DatabaseSync(path.join(DATA_DIR,'inventory.db'));
db.exec(`PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS docs(col TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(col,id));`);
const COLS=new Set(['papers','rolls','dockets']);
const qAll=db.prepare('SELECT id,body FROM docs WHERE col=?'),qGet=db.prepare('SELECT body FROM docs WHERE col=? AND id=?');
const qPut=db.prepare('INSERT INTO docs(col,id,body,updated) VALUES(?,?,?,?) ON CONFLICT(col,id) DO UPDATE SET body=excluded.body,updated=excluded.updated');
const qDel=db.prepare('DELETE FROM docs WHERE col=? AND id=?');
if(!PASS)console.warn('WARNING: APP_PASSWORD is not set. Set it in Render > Environment before anyone uses the app.');

// --- sign-in cookie (signed, 180 days) ---
const sign=v=>crypto.createHmac('sha256',SECRET+'|'+PASS).update(v).digest('base64url');
const makeToken=()=>{const exp=Date.now()+180*864e5;return exp+'.'+sign(String(exp))};
function authed(req){const m=/(?:^|;\s*)mpi_session=([^;]+)/.exec(req.headers.cookie||'');if(!m||!PASS)return false;const [exp,sig]=m[1].split('.');
  if(!exp||!sig||+exp<Date.now())return false;const good=sign(exp);return sig.length===good.length&&crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(good))}
const tries=new Map();// simple brute-force brake per IP
function slowDown(ip){const t=tries.get(ip)||{n:0,at:0};if(Date.now()-t.at>15*60e3)t.n=0;t.n++;t.at=Date.now();tries.set(ip,t);return t.n>10}

// --- live updates (Server-Sent Events) ---
const clients=new Set();
function changed(col){const msg=`data: ${JSON.stringify({col,at:Date.now()})}\n\n`;for(const r of clients){try{r.write(msg)}catch(e){}}}
setInterval(()=>{for(const r of clients){try{r.write(': ping\n\n')}catch(e){}}},25e3);

const send=(res,code,obj,headers={})=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(obj===undefined?'':JSON.stringify(obj))};
function body(req){return new Promise((ok,bad)=>{let s='';req.on('data',c=>{s+=c;if(s.length>20e6){bad(new Error('too large'));req.destroy()}});req.on('end',()=>{try{ok(s?JSON.parse(s):{})}catch(e){bad(e)}})})}
const isObj=o=>o&&typeof o==='object'&&!Array.isArray(o);
const okId=id=>typeof id==='string'&&id.length>0&&id.length<=200&&/^[A-Za-z0-9_\-.~:@+]+$/.test(id);

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x'),p=url.pathname,ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  try{
    if(p==='/healthz')return send(res,200,{ok:true});
    if(p==='/api/login'&&req.method==='POST'){
      if(slowDown(ip))return send(res,429,{error:'Too many tries. Wait 15 minutes.'});
      const b=await body(req);const given=String(b.password||'');
      const a=Buffer.from(crypto.createHash('sha256').update(given).digest('hex')),e=Buffer.from(crypto.createHash('sha256').update(PASS).digest('hex'));
      if(!PASS||!crypto.timingSafeEqual(a,e))return send(res,401,{error:'Wrong password.'});
      tries.delete(ip);
      return send(res,200,{ok:true},{'Set-Cookie':`mpi_session=${makeToken()}; Path=/; Max-Age=${180*86400}; HttpOnly; SameSite=Lax${req.headers['x-forwarded-proto']==='https'?'; Secure':''}`});
    }
    if(p==='/api/logout'&&req.method==='POST')return send(res,200,{ok:true},{'Set-Cookie':'mpi_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'});
    if(p==='/api/me')return send(res,200,{signedIn:authed(req)});
    if(p.startsWith('/api/')){
      if(!authed(req))return send(res,401,{error:'Please sign in.'});
      if(p==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': hello\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return}
      if(p==='/api/import'&&req.method==='POST'){const b=await body(req);let n=0;const now=Date.now();db.exec('BEGIN');
        try{for(const col of COLS){if(!isObj(b[col]))continue;for(const [id,doc] of Object.entries(b[col])){if(okId(id)&&isObj(doc)){qPut.run(col,id,JSON.stringify(doc),now);n++}}}db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
        COLS.forEach(changed);return send(res,200,{imported:n})}
      if(p==='/api/backup'){const out={format:'mpi-paper-inventory-backup',version:1,exportedAt:new Date().toISOString()};for(const c of COLS){out[c]={};for(const r of qAll.all(c))out[c][r.id]=JSON.parse(r.body)}return send(res,200,out)}
      const m=/^\/api\/(papers|rolls|dockets)(?:\/([^/]+))?$/.exec(p);if(!m)return send(res,404,{error:'Not found'});
      const col=m[1],id=m[2]&&decodeURIComponent(m[2]);
      if(!id&&req.method==='GET')return send(res,200,qAll.all(col).map(r=>({id:r.id,data:JSON.parse(r.body)})));
      if(!okId(id))return send(res,400,{error:'Bad id'});
      if(req.method==='GET'){const r=qGet.get(col,id);return r?send(res,200,{id,data:JSON.parse(r.body)}):send(res,404,{error:'not-found'})}
      if(req.method==='PUT'){const b=await body(req);if(!isObj(b))return send(res,400,{error:'Bad body'});qPut.run(col,id,JSON.stringify(b),Date.now());changed(col);return send(res,200,{ok:true})}
      if(req.method==='PATCH'){const r=qGet.get(col,id);if(!r)return send(res,404,{error:'not-found'});const b=await body(req);const merged={...JSON.parse(r.body),...b};qPut.run(col,id,JSON.stringify(merged),Date.now());changed(col);return send(res,200,{ok:true})}
      if(req.method==='DELETE'){qDel.run(col,id);changed(col);return send(res,200,{ok:true})}
      return send(res,405,{error:'Method not allowed'});
    }
    // static files
    let f=p==='/'?'/index.html':p;f=path.normalize(f).replace(/^(\.\.[\/\\])+/,'');const fp=path.join(__dirname,'public',f);
    if(!fp.startsWith(path.join(__dirname,'public'))||!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){res.writeHead(404);return res.end('Not found')}
    const type={'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json','.png':'image/png','.webmanifest':'application/manifest+json'}[path.extname(fp)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':type,'Cache-Control':f==='/index.html'?'no-cache':'public, max-age=3600'});fs.createReadStream(fp).pipe(res);
  }catch(err){console.error(err);if(!res.headersSent)send(res,500,{error:'Server error'});else res.end()}
});
server.listen(PORT,()=>console.log('MPI Paper Inventory running on port '+PORT+', data in '+DATA_DIR));

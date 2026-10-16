import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const ID = 'kimi-work';
const BASE = 'https://agent-gw.kimi.com/coding/v1';
const MEMBER = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/';
const {version} = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const UA = 'Magpie Kimi Work provider/' + version;
const expired = () => Object.assign(Error('请先在本机 Kimi 桌面版登录 Work，再重新连接 Kimi Work 供应商。'), {signIn:'expired'});
const percent = x => typeof x === 'number' && Number.isFinite(x) ? Math.max(0,Math.min(100,x*100)) : undefined;

function desktopFile({home=os.homedir(), platform=process.platform, appdata=process.env.APPDATA}={}) {
  const parent=platform==='win32' ? appdata || path.join(home,'AppData','Roaming')
    : platform==='darwin' ? path.join(home,'Library','Application Support') : path.join(home,'.config');
  return path.join(parent,'kimi-desktop','daimon-share','daimon','config.json');
}

// Read the live Work sign-in, including after rotation. Never consume its
// refresh token or write the desktop app's configuration. The internal field
// is called kimiCode, but this credential is issued for agent-gw (Work).
function readDesktop(file=desktopFile()) {
  try {
    const st=fs.statSync(file);
    if(!st.isFile() || st.size>8*1024*1024) throw expired();
    const doc=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
    const work=doc.credentials?.kimiCode, web=doc.credentials?.kimiWeb;
    if(typeof work?.apiKey!=='string'||!work.apiKey || typeof web?.accessToken!=='string'||!web.accessToken
      || typeof web.userId!=='string'||!web.userId || work.baseUrl?.replace(/\/$/,'')!==BASE) throw expired();
    return {workToken:work.apiKey,webToken:web.accessToken,
      uid:createHash('sha256').update('kimi-work-account\0'+web.userId).digest('hex')};
  } catch {throw expired();}
}

function modelRows(payload) {
  if(!Array.isArray(payload?.data)||payload.has_more||payload.data.length>100) throw Error('Kimi Work 模型目录暂不可用。');
  const out={};
  for(const m of payload.data) {
    if(typeof m.id!=='string'||!m.id||m.id.length>256||/[\x00-\x20/]/.test(m.id)) continue;
    const variants=Object.create(null);
    for(const x of m.reasoningEffortOptions||[]) {
      const effort=String(x.effort||'').replace(/^REASONING_EFFORT_/,'').toLowerCase();
      if(!/^[a-z][a-z0-9_-]{0,63}$/.test(effort))throw Error('Kimi Work 思考档位格式无效。');
      variants[effort]={reasoningEffort:effort};
    }
    out[m.id]={id:m.id,name:m.display_name||m.id,
      api:{id:m.id,url:BASE,npm:'@ai-sdk/openai-compatible'},
      // The server lists the plan's maximum XL context; default to standard
      // context rather than silently asking for a more expensive XL session.
      limit:{context:Math.min(Number(m.context_length)||262144,262144),output:32768},
      capabilities:{reasoning:!!m.supports_reasoning,toolcall:true,attachment:!!m.supports_image_in,
        input:{text:true,image:!!m.supports_image_in,video:false,audio:false,pdf:false},output:{text:true}},
      variants};
  }
  if(!Object.keys(out).length)throw Error('Kimi Work 模型目录为空。');
  return out;
}

function createPlugin({readSession=readDesktop,fetchImpl=globalThis.fetch}={}) {
  const current=auth=>{
    const session=readSession();
    if(auth?.source!=='kimi-work-desktop'||auth.uid!==session.uid)throw expired();
    return session;
  };
  async function jsonRequest(url,token,body,signal) {
    const response=await fetchImpl(url,{method:body===undefined?'GET':'POST',
      headers:{Authorization:'Bearer '+token,'User-Agent':UA,'Accept':'application/json',
        ...(body===undefined?{}:{'Content-Type':'application/json','Connect-Protocol-Version':'1'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal||AbortSignal.timeout(15000),redirect:'error'});
    if(response.status===401)throw expired();
    if(!response.ok)throw Error('Kimi Work 服务暂不可用（HTTP '+response.status+'）。');
    if(Number(response.headers.get('content-length')||0)>2*1024*1024)throw Error('Kimi Work 响应过大。');
    const text=await response.text();
    if(Buffer.byteLength(text)>2*1024*1024)throw Error('Kimi Work 响应过大。');
    try{return JSON.parse(text);}catch{throw Error('Kimi Work 响应格式无效。');}
  }
  return {
    config:async cfg=>{
      cfg.provider??={};
      cfg.provider[ID]??={name:'Kimi Work',npm:'@ai-sdk/openai-compatible',api:BASE,
        models:{'k3-agent':{name:'K3 · Work',limit:{context:262144,output:32768},tool_call:true,reasoning:true}}};
    },
    auth:{
      provider:ID,
      maxConcurrency:1,
      methods:[{type:'oauth',label:'使用本机 Kimi Work 登录',authorize:async()=>({
        url:'',method:'auto',instructions:'读取本机 Kimi 桌面版的 Work 登录；不会使用 Kimi Code API Key。',
        callback:async()=>{
          try{
            const s=readSession();await jsonRequest(BASE+'/models',s.workToken);
            // Only an account reference is saved in Magpie. Actual credentials
            // stay in Kimi's own file and are reread for every operation.
            return {type:'success',access:'',refresh:'',expires:0,source:'kimi-work-desktop',
              accountId:'Kimi Work (local)',uid:s.uid};
          }catch{return {type:'failed',error:'没有可用的本机 Kimi Work 登录，请先打开 Kimi 并登录 Work。'};}
        },
      })}],
      loader:async getAuth=>({
        baseURL:BASE,apiKey:'local-desktop-session',
        async fetch(input,init={}) {
          const request=input instanceof Request?new Request(input,init):null;
          const url=new URL(request?request.url:String(input));
          if(url.origin!==new URL(BASE).origin||url.pathname!=='/coding/v1/chat/completions'
            ||url.username||url.password||url.search||url.hash||(request?.method||init.method||'POST')!=='POST') {
            throw Error('Kimi Work 仅接受官方 Work 网关的模型请求。');
          }
          const s=current(await getAuth());
          const headers=new Headers(request?request.headers:init.headers);
          for(const key of ['authorization','x-api-key','cookie','host','content-length','origin'])headers.delete(key);
          headers.set('Authorization','Bearer '+s.workToken);
          headers.set('User-Agent',UA);
          headers.set('Content-Type','application/json');
          // Preserve messages, tools, stream and abort signal. There is no
          // fallback to api.kimi.com, a Code API key, or another provider.
          const options=request?{...init,body:request.body,signal:request.signal,duplex:'half'}:init;
          return fetchImpl(BASE+'/chat/completions',{...options,method:'POST',headers,redirect:'error'});
        },
      }),
      usage:async getAuth=>{
        const s=current(await getAuth());
        const j=await jsonRequest(MEMBER+'GetSubscriptionStats',s.webToken,{});
        const b=j.subscriptionBalance,used=percent(b?.amountUsedRatio);
        return {plan:'Kimi Work · 会员共享额度',windows:used===undefined?[]:[{
          name:'会员共享额度',used,
        }]};
      },
    },
    provider:{id:ID,models:async(provider,{auth}={})=>{
      if(auth?.source!=='kimi-work-desktop')return provider.models;
      const s=current(auth);return modelRows(await jsonRequest(BASE+'/models',s.workToken));
    }},
  };
}

export default async function KimiWorkProvider(){return createPlugin();}
export const _internal={createPlugin,readDesktop,desktopFile,modelRows,BASE,MEMBER,UA};

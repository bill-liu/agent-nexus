import {useState,useRef} from 'react';
import type {BotView,Snapshot} from '../../../packages/contracts/src/events.js';
export function Environment({bot,snapshot}:{bot?:BotView;snapshot?:Snapshot}){
 const requests=useRef<Record<string,string>>({});
 const [notice,setNotice]=useState(''),[submitting,setSubmitting]=useState(false);
 if(snapshot?.mode==='p1-preparation'){
  const environment=snapshot.environments?.find(e=>e.botId===bot?.id);
  const prepare=async()=>{if(!bot||!environment?.canInitialize||submitting)return;setSubmitting(true);try{await window.an.prepareEnvironment({commandId:(requests.current[`prepare:${bot.id}:${bot.version}`]??=crypto.randomUUID()),botId:bot.id,expectedVersion:bot.version});setNotice('准备请求已受理，请查看操作结果。');}catch(error){setNotice(error instanceof Error?error.message:'准备结果未知，请核对原操作。');}finally{setSubmitting(false);}};
  const cancel=async()=>{if(!bot||!environment?.preparation?.canCancel||submitting)return;setSubmitting(true);try{await window.an.cancelEnvironment({commandId:(requests.current[`cancel:${bot.id}:${bot.version}`]??=crypto.randomUUID()),botId:bot.id,expectedVersion:bot.version});setNotice('取消已受理；停止确认前不会放行新的写者。');}catch(error){setNotice(error instanceof Error?error.message:'取消结果未知，请核对原操作。');}finally{setSubmitting(false);}};
  const plan=environment?.preparation;
  return <section><h3>运行环境 · P1 准备</h3>{environment?<>
   <p role="status">{environment.liveReady?'环境与连接已核验':plan?.operationCommandId?`Podman 准备：${plan.phase}${plan.errorCode?` · ${plan.errorCode}`:''}`:environment.initialization?.completedAt?'无账号初始化已核验并清理；连接尚未授权':`等待准备：${environment.errorCode??'READINESS_REQUIRED'}`}</p>
   <dl><dt>操作 / 持久 Sandbox</dt><dd>{environment.operationId} / {environment.sandboxId} · 代际 {environment.generation}</dd><dt>实际阶段</dt><dd>{environment.stage} · 证据来源 {environment.evidenceKind}</dd>{(['environment','runner','runtime','auth'] as const).map((key,index)=><div key={key}><dt>{['环境文件','Runner','Runtime','连接授权'][index]}</dt><dd>{environment.readiness[key]?'已确认':'尚未确认'}</dd></div>)}</dl>
   {plan&&<details><summary>Podman 准备计划与授权范围</summary><p>授权状态：{plan.authorization} · 操作状态：{plan.phase}</p><p>{plan.engine?`选定引擎：${plan.engine.connection} / ${plan.engine.machine}`:'尚未选定并授权读取本机引擎。'}</p><p>计划摘要：{plan.planDigest??'尚无具名计划'}</p><ul>{plan.sources.map(source=><li key={source.name}>{source.name} {source.version} · {source.url}</li>)}</ul><p>下载量：{plan.budgets.downloadBytes===null?'待来源/摘要与制品核验；没有开始下载':`${plan.budgets.downloadBytes} bytes`}；Machine 磁盘/内存预算：待具名目标核验。{plan.budgets.containerMemoryBytes!==null&&` 容器内存上限候选 ${plan.budgets.containerMemoryBytes} bytes / ${plan.budgets.containerCPUs} CPU，尚非实测占用。`}</p><ul>{plan.steps.map(step=><li key={step.id}>{step.label}：{step.implemented?'已有代码，实际效果待检验':'尚未实现，不会执行'} · {step.authorization==='granted'?'具名范围已记录':'需另有具名授权'}</li>)}</ul><p>首次安装、Machine/管理密钥、镜像下载及资源必须具名确认；此界面不授予系统权限。现有 Home 共享或引擎变化会阻塞。</p>{plan.blockers.map(code=><p key={code}>{code}</p>)}</details>}
   <button disabled={!snapshot.available||snapshot.quitPending||!environment.canInitialize||submitting} onClick={()=>void prepare()}>无账号初始化</button>
   {plan?.canCancel&&<button disabled={submitting||!snapshot.available||snapshot.quitPending} onClick={()=>void cancel()}>取消准备</button>}
   {!environment.canInitialize&&!environment.initialization&&<p>需要具名环境操作批准；不会自动下载、安装或登录。</p>}
   {environment.initialization&&!environment.initialization.completedAt&&<p>原准备操作尚未确认完成，不自动重试；请核对该操作。</p>}
   {environment.initialization?.completedAt&&<p>这些是本次检验事实，不表示引擎、容器或 CLI 仍在线。身份、数据和队列保留。</p>}
   {notice&&<p role="status">{notice}</p>}
   <p>下载完成只代表环境文件就位。实际操作受具名授权与实时核验约束；初始化不授予模型或登录权限。</p>
  </>:<p>创建 Bot 后显示持久准备操作。</p>}</section>;
 }
 return <section><h3>运行环境 · 演示</h3><dl><dt>目标 / 持久数据</dt><dd>{bot?`Fake Sandbox ${bot.sandboxId}`:'尚未选择 Bot'} · 本机演示数据库</dd><dt>期望状态</dt><dd>长期保留身份与工作队列</dd><dt>实际环境与 Runner</dt><dd>Fake adapter；未创建真实 VM / 远程节点，真实心跳未知</dd><dt>Runtime / 授权</dt><dd>Fake Runtime v0 · 真实 CLI 未启用 · 尚未登录</dd><dt>模板与下载</dt><dd>演示模板 v0 · 未连接公共资源服务，无下载百分比</dd></dl><p>任务结束保留身份；未启用真实环境维护、迁移与升级。</p></section>;
}

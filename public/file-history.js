import {isTestFile} from './review-options.js';

// Walk oldest -> newest. Reusing a deleted path creates a different lineage.
export function buildFileHistory(commits) {
  const live=new Map(), groups=[];
  const create=(commit,file)=>{const group={id:`${commit.sha}:${file.id}`,events:[]};groups.push(group);return group;};
  for(const commit of [...commits].reverse()){
    const before=new Map(live), changes=[];
    for(const file of commit.files){
      const kind=file.status[0];
      const group=['A','C'].includes(kind)?create(commit,file):(before.get(kind==='R'?file.oldPath:file.path)||create(commit,file));
      group.events.unshift({commit,file});changes.push({kind,file,group});
    }
    for(const {kind,file} of changes)if(kind==='D'||kind==='R')live.delete(file.oldPath);
    for(const {kind,file,group} of changes)if(kind!=='D')live.set(file.path,group);
  }
  return groups;
}
export function visibleFileHistory(groups,{hidden,showHidden=false,skipTests=false,query=''}={}){
  const needle=query.trim().toLowerCase();
  return groups.flatMap(group=>{
    const events=group.events.filter(({commit,file})=>(hidden?.has(commit.sha)||false)===showHidden&&(!skipTests||!isTestFile(file.path)));
    if(!events.length)return [];
    const paths=[...new Set(events.flatMap(({file})=>[file.path,file.oldPath]))];
    if(needle&&!paths.some(name=>name.toLowerCase().includes(needle)))return [];
    return [{id:group.id,path:events[0].file.path,paths,events,deleted:events[0].file.status[0]==='D'}];
  }).sort((a,b)=>a.path.localeCompare(b.path)||a.id.localeCompare(b.id));
}

export function createFileIndexView({getContext,loadPage,openChange,onError}){
  const $=selector=>document.querySelector(selector), dialog=$('#file-index-dialog');
  let generation=0, controller, data, groups=[], selected, fileLimit=100,eventLimit=50, loading=false;
  const contextKey=c=>`${c.repository}\0${c.ref}`;
  const stop=()=>{generation++;controller?.abort();controller=null;};
  const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
  const button=(text,action)=>{const b=node('button',text);b.type='button';b.addEventListener('click',action);return b;};
  const currentRows=()=>visibleFileHistory(groups,{hidden:getContext().hidden,showHidden:getContext().showHidden,skipTests:getContext().skipTests,query:$('#index-search').value});
  async function open(event,comment){
    const ctx=getContext();
    if(!data||contextKey(ctx)!==data.contextKey||!currentRows().some(row=>row.events.includes(event)))return;
    dialog.close();
    try{await openChange(event,comment,ctx);}catch(error){onError(error.message);}
  }
  function render(){
    if(!data||loading)return;
    const ctx=getContext(),rows=currentRows(),scope=data.scope;
    $('#index-scope').textContent=`${ctx.repository} · ${scope.ref||ctx.ref} · ${scope.comparisonRef||scope.status} → ${scope.head?.slice(0,8)||'无提交'}（基准 ${scope.base?.slice(0,8)||'无'}）。完整快照 ${data.commits.length} 条主线提交；当前${ctx.showHidden?'只看隐藏项':'排除隐藏提交'}，${ctx.skipTests?'跳过 *Test 文件':'包含 Test 文件'}。提交列表搜索框不参与此索引；这里按文件路径搜索。`;
    $('#index-progress').textContent=`索引完成 · 当前 ${rows.length} 条文件历史（删除后同路径新增分开列出）。${data.commits.length?'':scope.message||'范围为空。'}`;
    const list=$('#index-files');list.replaceChildren();
    if(!rows.some(row=>row.id===selected))selected=rows[0]?.id;
    for(const row of rows.slice(0,fileLimit)){
      const b=button(`${row.path}${row.deleted?'（已删除）':''} · ${row.events.length} 次改动`,()=>{selected=row.id;eventLimit=50;render();});
      b.className='index-file';b.dataset.historyId=row.id;b.setAttribute('aria-pressed',String(row.id===selected));b.title=row.paths.join('\n');list.append(b);
    }
    if(rows.length>fileLimit)list.append(button(`显示更多文件（${fileLimit}/${rows.length}）`,()=>{fileLimit+=100;render();}));
    const history=$('#index-history');history.replaceChildren();const row=rows.find(row=>row.id===selected);
    if(!row){history.append(node('p','当前范围和过滤条件下没有文件改动。'));return;}
    history.append(node('h3',row.path),node('p',`关联路径：${row.paths.join(' → ')}`,'index-paths'));
    const comments=new Map();for(const comment of ctx.comments){const key=`${comment.sha}:${comment.fileId}`;if(!comments.has(key))comments.set(key,[]);comments.get(key).push(comment);}
    for(const event of row.events.slice(0,eventLimit)){
      const {commit,file}=event,card=node('article',undefined,'index-change');card.dataset.commitSha=commit.sha;
      const kind={A:'新增',M:'修改',D:'删除',R:'重命名',C:'复制',T:'类型变化'}[file.status[0]]||file.status;
      card.append(node('strong',`${commit.sha.slice(0,8)} · ${commit.subject}`),node('p',`${commit.author} · ${commit.date}`),node('p',`${kind} ${file.status} · ${file.binary?'二进制（无行数统计）':`+${file.additions} −${file.deletions}`}${file.oldPath!==file.path?` · ${file.oldPath} → ${file.path}`:''}`));
      card.append(button('查看此次 diff',()=>open(event)));
      const discussion=comments.get(`${commit.sha}:${file.id}`)||[];
      const details=node('details');details.append(node('summary',`${discussion.length} 条关联评论 · ${discussion.filter(c=>!c.resolved).length} 未解决`));
      for(const comment of discussion)details.append(button(`${comment.resolved?'已解决':'未解决'} · ${comment.body}`,()=>open(event,comment)));
      card.append(details);history.append(card);
    }
    if(row.events.length>eventLimit)history.append(button(`显示更多改动（${eventLimit}/${row.events.length}）`,()=>{eventLimit+=50;render();}));
  }
  async function refresh(){
    stop();loading=true;const mine=generation,ctx=getContext(),key=contextKey(ctx);controller=new AbortController();const signal=controller.signal;
    $('#index-progress').textContent='正在建立完整范围索引…';$('#index-files').replaceChildren();$('#index-history').replaceChildren();
    $('#index-scope').textContent=`${ctx.repository} · ${ctx.ref} · 读取完整审查范围，不限提交列表已加载页。`;
    try{
      let page=await loadPage({ref:ctx.ref},ctx,signal);
      const valid=()=>mine===generation&&contextKey(getContext())===key;
      if(!valid())return;
      if(data?.snapshotId===page.snapshotId&&data.contextKey===key){loading=false;render();return;}
      const commits=[];let count=0;
      while(true){
        if(!valid())return;
        commits.push(...page.commits);for(const c of page.commits)count+=c.files.length;
        if(count>100000)throw new Error('改动记录超过 100000 条，未建立完整索引；请缩小审查范围。');
        $('#index-progress').textContent=`正在索引：已扫描 ${commits.length} 条提交、${count} 条文件改动…`;
        if(page.complete)break;
        page=await loadPage({ref:ctx.ref,snapshot:page.snapshotId,offset:String(page.nextOffset)},ctx,signal);
      }
      if(!valid())return;
      data={snapshotId:page.snapshotId,scope:page.scope,commits,contextKey:key};groups=buildFileHistory(commits);loading=false;fileLimit=100;eventLimit=50;render();
    }catch(error){if(mine===generation&&error.name!=='AbortError'){loading=false;data=null;groups=[];$('#index-progress').textContent=`索引未完成：${error.message}`;}}
  }
  $('#open-file-index').addEventListener('click',()=>{dialog.showModal();refresh();});
  $('#close-file-index').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{if(!dialog.open)stop();});
  $('#refresh-file-index').addEventListener('click',refresh);
  $('#index-search').addEventListener('input',()=>{fileLimit=100;eventLimit=50;if(data)render();});
  return {invalidate(){stop();data=null;groups=[];selected=null;if(dialog.open)dialog.close();}};
}

export function createFollowupView({getContext,getScope,api,reload,onSelect}) {
  const $=s=>document.querySelector(s),dialog=$('#followup-dialog');
  let generation=0,controller,busy=false,context,comment,snapshot,request;
  const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
  const valid=mine=>mine===generation&&dialog.open&&getContext().session===context.session&&getContext().ref===context.ref&&getContext().scope===context.scope&&getContext().rangeId===context.rangeId;
  function setBusy(value){busy=value;for(const n of dialog.querySelectorAll('input,button'))n.disabled=value;$('#followup-save').disabled=value||!snapshot;}
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  document.addEventListener('keydown',e=>{if(busy&&dialog.open&&e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();}},true);
  dialog.addEventListener('close',()=>{if(dialog.open)return;generation++;controller?.abort();snapshot=null;request=null;});
  $('#followup-close').onclick=()=>{if(!busy)dialog.close();};
  $('#followup-save').onclick=async()=>{
    const mine=generation;if(busy||!snapshot||!valid(mine))return;
    const shas=[...dialog.querySelectorAll('#followup-options input:checked')].map(n=>n.value);
    const signature=JSON.stringify(shas);
    if(!request||request.signature!==signature)request={signature,body:{scope:snapshot.id,shas,revision:comment.linkRevision||0,requestId:crypto.randomUUID()}};
    setBusy(true);
    try{
      await api(`/api/comments/${comment.id}/associations`,'POST',request.body,context.session);
      if(!valid(mine))return;
      await reload();if(valid(mine))dialog.close();
    }catch(e){if(valid(mine))$('#followup-error').textContent=e.message+'。网络失败可重试；版本或范围变化请取消后重新打开。';}
    finally{setBusy(false);}
  };
  return {async open(value){
    controller?.abort();const mine=++generation;controller=new AbortController();context=getContext();comment=value;snapshot=null;request=null;
    onSelect(comment);
    const originalPath=comment.oldPath&&comment.oldPath!==comment.path?`${comment.oldPath} → ${comment.path}`:comment.path;
    const originalLocation=comment.kind==='file'?'整个文件':`${comment.side==='old'?'旧版本':'新版本'} · 第 ${comment.startLine}–${comment.endLine} 行`;
    $('#followup-original').textContent=`原始 ${comment.sha} · ${originalPath} · ${originalLocation}\n${comment.body}${comment.code?'\n\n'+comment.code:''}`;
    $('#followup-options').replaceChildren();$('#followup-error').textContent='正在读取完整审查范围…';
    const history=$('#followup-links');history.replaceChildren();
    for(const link of comment.followups||[]){
      const row=node('p',`${link.removedAt?'历史关联':'当前关联'} · ${link.sha.slice(0,8)} · ${link.createdBy==='ai'?'AI':'用户'} · ${link.createdAt}${link.removedAt?' · 替换于 '+link.removedAt:''}${link.subject?' · '+link.subject:''}`);
      if(link.evidence)row.append(node('span',' · 依据：'+link.evidence));
      if(link.path)row.append(node('span',` · ${link.oldPath&&link.oldPath!==link.path?link.oldPath+' → ':''}${link.path}${link.kind==='file'?' · 整个文件':link.startLine===undefined?'':`:${link.startLine}–${link.endLine}`}`));
      if(link.code){const quote=node('pre',link.code);row.append(quote);}
      row.dataset.sha=link.sha;history.append(row);
    }
    for(const details of dialog.querySelectorAll('details'))details.open=false;
    if(!dialog.open)dialog.showModal();setBusy(false);
    try{
      const result=await getScope(context,controller.signal);if(!valid(mine))return;snapshot=result;
      for(const row of history.children)if(!result.commits.some(c=>c.sha===row.dataset.sha))row.firstChild.nodeValue=row.firstChild.nodeValue.replace('当前关联','历史关联（不在本次范围）');
      const selected=new Set((comment.followups||[]).filter(l=>!l.removedAt).map(l=>l.sha));
      for(const commit of result.commits){
        const label=node('label',''),input=document.createElement('input');input.type='checkbox';input.value=commit.sha;input.checked=selected.has(commit.sha);
        label.append(input,node('span',`${commit.sha.slice(0,8)} · ${commit.subject}${context.hidden.has(commit.sha)?'（左侧已隐藏）':''}`));$('#followup-options').append(label);
      }
      const outside=[...selected].filter(sha=>!result.commits.some(c=>c.sha===sha)).length;
      $('#followup-error').textContent=`共 ${result.commits.length} 个提交，包含全部分页。${outside?'范围外的旧关联将在保存后转入历史。':''}`;
      setBusy(false);
    }catch(e){if(valid(mine)&&e.name!=='AbortError')$('#followup-error').textContent=e.message;}
  }};
}

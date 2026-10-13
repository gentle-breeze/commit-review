export function createFollowupView({getContext,api,reload,onError}) {
  const $=s=>document.querySelector(s), dialog=$('#followup-dialog');
  let comment,context,preview,controller,generation=0,busy=false,request;
  const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
  const button=(text,fn)=>{const b=node('button',text);b.type='button';b.onclick=fn;return b;};
  const valid=mine=>mine===generation&&getContext().session===context.session&&dialog.open;
  function invalidate(){generation++;controller?.abort();preview=null;request=null;$('#followup-save').disabled=true;$('#followup-target').textContent='请预览目标后确认关联。';}
  function setBusy(value){busy=value;for(const el of dialog.querySelectorAll('input,button'))el.disabled=value;$('#followup-save').disabled=value||!preview;}
  function showRange(){
    if(!preview)return;
    const start=Number($('#followup-start').value),end=Number($('#followup-end').value);
    const lines=preview.text.split('\n');
    $('#followup-target').textContent=lines.slice(Math.max(0,start-6),Math.min(lines.length,end+5)).map((line,i)=>`${Math.max(1,start-5)+i} ${line}`).join('\n');
    request=null;
  }
  function renderLinks(){
    const target=$('#followup-links');target.replaceChildren();
    if(!(comment.followups||[]).some(link=>!link.removedAt))target.append(node('p','尚无有效后续关联（待关联）；证据不足时可保留候选在回复中，不必强行关联。'));
    else target.append(node('p','纠正目标时，可移除错误关联，再预览并添加正确目标；原记录保留。'));
    for(const link of comment.followups||[]){
      const row=node('div',`${link.removedAt?'已移除（记录保留）':link.createdBy==='ai'?(link.confirmedAt?'AI关联 · 用户已确认 · 待复核':'AI初步关联 · 待复核'):'人工关联 · 待对照复核'} · ${link.sha.slice(0,8)} · ${link.path}:${link.startLine}–${link.endLine}`);
      if(link.evidence)row.append(node('p',`AI依据：${link.evidence}`));
      if(!link.removedAt){
        if(link.createdBy==='ai'&&!link.confirmedAt)row.append(button('确认此初步关联',()=>save({confirmId:link.id})));
        row.append(button('查看对照',()=>{fill(link);load(link);}),button('移除此关联',()=>save({removeId:link.id})));
      }
      target.append(row);
    }
  }
  function fill(link){$('#followup-ref').value=link?.sha||getContext().sha||'HEAD';$('#followup-path').value=link?.path||'';invalidate();}
  async function load(link){
    invalidate();const mine=generation;controller=new AbortController();$('#followup-error').textContent='读取中…';
    try{
      const params=new URLSearchParams({ref:$('#followup-ref').value,path:$('#followup-path').value});
      const result=await api(`/api/comments/${comment.id}/target?${params}`,'GET',undefined,context.session,controller.signal);
      if(!valid(mine))return;
      $('#followup-error').textContent=[result.message,...result.warnings,result.unavailable].filter(Boolean).join('\n');
      const candidates=$('#followup-candidates');candidates.replaceChildren();
      if(result.unavailable){
        if(link){$('#followup-target-sha').textContent=`保存的目标证据 ${link.sha} · ${link.path}:${link.startLine}–${link.endLine}`;$('#followup-target').textContent=link.code;$('#followup-error').textContent+='\n当前无法读取该 Git 对象；以下仅为确认关联时保存的片段，不能替代完整上下文。';}
        return;
      }
      preview=result;$('#followup-path').value=result.path;
      $('#followup-target-sha').textContent=`固定目标 ${result.sha} · ${result.path} · ${result.lineCount} 行（始终对照新版本）`;
      for(const item of result.candidates)candidates.append(button(`${item.startLine}–${item.endLine} · ${item.basis==='exact-text'?'文本匹配（不代表已解决）':'仅路径线索，内容不同/未匹配'}`,()=>{ $('#followup-start').value=item.startLine;$('#followup-end').value=item.endLine;showRange(); }));
      const first=link||result.candidates[0]||{startLine:1,endLine:1};
      $('#followup-start').value=first.startLine;$('#followup-end').value=first.endLine;showRange();$('#followup-save').disabled=false;
    }catch(error){if(valid(mine)&&error.name!=='AbortError'){
      $('#followup-error').textContent=error.message;
      if(link){$('#followup-target-sha').textContent=`保存的目标证据 ${link.sha} · ${link.path}:${link.startLine}–${link.endLine}`;$('#followup-target').textContent=link.code;$('#followup-error').textContent+='\n仅显示关联时保存的片段，缺少完整上下文；不要据此断言已解决。';}
    }}
  }
  async function save(removal){
    if(busy||!dialog.open||getContext().session!==context.session||(!removal&&!preview))return;
    const body=removal||{sha:preview.sha,path:preview.path,startLine:Number($('#followup-start').value),endLine:Number($('#followup-end').value)};
    const signature=JSON.stringify(body);
    if(!request||request.signature!==signature)request={signature,body:{...body,revision:comment.linkRevision||0,requestId:crypto.randomUUID()}};
    setBusy(true);
    try{
      comment=await api(`/api/comments/${comment.id}/links`,'POST',request.body,context.session);
      request=null;await reload();renderLinks();$('#followup-error').textContent='关联已保存；原始依据和解决状态未改变，请在回复中记录复核证据。';
    }catch(error){
      $('#followup-error').textContent=`${error.message}。保存结果不确定时可重试同一请求；版本冲突请关闭后重新打开。`;
      onError(error.message);
    }finally{setBusy(false);}
  }
  $('#followup-preview').onclick=()=>load();$('#followup-save').onclick=()=>save();
  $('#followup-close').onclick=()=>{if(!busy)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  document.addEventListener('keydown',event=>{if(busy&&dialog.open&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();}},true);
  dialog.addEventListener('close',()=>{if(!dialog.open)invalidate();});
  for(const key of ['ref','path'])$(`#followup-${key}`).addEventListener('input',()=>{invalidate();$('#followup-candidates').replaceChildren();$('#followup-target-sha').textContent='';});
  for(const key of ['start','end'])$(`#followup-${key}`).addEventListener('input',showRange);
  return {open(value,link){
    comment=value;context=getContext();request=null;
    $('#followup-original').textContent=`原始 ${comment.sha} · ${comment.path} · ${comment.side} ${comment.startLine}–${comment.endLine}\n\n${comment.body}\n\n${comment.code}`;
    $('#followup-error').textContent='';$('#followup-candidates').replaceChildren();$('#followup-target-sha').textContent='';
    fill(link);renderLinks();if(!dialog.open)dialog.showModal();setBusy(false);if(link)load(link);
  }};
}

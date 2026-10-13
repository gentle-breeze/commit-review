export function createReplyManagement({getContext,api,reload,onError}) {
  const $=s=>document.querySelector(s),dialog=$('#reply-edit-dialog');
  let comment,reply,session,request,generation=0,controller,writing=false,reading=false;
  const status=text=>$('#reply-edit-error').textContent=text;
  function controls(){for(const el of dialog.querySelectorAll('button,input,textarea'))el.disabled=writing||reading;$('#reply-edit-cancel').disabled=writing;$('#reply-edit-save').disabled=writing||reading||!!reply?.deletedAt;}
  function history(){
    $('#reply-edit-context').textContent=`原作者：${reply.author==='ai'?'AI':'用户'} · 创建 ${reply.createdAt} · 当前版本 ${reply.revision||0}${reply.deletedAt?' · 已删除':''}`;
    $('#reply-edit-history').textContent=(reply.history||[]).map(item=>`版本 ${item.revision} · ${item.action} · 用户 ${item.changedAt}\n${item.body}`).join('\n\n')||'尚无修改记录。';
  }
  async function change(action){
    if(writing||reading||session!==getContext().session)return;
    if(action==='delete'&&!confirm('删除这条回复？将保留记录，可恢复；评论解决状态不变。')){dialog.close();return;}
    const data={revision:reply.revision||0,...(action==='edit'?{body:$('#reply-edit-body').value}:{})};
    if(action==='edit'&&!data.body.trim()){status('回复内容不能为空。');return;}
    const signature=JSON.stringify({action,...data});
    if(!request||request.signature!==signature)request={signature,data:{...data,requestId:crypto.randomUUID()}};
    writing=true;controls();status('保存中…');
    try{
      const updated=await api(`/api/comments/${comment.id}/replies/${reply.id}${action==='restore'?'/restore':''}`,action==='edit'?'PATCH':action==='delete'?'DELETE':'POST',request.data,session);
      await reload(updated);request=null;dialog.close();
    }catch(error){status(`${error.message}。草稿保留；结果不确定可重试，版本冲突请刷新此回复后再编辑。`);onError(error.message);}
    finally{writing=false;controls();}
  }
  async function refresh(){
    const mine=++generation;controller?.abort();controller=new AbortController();reading=true;controls();status('刷新版本中…');
    try{
      const comments=await api('/api/comments','GET',undefined,session,controller.signal);
      if(mine!==generation||!dialog.open||getContext().session!==session)return;
      const next=comments.find(c=>c.id===comment.id)?.replies?.find(r=>r.id===reply.id);
      if(!next)throw new Error('回复或评论已不存在，请取消编辑');
      reply=next;request=null;$('#reply-edit-body').value=reply.body;history();status('已读取最新版本，请核对后保存。');
    }catch(error){if(mine===generation&&error.name!=='AbortError')status(error.message);}
    finally{if(mine===generation){reading=false;controls();}}
  }
  $('#reply-edit-form').onsubmit=event=>{event.preventDefault();change('edit');};
  $('#reply-edit-cancel').onclick=()=>{if(!writing)dialog.close();};$('#reply-edit-refresh').onclick=refresh;
  $('#reply-edit-body').addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();change('edit');}});
  dialog.addEventListener('cancel',event=>{if(writing)event.preventDefault();});
  document.addEventListener('keydown',event=>{if(writing&&dialog.open&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();}},true);
  dialog.addEventListener('close',()=>{if(!dialog.open){generation++;controller?.abort();reading=false;}});
  return {hasDraft:()=>writing||(dialog.open&&$('#reply-edit-body').value!==reply.body),open(c,r,action='edit'){
    if(writing)return;generation++;controller?.abort();reading=false;comment=c;reply=r;session=getContext().session;request=null;
    $('#reply-edit-body').value=reply.body;status('');history();controls();if(!dialog.open)dialog.showModal();
    if(action==='edit')$('#reply-edit-body').focus();else change(action);
  }};
}

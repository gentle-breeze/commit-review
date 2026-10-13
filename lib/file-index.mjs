import {randomBytes} from 'node:crypto';

// Each instance belongs to exactly one canonical repository session.
export class FileIndex {
  constructor(repo) { this.repo=repo; this.snapshots=new Map(); this.queue=Promise.resolve(); }
  page({ref='HEAD',snapshotId,offset=0}={}) {
    const work=this.queue.then(()=>this.readPage({ref,snapshotId,offset}));
    this.queue=work.catch(()=>{});return work;
  }
  async readPage({ref,snapshotId,offset}) {
    if(!Number.isInteger(offset)||offset<0||offset>=5000)throw new Error('索引最多覆盖 5000 条提交；请缩小审查范围。');
    const now=Date.now();
    for(const [id,s] of this.snapshots)if(now-s.touched>10*60*1000)this.snapshots.delete(id);
    let snapshot;
    if(snapshotId){
      snapshot=this.snapshots.get(snapshotId);
      if(!snapshot||snapshot.ref!==ref)throw new Error('索引快照已失效或项目/分支不匹配，请重新建立索引。');
    }else{
      if(offset!==0)throw new Error('请从索引第一页开始。');
      const scope=await this.repo.reviewScope(ref);
      const key=JSON.stringify({ref,scope});
      snapshot=[...this.snapshots.values()].find(s=>s.key===key);
      if(!snapshot){
        snapshot={id:randomBytes(16).toString('hex'),ref,key,scope,pages:new Map(),touched:now};
        if(this.snapshots.size>=3)this.snapshots.delete(this.snapshots.keys().next().value);
        this.snapshots.set(snapshot.id,snapshot);
      }
    }
    snapshot.touched=now;
    if(snapshot.pages.has(offset))return snapshot.pages.get(offset);
    const page=await this.repo.commitPage(snapshot.scope,offset,25);
    const commits=[];let changes=0;
    for(const commit of page.commits){
      const files=await this.repo.fileChanges(commit);
      if(files.length>10000)throw new Error('单次提交超过 10000 个改动文件，无法建立完整索引。');
      if(changes+files.length>10000&&commits.length)break;
      changes+=files.length;commits.push({...commit,files});
    }
    const hasMore=page.hasMore||commits.length<page.commits.length;
    const nextOffset=offset+commits.length;
    if(hasMore&&nextOffset>=5000)throw new Error('审查范围超过 5000 条提交，索引未完成；请缩小范围。');
    const result={snapshotId:snapshot.id,scope:snapshot.scope,commits,nextOffset,complete:!hasMore};
    if(snapshot.pages.size>=2)snapshot.pages.delete(snapshot.pages.keys().next().value);
    snapshot.pages.set(offset,result);return result;
  }
}

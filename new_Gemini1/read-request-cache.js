'use strict';
// Only explicitly read-only probes belong here. Epoch invalidation ensures a
// completed pre-start/pre-reconnect probe cannot populate a newer cache entry.
class ReadRequestCache{
  constructor({ttlMs=1000,limit=512,clock=Date.now}={}){this.ttlMs=ttlMs;this.limit=limit;this.clock=clock;this.entries=new Map();}
  clear(prefix){for(const[key]of this.entries)if(prefix===undefined||key.startsWith(prefix))this.entries.delete(key);}
  get(key,load){
    const now=this.clock(),cached=this.entries.get(key);if(cached&&(cached.pending||cached.expiresAt>now))return cached.promise;
    if(cached)this.entries.delete(key);
    for(const[k,value]of this.entries)if(!value.pending&&value.expiresAt<=now)this.entries.delete(k);
    // Never evict a running probe: at capacity, reject rather than create
    // unbounded concurrent work or lose coalescing for existing callers.
    if(this.entries.size>=this.limit)return Promise.reject(new Error('คิวตรวจสถานะเต็ม กรุณาลองใหม่'));
    const entry={pending:true,expiresAt:Infinity,promise:null};
    entry.promise=Promise.resolve().then(load).then(value=>{entry.pending=false;entry.expiresAt=this.clock()+this.ttlMs;return value;},error=>{if(this.entries.get(key)===entry)this.entries.delete(key);throw error;});
    this.entries.set(key,entry);return entry.promise;
  }
}
module.exports={ReadRequestCache};

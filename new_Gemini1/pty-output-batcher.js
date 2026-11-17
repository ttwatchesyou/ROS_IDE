'use strict';
class PtyOutputBatcher{
  constructor(send,{delayMs=4,maxBytes=64*1024}={}){this.send=send;this.delayMs=delayMs;this.maxBytes=maxBytes;this.pending=new Map();this.timer=null;}
  write(termId,data){
    let entry=this.pending.get(termId);if(!entry){entry={chunks:[],bytes:0};this.pending.set(termId,entry);}
    entry.chunks.push(data);entry.bytes+=Buffer.byteLength(data);
    if(entry.bytes>=this.maxBytes)this.flushTerm(termId);
    if(this.pending.size&&!this.timer){this.timer=setTimeout(()=>this.flush(),this.delayMs);this.timer.unref?.();}
  }
  flushTerm(termId){const entry=this.pending.get(termId);if(!entry)return;this.pending.delete(termId);this.send({type:'pty_output',termId,data:Buffer.from(entry.chunks.join('')).toString('base64')});if(!this.pending.size&&this.timer){clearTimeout(this.timer);this.timer=null;}}
  flush(){if(this.timer)clearTimeout(this.timer);this.timer=null;for(const id of [...this.pending.keys()])this.flushTerm(id);}
  clear(){if(this.timer)clearTimeout(this.timer);this.timer=null;this.pending.clear();}
}
module.exports={PtyOutputBatcher};

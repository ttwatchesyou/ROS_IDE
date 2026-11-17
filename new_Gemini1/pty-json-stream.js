'use strict';
const {StringDecoder}=require('node:string_decoder');
// One instance per PTY. Each arriving character is inspected once, including
// strings/escaped quotes split across WebSocket or UTF-8 boundaries.
class PtyJsonStream{
  constructor({maxBytes=16*1024*1024}={}){this.maxBytes=maxBytes;this.decoder=new StringDecoder('utf8');this.reset();}
  reset(){this.depth=0;this.inString=false;this.escaped=false;this.parts=[];this.blocks=[];this.bytes=0;}
  append(text){
    if(!text)return;
    this.bytes+=Buffer.byteLength(text,'utf8');
    if(this.bytes>this.maxBytes){this.reset();throw new Error('Telemetry frame exceeds the 16 MB limit');}
    this.parts.push(text);
    // Bound fragment bookkeeping even for streams arriving one byte at a time.
    if(this.parts.length>=4096){this.blocks.push(this.parts.join(''));this.parts=[];}
  }
  write(chunk){
    const input=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);if(input.length>this.maxBytes){this.reset();throw new Error('Telemetry frame exceeds the 16 MB limit');}
    const text=this.decoder.write(input).replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'').replace(/[\x00-\x08\x0e-\x1f\x7f]/g,'');
    const frames=[];let start=this.depth?0:-1;
    for(let index=0;index<text.length;index++){
      const character=text[index];
      if(!this.depth){if(character!=='{')continue;this.depth=1;this.inString=false;this.escaped=false;start=index;continue;}
      if(this.escaped){this.escaped=false;continue;}
      if(character==='\\'&&this.inString){this.escaped=true;continue;}
      if(character==='"'){this.inString=!this.inString;continue;}
      if(this.inString)continue;
      if(character==='{')this.depth++;
      else if(character==='}'&&--this.depth===0){this.append(text.slice(start,index+1));frames.push(this.blocks.join('')+this.parts.join(''));this.reset();start=-1;}
    }
    if(this.depth)this.append(text.slice(start));
    return frames;
  }
}
module.exports={PtyJsonStream};

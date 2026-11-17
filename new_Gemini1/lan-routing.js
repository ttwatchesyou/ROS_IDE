'use strict';
const net=require('node:net');

function ipv4(value){
  const address=String(value||'').replace(/^::ffff:/,'');
  if(net.isIP(address)!==4)return null;
  return address.split('.').map(Number);
}
function privateAddress(parts){
  return parts&&(parts[0]===10||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168));
}
function tailnetAddress(parts){return parts&&parts[0]===100&&parts[1]>=64&&parts[1]<=127;}
function sharedAddress(parts){return privateAddress(parts)||tailnetAddress(parts);}
function sameSubnet(client,entry){
  const remote=ipv4(client),local=ipv4(entry?.address),mask=ipv4(entry?.netmask);
  // An exact interface address means the browser and Agent reached Cloud from
  // the same node. Tailnet interfaces commonly have a /32 mask, so compare
  // identity before applying LAN subnet rules.
  if(remote&&local&&sharedAddress(local)&&remote.every((part,i)=>part===local[i]))return true;
  // Tailnet interfaces normally use /32, but peers can reach each other after
  // the Agent's actual ping succeeds. The route check still requires that ping.
  if(tailnetAddress(remote)&&tailnetAddress(local))return true;
  if(!privateAddress(remote)||!privateAddress(local)||!mask)return false;
  const bits=mask.map(n=>n.toString(2).padStart(8,'0')).join('');
  if(!/^1*0*$/.test(bits)||bits.indexOf('0')<8||bits.indexOf('0')>30)return false;
  return remote.every((part,i)=>(part&mask[i])===(local[i]&mask[i]));
}
function routeForClient(client,interfaces,port=3080){
  if(!Number.isInteger(port)||port<1||port>65535)return null;
  const entry=Array.isArray(interfaces)?interfaces.find(item=>sameSubnet(client,item)):null;
  return entry?`http://${entry.address}:${port}/`:null;
}
function browserAddress(peer,forwardedFor,trustLoopbackProxy=false,trustedHops=1){
  const direct=String(peer||'').replace(/^::ffff:/,'');
  if(direct!=='127.0.0.1'&&direct!=='::1')return ipv4(direct)?direct:null;
  if(!trustLoopbackProxy||!Number.isInteger(trustedHops)||trustedHops<1||trustedHops>4)return null;
  const chain=String(forwardedFor||'').split(',').map(value=>value.trim()).filter(Boolean);
  const candidate=chain[chain.length-trustedHops];
  return ipv4(candidate)?candidate:null;
}
function localCandidateUrls(interfaces,port=3080){
  if(!Array.isArray(interfaces))return[];
  const ordered=[...interfaces].sort((a,b)=>Number(tailnetAddress(ipv4(a?.address)))-Number(tailnetAddress(ipv4(b?.address))));
  return [...new Set(ordered.map(entry=>routeForClient(entry?.address,[entry],port)).filter(Boolean))];
}
module.exports={ipv4,sameSubnet,routeForClient,browserAddress,localCandidateUrls};

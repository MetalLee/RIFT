import { createServer, request, type OutgoingHttpHeaders } from 'node:http';
import { connect, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { publicSourceAddress } from '../api/upstream-source.js';
import { invariant } from '../contracts/index.js';

/** The only egress capability mounted into a network-isolated command. Never
 * expose Host loopback, DNS configuration, credentials or an unrestricted socket. */
export async function publicDestination(hostname:string,port:number):Promise<string> {
  invariant([80,443].includes(port),'NETWORK_DESTINATION','Only public HTTP(S) ports are available.');
  invariant(/^[a-zA-Z0-9.-]+$/.test(hostname)&&hostname.length<=253,'NETWORK_DESTINATION','Invalid public hostname.');
  const timeout=AbortSignal.timeout(10000);
  const results=await Promise.race([lookup(hostname,{all:true,family:4}),new Promise<never>((_,reject)=>timeout.addEventListener('abort',()=>reject(new Error('DNS timeout')),{once:true}))]);
  const own=new Set(Object.values(networkInterfaces()).flatMap(items=>items??[]).map(item=>item.address));
  invariant(results.length>0&&results.every(item=>publicSourceAddress(item.address)&&!own.has(item.address)),'NETWORK_DESTINATION','Private, local and Host addresses are not public egress destinations.');
  return results[0]!.address;
}

// Runs INSIDE bwrap. A Unix transport crosses the network namespace; the local
// TCP proxy serves conventional npm/Corepack/Git/curl clients. TLS stays end-to-end.
const bootstrap=String.raw`
const net=require('node:net'),{spawn}=require('node:child_process');
const sockets=new Set();
const server=net.createServer(client=>{
 const upstream=net.connect('/run/rift-egress/proxy.sock');
 sockets.add(client);sockets.add(upstream);
 for(const socket of [client,upstream]){socket.on('error',()=>{client.destroy();upstream.destroy()});socket.on('close',()=>sockets.delete(socket));}
 client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());client.pipe(upstream);upstream.pipe(client);
});
server.listen(0,'127.0.0.1',()=>{
 const proxy='http://127.0.0.1:'+server.address().port;
 const env={...process.env,HTTP_PROXY:proxy,HTTPS_PROXY:proxy,http_proxy:proxy,https_proxy:proxy,NO_PROXY:'localhost,127.0.0.1,::1',no_proxy:'localhost,127.0.0.1,::1',NODE_USE_ENV_PROXY:'1'};
 const child=spawn('/bin/bash',['--noprofile','--norc','-c',process.argv[2]],{stdio:'inherit',env});
 const finish=code=>{for(const socket of sockets)socket.destroy();server.close();process.exit(code);};
 child.on('error',()=>finish(127));child.on('exit',(code,signal)=>finish(code??(signal?128:1)));
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{child.kill(signal);setTimeout(()=>finish(143),1000).unref()});
});
server.on('error',error=>{console.error(error.message);process.exit(1)});
`;
export async function startSandboxEgress() {
  const directory=await mkdtemp(path.join(tmpdir(),'rift-egress-'));
  const sockets=new Set<Socket>();
  const track=(socket:Socket)=>{sockets.add(socket);socket.unref();socket.setTimeout(60000,()=>socket.destroy());socket.on('error',()=>socket.destroy());socket.on('close',()=>sockets.delete(socket));};
  const server=createServer({maxHeaderSize:16384,headersTimeout:15000,requestTimeout:300000},async(req,res)=>{
    try{
      const url=new URL(req.url??'');
      invariant(url.protocol==='http:'&&!url.username&&!url.password,'NETWORK_DESTINATION','Use HTTP URLs or HTTPS CONNECT.');
      const port=Number(url.port||80),address=await publicDestination(url.hostname,port);
      if(req.destroyed)return;
      const headers:OutgoingHttpHeaders={...req.headers,host:url.host};delete headers['proxy-authorization'];delete headers['proxy-connection'];delete headers.connection;
      const upstream=request({hostname:address,port,method:req.method,path:url.pathname+url.search,headers,agent:false},response=>{res.writeHead(response.statusCode??502,response.headers);response.pipe(res);});
      upstream.on('socket',track);upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
      res.on('close',()=>upstream.destroy());req.pipe(upstream);
    }catch{res.writeHead(403);res.end('RIFT_PUBLIC_EGRESS_ONLY');}
  });
  server.on('connection',socket=>{if(sockets.size>=256){socket.destroy();return;}track(socket);});
  server.on('connect',async(req,client,head)=>{
    const socket=client as Socket;
    try{
      invariant(/^[A-Za-z0-9.-]+:(80|443)$/.test(req.url??''),'NETWORK_DESTINATION','Invalid CONNECT destination.');
      const [hostname,port]=req.url!.split(':'),address=await publicDestination(hostname!,Number(port));
      if(socket.destroyed)return;
      const upstream=connect({host:address,port:Number(port)});track(upstream);
      upstream.on('connect',()=>{if(socket.destroyed){upstream.destroy();return;}socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
      upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
    }catch{socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 23\r\nConnection: close\r\n\r\nRIFT_PUBLIC_EGRESS_ONLY\n');}
  });
  server.on('clientError',(_error,socket)=>socket.destroy());
  try{
    await writeFile(path.join(directory,'bootstrap.cjs'),bootstrap,{mode:0o400});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path.join(directory,'proxy.sock'),()=>{server.off('error',reject);resolve();});});
    await chmod(path.join(directory,'proxy.sock'),0o600);server.unref();
  }catch(error){server.close();await rm(directory,{recursive:true,force:true});throw error;}
  const onExit=()=>rmSync(directory,{recursive:true,force:true});process.once('exit',onExit);
  return {directory,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));process.off('exit',onExit);await rm(directory,{recursive:true,force:true});}};
}
let shared:ReturnType<typeof startSandboxEgress>|undefined;
export function sandboxEgress(){return shared??=startSandboxEgress().catch(error=>{shared=undefined;throw error;});}

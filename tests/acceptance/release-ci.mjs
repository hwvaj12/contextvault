#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';

const execute=promisify(execFile),label='io.contextvault.release-ci.owner';
const environment=()=>Object.fromEntries(['PATH','HOME','LANG','LC_ALL','TMPDIR'].filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
const docker=async args=>(await execute('docker',args,{env:environment(),timeout:30000,killSignal:'SIGKILL',maxBuffer:1024*1024})).stdout.trim();
const missing=error=>/No such (?:object|container|network)|network [^\n]+ not found/i.test(error.stderr??'');
export function validateCiState(value) {
  const id=value?.identity;
  if(value?.schemaVersion!==1||typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)||value.container!=='cv-release-s3-'+id||value.network!=='cv-release-s3-'+id||value.bucket!=='cv-release-'+id||value.region!=='us-east-1'||value.prefix!=='contextvault-tests/release-'+id+'/') throw Error('CI cleanup state does not identify owned test resources');
  return value;
}
async function stateAt(directory) {
  const file=path.join(directory,'owner.json'),info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>4096) throw Error('Invalid CI ownership receipt');
  return validateCiState(JSON.parse(await readFile(file,'utf8')));
}
export async function teardownCi(directory) {
  let state;try{state=await stateAt(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
  let container;
  try{container=JSON.parse(await docker(['inspect','--type','container',state.container]))[0];}catch(error){if(!missing(error))throw error;}
  if(container) {
    if(container.Config.Labels?.[label]!==state.identity) throw Error('Refused CI container with another owner');
    await docker(['rm','--force','--volumes',state.container]);
  }
  let network;
  try{network=JSON.parse(await docker(['network','inspect',state.network]))[0];}catch(error){if(!missing(error))throw error;}
  if(network) {
    if(network.Labels?.[label]!==state.identity) throw Error('Refused CI network with another owner');
    await docker(['network','rm',state.network]);
  }
  await writeFile(path.join(directory,'cleanup.json'),JSON.stringify({identity:state.identity,containerRemoved:true,networkRemoved:true})+'\n',{mode:0o600});
}
export async function setupCi(directory) {
  if(!path.isAbsolute(directory)) throw Error('CI state directory must be absolute');
  await mkdir(directory,{mode:0o700});
  const identity=randomUUID(),state=validateCiState({schemaVersion:1,identity,container:'cv-release-s3-'+identity,network:'cv-release-s3-'+identity,bucket:'cv-release-'+identity,region:'us-east-1',prefix:'contextvault-tests/release-'+identity+'/'});
  const save=()=>writeFile(path.join(directory,'owner.json'),JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'w'});
  await save();
  try {
    await docker(['network','create','--label',label+'='+identity,state.network]);
    await docker(['create','--pull=never','--name',state.container,'--label',label+'='+identity,'--network',state.network,'--network-alias','contextvault-s3','--publish','127.0.0.1::4566','--env','SERVICES=s3','--env','DEFAULT_REGION=us-east-1','localstack/localstack:4.14.0']);
    await docker(['start',state.container]);
    const deadline=Date.now()+45000;
    while(Date.now()<deadline) {
      const view=JSON.parse(await docker(['inspect','--type','container',state.container]))[0],bindings=view.NetworkSettings.Ports['4566/tcp'];
      if(view.Config.Labels?.[label]!==identity||!view.State.Running) throw Error('Owned CI LocalStack did not stay running');
      if(bindings?.length===1&&bindings[0].HostIp==='127.0.0.1'&&/^[1-9]\d*$/.test(bindings[0].HostPort)) {
        const endpoint='http://127.0.0.1:'+bindings[0].HostPort;
        try {const response=await fetch(endpoint+'/_localstack/health',{signal:AbortSignal.timeout(1000)}),health=await response.json();if(response.ok&&['available','running'].includes(health.services?.s3)){state.endpoint=endpoint;state.containerId=view.Id;break;}}catch{}
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!state.endpoint) throw Error('Owned CI LocalStack readiness deadline expired');
    await save();
    const client=new S3Client({endpoint:state.endpoint,region:state.region,forcePathStyle:true,ignoreConfiguredEndpointUrls:true,maxAttempts:1,credentials:{accessKeyId:'test',secretAccessKey:'test'}});
    try{await client.send(new CreateBucketCommand({Bucket:state.bucket}));}finally{client.destroy();}
    const selected={CV_TEST_S3_PROVIDER:'localstack',CV_TEST_S3_CONTAINER:state.container,CV_TEST_S3_ENDPOINT:state.endpoint,CV_TEST_S3_CONTAINER_ENDPOINT:'http://contextvault-s3:4566',CV_TEST_DOCKER_NETWORK:state.network,CV_TEST_S3_BUCKET:state.bucket,CV_TEST_S3_REGION:state.region,CV_TEST_S3_PREFIX:state.prefix};
    await writeFile(path.join(directory,'environment'),Object.entries(selected).map(([key,value])=>key+'='+value).join('\n')+'\n',{mode:0o600});
    return state;
  } catch(error) {try{await teardownCi(directory);}catch(cleanup){throw new AggregateError([error,cleanup],'CI fixture setup and owned cleanup failed');}throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command,directory,...rest]=process.argv.slice(2);
  if(!['setup','teardown'].includes(command)||!directory||!path.isAbsolute(directory)||rest.length){console.error('Use release-ci.mjs setup|teardown /absolute/private-state-directory');process.exitCode=1;}
  else (command==='setup'?setupCi(directory):teardownCi(directory)).then(value=>console.log(JSON.stringify({command,...(value?{identity:value.identity,endpoint:value.endpoint}: {complete:true})}))).catch(error=>{console.error(error.message);process.exitCode=1;});
}

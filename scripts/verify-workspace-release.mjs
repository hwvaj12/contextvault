#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, lstat, readdir, mkdtemp, realpath, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planTestRun, requireS3 } from './run-workspace-tests.mjs';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const faultBoundaries = ['before-candidate','during-transfer','after-candidate','before-acceptance','after-acceptance'];
const languages = ['typescript','python','php'];
const environments = ['worker','container','remote-machine'];
const digestPattern = /^[a-f0-9]{64}$/;

export function parseReleaseOptions(args) {
  const options = {s3Provider:undefined,allHosts:false,allSdks:false,realS3:false}, seen = new Set();
  for (let index=0;index<args.length;index++) {
    const argument=args[index];
    if (seen.has(argument)) throw Error('Duplicate release option: '+argument);
    seen.add(argument);
    if (argument==='--s3-provider') {
      const value=args[++index]; if(!['localstack','aws'].includes(value)) throw Error('--s3-provider localstack or aws is required'); options.s3Provider=value;
    } else if(argument==='--require-all-hosts') options.allHosts=true;
    else if(argument==='--require-all-sdks') options.allSdks=true;
    else if(argument==='--require-real-s3') options.realS3=true;
    else throw Error('Unknown release option: '+argument);
  }
  if(options.realS3 && options.s3Provider!=='aws') throw Error('--require-real-s3 requires AWS');
  if(!options.s3Provider || !options.allHosts || !options.allSdks) throw Error('Release verification requires --s3-provider, --require-all-hosts, and --require-all-sdks');
  return options;
}

export function validateVitest(report,{root=rootDirectory,expectedFiles=[],requiredTitles=[]}={}) {
  if(report?.success!==true || !Number.isSafeInteger(report.numTotalTests) || report.numTotalTests<1 || report.numPassedTests!==report.numTotalTests || report.numFailedTests!==0 || report.numPendingTests!==0 || report.numTodoTests!==0 || !Array.isArray(report.testResults) || !report.testResults.length) throw Error('Vitest report has failed, skipped, or zero coverage');
  const files=[],titles=[];
  for(const suite of report.testResults) {
    if(suite.status!=='passed' || typeof suite.name!=='string' || !Array.isArray(suite.assertionResults) || !suite.assertionResults.length) throw Error('Vitest suite coverage is incomplete');
    const file=path.relative(root,suite.name).split(path.sep).join('/'); if(file.startsWith('../') || path.isAbsolute(file) || files.includes(file)) throw Error('Vitest suite coverage is invalid'); files.push(file);
    for(const assertion of suite.assertionResults) {
      if(assertion.status!=='passed' || typeof assertion.fullName!=='string' || !assertion.fullName) throw Error('Vitest assertion failed or skipped');
      titles.push(assertion.fullName);
    }
  }
  if(titles.length!==report.numTotalTests || expectedFiles.some(file=>!files.includes(file)) || files.some(file=>!expectedFiles.includes(file)) || requiredTitles.some(title=>!titles.some(value=>value.includes(title)))) throw Error('Vitest required file or matrix coverage is incomplete');
  return {tests:titles.length,skipped:0,files:files.sort(),titles};
}

async function boundedJson(file) {
  try { const info=await lstat(file); if(!info.isFile() || info.isSymbolicLink() || info.size>32*1024*1024) throw Error(); return JSON.parse(await readFile(file,'utf8')); }
  catch { throw Error('Required JSON report is missing or invalid: '+file); }
}
export async function readJUnit(file,{requiredNames=[],python='python3'}={}) {
  let result;
  try { const output=await execute(python,[path.join(rootDirectory,'tests/acceptance/read-junit.py'),file],{timeout:10000,maxBuffer:4*1024*1024}); result=JSON.parse(output.stdout); }
  catch { throw Error('JUnit report is missing, malformed, failed, skipped, or has inconsistent coverage'); }
  if(!Number.isSafeInteger(result.tests) || result.tests<1 || result.skipped!==0 || requiredNames.some(name=>!result.names.some(value=>value.includes(name)))) throw Error('JUnit required matrix coverage is incomplete');
  return result;
}

function redact(text,env) {
  let result=text;
  for(const [name,value]of Object.entries(env)) if(/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && typeof value==='string' && value.length>=4 && !(env.CV_TEST_S3_PROVIDER==='localstack'&&['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY'].includes(name)&&value==='test')) result=result.split(value).join('[redacted]');
  return result;
}
export async function runCommand({command,args,cwd,env,logPath,timeoutMs=20*60*1000}) {
  const started=Date.now(); let output;
  try { output=await execute(command,args,{cwd,env,shell:false,timeout:timeoutMs,killSignal:'SIGKILL',maxBuffer:32*1024*1024,encoding:'utf8'}); }
  catch(error) { output=error; throw Error('Command failed ('+(error.signal??error.code??'unavailable')+'); private diagnostics: '+logPath); }
  finally { if(output) { await writeFile(logPath,redact((output.stdout??'')+'\n'+(output.stderr??''),env),{mode:0o600}); await chmod(logPath,0o600); } }
  return {milliseconds:Date.now()-started,stdout:output.stdout};
}
export async function runReportedGate(gate,{directory,root=rootDirectory}={}) {
  const {stdout,...timing}=await runCommand({...gate,logPath:path.join(directory,gate.id+'.log')});
  let coverage;
  if(gate.format==='vitest') coverage=validateVitest(await boundedJson(gate.report),{root,expectedFiles:gate.expectedFiles,requiredTitles:gate.requiredTitles});
  else if(gate.format==='junit') coverage=await readJUnit(gate.report,{requiredNames:gate.requiredTitles});
  else if(gate.format==='no-git') {
    let value;try{value=JSON.parse(stdout.trim());}catch{throw Error('No-Git runtime report is missing or malformed');}
    coverage={tests:1,skipped:0,evidence:validateNoGitEvidence(value,gate.env.CV_TEST_S3_PREFIX)};
  }
  else if(gate.format!=='command') throw Error('Unknown release report format');
  return {id:gate.id,command:[gate.command,...gate.args],backend:gate.backend??null,language:gate.language??null,...timing,...coverage};
}

export function validateFaultEvidence(value,backend,prefix) {
  const invalid=()=>{throw Error('Physical fault evidence is missing or inconsistent');};
  if(value?.schemaVersion!==1 || value.backend!==backend || !Array.isArray(value.cases) || value.cases.length!==faultBoundaries.length) invalid();
  for(const boundary of faultBoundaries) {
    const cases=value.cases.filter(item=>item.boundary===boundary); if(cases.length!==1) invalid(); const item=cases[0];
    if(!Number.isSafeInteger(item.pid)||item.pid<1||item.exit?.code!==null||item.exit?.signal!=='SIGKILL'||!item.headBeforeKill||!item.headAfterRecovery||item.headAfterRecovery===item.headBeforeKill||item.revisionCountAfter!==item.revisionCountBefore+1||item.publicationAuditCount!==1||item.publicationOutboxCount!==1||!digestPattern.test(item.binarySha256)||!Number.isSafeInteger(item.binaryByteLength)||item.binaryByteLength<1||!Array.isArray(item.manifestPaths)||!item.manifestPaths.length||!item.operationId||item.operationId!==item.replayedOperationId) invalid();
    if(item.headAfterKill!==(boundary==='after-acceptance'?item.headAfterRecovery:item.headBeforeKill)) invalid();
    if(['before-candidate','after-candidate','before-acceptance'].includes(boundary) && (!Number.isSafeInteger(item.oldFence)||!Number.isSafeInteger(item.newFence)||item.newFence<=item.oldFence)) invalid();
    if(backend==='s3'&&(typeof prefix!=='string'||typeof item.testPrefix!=='string'||!item.testPrefix.startsWith(prefix)||item.testPrefix===prefix)) invalid();
    if(boundary==='during-transfer') {
      const progress=item.adapterProgress;
      if(!progress||!Number.isSafeInteger(progress.consumedByteLength)||progress.consumedByteLength<5*1024*1024||progress.consumedByteLength!==item.receivedByteLength||!Number.isSafeInteger(item.declaredByteLength)||item.declaredByteLength!==item.binaryByteLength||item.receivedByteLength>=item.declaredByteLength||!Array.isArray(progress.writerIds)||!progress.writerIds.length||progress.writerIds.some(id=>typeof id!=='string'||!id)||new Set(progress.writerIds).size!==progress.writerIds.length) invalid();
      if(backend==='git') {const local=progress.localTransfer;if(!local||local.byteLength!==progress.consumedByteLength||local.matchesDeclaredPrefix!==true||!digestPattern.test(local.sha256)) invalid();}
      else {const multipart=progress.multipartTransfer;if(!multipart||typeof multipart.key!=='string'||!multipart.key.startsWith(item.testPrefix)||typeof multipart.uploadId!=='string'||!multipart.uploadId||multipart.completedObject!==false||!Array.isArray(multipart.parts)||!multipart.parts.some(part=>Number.isSafeInteger(part.partNumber)&&part.partNumber>0&&Number.isSafeInteger(part.byteLength)&&part.byteLength>=5*1024*1024&&typeof part.etag==='string'&&part.etag)||multipart.parts.reduce((sum,part)=>sum+part.byteLength,0)>progress.consumedByteLength) invalid();}
    }
    const cleanup=item.cleanup;
    if(!cleanup||!Array.isArray(cleanup.errors)||!Array.isArray(cleanup.uncertainWriterIds)||cleanup.uncertainWriterCount!==cleanup.uncertainWriterIds.length) invalid();
    if(cleanup.state==='complete') {if(cleanup.uncertainWriterCount!==0||cleanup.errors.length) invalid();}
    else if(boundary!=='during-transfer'||!['pending','failed'].includes(cleanup.state)||!cleanup.uncertainWriterCount||!isDeepStrictEqual([...cleanup.uncertainWriterIds].sort(),[...item.adapterProgress.writerIds].sort())||cleanup.errors.length!==1||cleanup.errors[0].work!=='collect-submission'||cleanup.errors[0].code!=='FORBIDDEN'||!item.submissionId||cleanup.errors[0].id!==item.submissionId) invalid();
  }
  const revocation=value.revocation;
  if(!Number.isSafeInteger(revocation?.pid)||revocation.pid<1||revocation.exit?.signal!=='SIGKILL'||revocation.exit?.code!==null||revocation.headUnchanged!==true||revocation.acceptedPublicationCount!==0||revocation.error!=='CREDENTIAL_REVOKED') invalid();
  if(revocation.cleanup?.state!=='complete'||revocation.cleanup.uncertainWriterCount!==0||!Array.isArray(revocation.cleanup.uncertainWriterIds)||revocation.cleanup.uncertainWriterIds.length||!Array.isArray(revocation.cleanup.errors)||revocation.cleanup.errors.length) invalid();
  return value;
}

function canonical(value) {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
export function validateMcpSchemas(toolSets) {
  if(!Array.isArray(toolSets)||toolSets.length!==3) throw Error('All three MCP schema entrypoints are required');
  const definitions=toolSets.map(set=>{
    if(!Array.isArray(set?.tools)||!set.tools.length) throw Error('MCP schema tools are missing');
    const names=new Set();
    for(const tool of set.tools) { if(typeof tool?.name!=='string'||!tool.name||names.has(tool.name)||!tool.inputSchema||typeof tool.inputSchema!=='object') throw Error('MCP schema definition is invalid'); names.add(tool.name); }
    return [...set.tools].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0).map(canonical);
  });
  if(!isDeepStrictEqual(definitions[0],definitions[1])||!isDeepStrictEqual(definitions[0],definitions[2])) throw Error('Complete MCP schema parity failed');
  return {count:definitions[0].length,sha256:hash(JSON.stringify(definitions[0])),tools:definitions[0].map(tool=>tool.name)};
}

export function validateNoGitEvidence(value,prefix) {
  const fields=['pass','provider','image','imageId','node','gitAbsent','installedProductionDependencies','normalEntrypoint','binaryRoundTrip','finalized','aborted','prefix'];
  if(!value||Object.keys(value).some(key=>!fields.includes(key))||value.pass!==true||value.provider!=='localstack'||value.image!=='node:20-bookworm-slim'||!/^sha256:[a-f0-9]{64}$/.test(value.imageId)||!/^v20\./.test(value.node)||value.gitAbsent!==true||value.installedProductionDependencies!==true||value.normalEntrypoint!=='dist/index.js'||value.binaryRoundTrip!==true||value.finalized!==true||value.aborted!==true||typeof prefix!=='string'||typeof value.prefix!=='string'||!value.prefix.startsWith(prefix)||!/^no-git-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/$/.test(value.prefix.slice(prefix.length))) throw Error('Actual Node20 no-Git S3 runtime evidence is incomplete');
  return value;
}

async function noGitTarget(env) {
  const container=env.CV_TEST_S3_CONTAINER??'cv-localstack-01a1a255';
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw Error('The selected LocalStack container name is invalid');
  const service=JSON.parse((await execute('docker',['inspect','--type','container',container],{env,timeout:10000,maxBuffer:1024*1024})).stdout)[0];
  const endpoint=new URL(env.CV_TEST_S3_ENDPOINT),host=endpoint.hostname==='localhost'?'127.0.0.1':endpoint.hostname;
  if(!service.State.Running||!['127.0.0.1','localhost'].includes(endpoint.hostname)||!(service.NetworkSettings.Ports['4566/tcp']??[]).some(binding=>binding.HostPort===endpoint.port&&[host,'0.0.0.0'].includes(binding.HostIp))) throw Error('The selected endpoint does not identify the running LocalStack container');
  const networks=service.NetworkSettings.Networks;
  const candidates=Object.keys(networks).filter(name=>(networks[name].Aliases??[]).includes('contextvault-s3'));
  const network=env.CV_TEST_DOCKER_NETWORK??(candidates.length===1?candidates[0]:undefined);
  if(!network||!networks[network]||['host','none','bridge'].includes(network)||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(network)) throw Error('Select the dedicated Docker network for the LocalStack service');
  const aliases=(networks[network].Aliases??[]).concat(service.Name.replace(/^\//,''));
  const selected=new URL(env.CV_TEST_S3_CONTAINER_ENDPOINT??'http://contextvault-s3:4566');
  if(selected.protocol!=='http:'||selected.username||selected.password||selected.pathname!=='/'||selected.search||selected.hash||selected.port!=='4566'||!aliases.includes(selected.hostname)) throw Error('The container S3 endpoint does not identify the selected LocalStack service');
  return {CV_TEST_S3_CONTAINER:container,CV_TEST_DOCKER_NETWORK:network,CV_TEST_S3_CONTAINER_ENDPOINT:selected.origin};
}

async function testFiles(root,directories,suffix='.test.ts') {
  const files=[];
  async function walk(relative) {
    let entries; try{entries=await readdir(path.join(root,relative),{withFileTypes:true});}catch{throw Error('Required test suite is missing: '+relative);}
    for(const entry of entries) {
      if(['node_modules','tooling','__pycache__'].includes(entry.name)) continue;
      const file=relative+'/'+entry.name;
      if(entry.isDirectory()) await walk(file); else if(entry.isFile()&&entry.name.endsWith(suffix)) files.push(file);
    }
  }
  for(const directory of directories) {const before=files.length;await walk(directory);if(files.length===before) throw Error('Required test suite is empty: '+directory);}
  return files.sort();
}

function releaseEnvironment(environment) {
  const env={};
  for(const name of ['PATH','LANG','LC_ALL','LC_CTYPE','TZ','TMPDIR','TEMP','TMP','HOME','SYSTEMROOT','WINDIR','PATHEXT',
    'CV_TEST_S3_PROVIDER','CV_TEST_S3_CONTAINER','CV_TEST_S3_ENDPOINT','CV_TEST_S3_CONTAINER_ENDPOINT','CV_TEST_DOCKER_NETWORK','CV_TEST_S3_BUCKET','CV_TEST_S3_REGION','CV_TEST_S3_PREFIX',
    'CV_TEST_PYTHON_BINARY','CV_TEST_PHP_BINARY','CV_TEST_COMPOSER_BINARY','CV_REQUIRE_REAL_S3']) if(environment[name]!==undefined)env[name]=environment[name];
  env.CV_TEST_SERVER_NODE=process.execPath;
  return env;
}

export async function createReleasePlan({root=rootDirectory,directory,options,env:environment=process.env}={}) {
  try{const s=await lstat(path.join(root,'tests/faults/process-kills.test.ts'));if(!s.isFile()||s.isSymbolicLink())throw Error();}catch{throw Error('Required physical server-kill suite is missing: tests/faults/process-kills.test.ts');}
  if(!directory || !options?.allHosts || !options?.allSdks) throw Error('A complete release requires a private run directory and every matrix cell');
  if(options.s3Provider!=='localstack') throw Error('The current all-host and installed-SDK release fixtures require LocalStack; AWS release proof is unsupported');
  const env=releaseEnvironment(environment);requireS3(env,options);const gates=[];
  const addCommand=(id,command,args,extra={})=>gates.push({id,command,args,cwd:root,env:{...env},format:'command',...extra});
  const vitest=async(id,directories,gateEnv,extra={})=>{
    const expectedFiles=await testFiles(root,directories),report=path.join(directory,id+'.json');
    gates.push({id,command:process.execPath,args:[path.join(root,'node_modules/vitest/vitest.mjs'),'run',...directories,'--reporter=json','--outputFile='+report],cwd:root,env:{...env,...gateEnv},format:'vitest',report,expectedFiles,...extra});
  };
  const suite=async(id,name,args,gateEnv={},extra={})=>{
    const plan=await planTestRun(name,args,{root,env:{...env,...gateEnv}}), report=path.join(directory,id+(name==='sdk'&&extra.language!=='typescript'?'.xml':'.json'));
    const directories=[`tests/${{legacy:'compat',migration:'migrations'}[name]??name}`+(name==='adapters'?'/'+extra.backend:name==='sdk'?'/'+extra.language:'')];
    const gate={id,...plan,report,...extra};
    if(name==='sdk'&&extra.language==='python') {gate.args=[...plan.args,'--junitxml='+report];gate.format='junit';gate.requiredTitles=['test_documented_wheel_import[git]','test_documented_wheel_import[s3]','test_sequential_checkpoints_and_reopen_recovery[git]','test_sequential_checkpoints_and_reopen_recovery[s3]','test_lost_response_restart_before_remote_ids[git]','test_lost_response_restart_before_remote_ids[s3]'];await testFiles(root,directories,'.py');}
    else if(name==='sdk'&&extra.language==='php') {gate.args=[...plan.args,'--log-junit',report];gate.format='junit';gate.requiredTitles=['testComposerInstalledClientExecutesOnPhp80ForBothBackends','testInstalledLifecycleAndSafeCanonicalFiles','testCheckpointReopensWithoutRepeatingPublication','testDurableOriginalCommandsAndImmutableCaptureSurviveRestart'];await testFiles(root,directories,'Test.php');}
    else {gate.args=[...plan.args,'--reporter=json','--outputFile='+report];gate.format='vitest';gate.expectedFiles=await testFiles(root,directories);}
    gates.push(gate);
  };
  addCommand('server-build','npm',['run','build']);
  addCommand('typescript-build','npm',['--prefix','sdk/typescript','run','build']);
  addCommand('mcp-build','npm',['--prefix','mcp','run','build']);
  addCommand('vault-browser-build','npm',['--prefix','src/vault-browser','run','build']);
  addCommand('secondary-ui-build','npm',['--prefix','ui','run','build']);
  const noGitScript=path.join(root,'tests/http/no-git-server.mjs');
  try{if(!(await lstat(noGitScript)).isFile())throw Error();}catch{throw Error('Required Node20 no-Git runtime gate is missing: tests/http/no-git-server.mjs');}
  addCommand('no-git-s3',process.execPath,[noGitScript],{backend:'s3',format:'no-git'});
  const selfReport=path.join(directory,'release-selftests.xml');
  const faultGuards='tests/faults/verification-guards.mjs';
  try{if(!(await lstat(path.join(root,faultGuards))).isFile())throw Error();}catch{throw Error('Required physical fault evidence guards are missing: '+faultGuards);}
  addCommand('release-selftests',process.execPath,['--test','--test-reporter=junit','--test-reporter-destination='+selfReport,'tests/acceptance/release-runner.test.mjs',faultGuards],{format:'junit',report:selfReport,requiredTitles:['compares complete MCP schemas when tool names stay identical','rejects missing physical crash boundaries, stale fences, and a non-SIGKILL exit']});
  const docsReport=path.join(directory,'docs-selftests.xml');
  const docsFiles=await testFiles(root,['tests/docs'],'.test.mjs');
  addCommand('docs-selftests',process.execPath,['--test','--test-reporter=junit','--test-reporter-destination='+docsReport,...docsFiles],{format:'junit',report:docsReport});
  await vitest('core',['tests/unit','tests/application','tests/control','tests/http','tests/integration','tests/revisions','tests/security','tests/submissions'],{CV_TEST_BACKEND:'git',CV_TEST_SUITE:'core'});
  await suite('contracts','contracts',[],{CV_TEST_BACKEND:'git'});
  await vitest('revisions-s3',['tests/revisions'],{CV_TEST_BACKEND:'s3',CV_TEST_SUITE:'revisions'},{backend:'s3'});
  for(const backend of ['git','s3']) {
    const selection=['--backend',backend,...(backend==='s3'?['--s3-provider','localstack']:[])];
    await suite('adapters-'+backend,'adapters',selection,{}, {backend});
    await suite('acceptance-'+backend,'acceptance',selection,{}, {backend,requiredTitles:['A01/A06: publishes exact bytes and deletions through HTTP, survives restart, and preserves abort isolation','delivers signed workspace creation and deletion only to the current customer']});
    for(const name of ['recovery','legacy','mcp']) await suite(name+'-'+backend,name,[],{CV_TEST_BACKEND:backend},{backend});
    await vitest('faults-'+backend,['tests/faults'],{CV_TEST_BACKEND:backend,CV_TEST_SUITE:'faults',CV_FAULT_EVIDENCE_PATH:path.join(directory,'faults-'+backend+'-evidence.json')},{backend,requiredTitles:[...faultBoundaries.map(boundary=>'recovers SIGKILL at '+boundary+' with one authoritative publication'),'rejects revoked authority after SIGKILL before recovery']});
    await suite('hosts-'+backend,'hosts',selection,{}, {backend,requiredTitles:[...languages.flatMap(language=>[`installed ${language} worker recovers a killed controller`,`installed ${language} client and independent container agent`,`installed ${language} remote-machine boundary`]),'installed CLI separates submit from publication','the supplied container launcher publishes','typescript worker preserves its first unknown heartbeat']});
    addCommand('docs-'+backend,process.execPath,[path.join(root,'scripts/verify-workspace-docs.mjs'),...selection],{backend});
  }
  for(const language of languages) await suite('sdk-'+language,'sdk',['--language',language],{}, {language,...(language==='typescript'?{requiredTitles:['installed TypeScript package: git','installed TypeScript package: s3','installed TypeScript lifecycle: git','installed TypeScript lifecycle: s3','installed TypeScript checkpoints: git','installed TypeScript checkpoints: s3','installed TypeScript recovery: git','installed TypeScript recovery: s3']}: {})});
  await suite('migration','migration',[],{CV_TEST_BACKEND:'git'},{requiredTitles:['moves exact accepted history Git to S3 and back through an explicit operator command with HTTP readback']});
  return gates;
}

async function freshJson(file,started) {
  const info=await lstat(file);if(info.mtimeMs<started-2) throw Error('Required evidence was not produced by this gate: '+file);
  return boundedJson(file);
}
export async function hostEvidence(root,backend,started,prefix) {
  const cells=[];
  for(const environment of environments) for(const language of languages) {
    const value=await freshJson(path.join(root,'tests/hosts/tooling/evidence',`${backend}-${environment}-${language}.json`),started);
    if(value.backend!==backend||value.language!==language||value.environment!==environment||value.ok!==true||value.version!==3||!value.binaryDeletion||!value.killedControllerRecovery||!value.finalized||!value.aborted||!value.cleaned||!digestPattern.test(value.packageArtifact)||!digestPattern.test(value.artifactSet)||typeof value.runtime!=='string'||!/^\d+\.\d+\./.test(value.runtime)||typeof value.os!=='string'||!value.os) throw Error('Required host matrix cell is incomplete');
    if(environment!=='worker'&&(!/^sha256:[a-f0-9]{64}$/.test(value.imageId)||value.isolation?.kind!=='isolated-container-network'||!value.isolation.hostFilesystemDenied||!value.isolation.relayDestinationDenied||(backend==='s3'&&(!value.isolation.storageIpDenied||!value.isolation.hostEndpointDenied)))) throw Error('Required host boundary is incomplete');
    if(environment!=='worker'&&(!/^linux\//i.test(value.os)||!(language==='typescript'?/^18\./:language==='python'?/^3\.8\./:/^8\.0\./).test(value.runtime))) throw Error('Required minimum client runtime is missing');
    if(environment==='container'&&language==='typescript'&&(!/^18\./.test(value.minimumCliProof?.runtime)||!value.minimumCliProof.installed||!value.minimumCliProof.separateSubmit||!value.minimumCliProof.finalized||!value.minimumCliProof.aborted||!value.minimumCliProof.cleaned)) throw Error('Required minimum CLI runtime is missing');
    cells.push(value);
  }
  const cli=await freshJson(path.join(root,'tests/hosts/tooling/evidence',backend+'-cli.json'),started);
  const example=await freshJson(path.join(root,'tests/hosts/tooling/evidence',backend+'-container-example.json'),started);
  if(cli.backend!==backend||!cli.installed||!cli.separateSubmit||!cli.binaryDeletion||!cli.checkpoint||!cli.finalized||!cli.aborted||!cli.cleaned||!digestPattern.test(cli.packageArtifact)||example.backend!==backend||!example.cleaned||!example.foregroundLeaseRenewed||!example.workspaceOnlyAgentMount||!/^24\./.test(example.runtime?.node)) throw Error('CLI or supplied container evidence is incomplete');
  const artifactSet=cells[0].artifactSet;
  if(cells.some(cell=>cell.artifactSet!==artifactSet)||cli.artifactSet!==artifactSet||example.artifactSet!==artifactSet||example.packageArtifact!==cli.packageArtifact||languages.some(language=>new Set(cells.filter(cell=>cell.language===language).map(cell=>cell.packageArtifact)).size!==1)) throw Error('Host cells do not identify one consistent installed artifact set');
  const directory=path.join(root,'tests/hosts/tooling/evidence'),servers=[];
  for(const file of await readdir(directory)) if(file.startsWith(backend+'-server-')&&file.endsWith('.json')) {
    const info=await lstat(path.join(directory,file));if(info.mtimeMs<started-2) continue;
    const value=await boundedJson(path.join(directory,file));
    if(value.kind!=='docker'||value.hostMounts!==false||value.controllerBinding?.host!=='127.0.0.1'||value.runtime?.platform!=='linux') throw Error('API host boundary evidence is incomplete');
    servers.push({id:value.id,runtime:value.runtime,sourceHash:value.sourceHash,...(backend==='s3'?{childPrefix:prefix+'http-'+value.id+'/'}:{})});
  }
  if(servers.length<4) throw Error('Required independent API host fixtures are missing');
  return {cells,cli,example,servers};
}
export async function docsEvidence(root,backend,started,prefix) {
  const value=await freshJson(path.join(root,'tests/docs/verification-'+backend+'.log'),started);
  const expected=['positive','assertion-failure','script-failure','request-failure','request-timeout','skipped-assertion','zero-assertions','wall-timeout'];
  if(value.backend!==backend||value.tests!==2||value.skipped!==0||value.quickstarts!==3||value.postman!==1||value.links<1||value.reports?.length!==1||value.reports[0].requests<22||value.reports[0].assertions<45||value.reports[0].skipped!==0||value.examples?.length!==3||value.runtimeProbes?.cases?.length!==8||expected.some(name=>!value.runtimeProbes.cases.some(item=>item.name===name&&item.expected===(name==='positive'?'accepted':'rejected')&&item.actual===item.expected))||languages.some(language=>!value.examples.some(item=>item.language===language&&item.binary&&item.deletion&&item.abort&&item.cleanup&&item.version===3&&digestPattern.test(item.packageArtifact)))) throw Error('Executable documentation evidence is incomplete');
  return {...value,...(backend==='s3'?{childPrefix:prefix+'http-'+value.api.id+'/'}:{})};
}

async function sourceSnapshot(root,env) {
  const head=(await execute('/usr/bin/git',['rev-parse','HEAD'],{cwd:root,env,timeout:5000})).stdout.trim();
  const files=(await execute('/usr/bin/git',['ls-files','-c','-o','--exclude-standard','-z'],{cwd:root,env,timeout:5000,maxBuffer:4*1024*1024})).stdout.split('\0').filter(file=>file&&!file.startsWith('.team-lead/')&&!file.startsWith('docs/items/')&&!file.startsWith('docs/runs/')&&file!=='docs/status.md').sort();const entries=[];
  for(const file of files) {const info=await lstat(path.join(root,file));if(!info.isFile()||info.isSymbolicLink()) throw Error('Release source requires regular files');entries.push({path:file,mode:(info.mode&0o777).toString(8),sha256:hash(await readFile(path.join(root,file)))});}
  return {head,sha256:hash(JSON.stringify(entries)),files:entries.length};
}

async function main() {
  const options=parseReleaseOptions(process.argv.slice(2)),env=releaseEnvironment(process.env);requireS3(env,options);
  const directory=await mkdtemp(path.join(await realpath(tmpdir()),'cv-release-'));await chmod(directory,0o700);
  const identity=randomUUID();await writeFile(path.join(directory,'owner.json'),JSON.stringify({identity,purpose:'ContextVault nonproduction release verification'}),{mode:0o600});
  const report={schemaVersion:1,identity,startedAt:new Date().toISOString(),status:'running',controller:{node:process.versions.node,platform:process.platform,arch:process.arch},target:{provider:options.s3Provider,endpoint:env.CV_TEST_S3_ENDPOINT,bucket:env.CV_TEST_S3_BUCKET,region:env.CV_TEST_S3_REGION,prefix:env.CV_TEST_S3_PREFIX},gates:[],exclusions:['AWS service parity','Windows','physical remote hardware','hosted CI execution','native Linux release controller','historical ad-hoc tests/e2e/api.test.mjs and webhooks.test.mjs; maintained supported outcomes remain required through public HTTP, compat, revision, and security gates'],namespaceEvidence:'Caller prefix is unchanged. Emitted host/docs API fixture UUIDs identify verified http-<UUID>/ child prefixes. Other fixtures use owned UUID children without a complete emitted namespace ledger.'};
  try {
    const gates=await createReleasePlan({root:rootDirectory,directory,options,env});
    const [major,minor]=process.versions.node.split('.').map(Number);
    if(process.platform!=='darwin'||major<22||(major===22&&minor<12)) throw Error('The current release controller requires macOS, Node22.12+, and Docker Desktop; other controllers are unverified');
    report.source=await sourceSnapshot(rootDirectory,env);
    const target=await noGitTarget(env);Object.assign(gates.find(gate=>gate.id==='no-git-s3').env,target);Object.assign(report.target,{container:target.CV_TEST_S3_CONTAINER,containerEndpoint:target.CV_TEST_S3_CONTAINER_ENDPOINT,network:target.CV_TEST_DOCKER_NETWORK});
    report.requiredGates=gates.map(gate=>gate.id);
    report.controller.docker=(await execute('docker',['version','--format','{{.Server.Version}}'],{env,timeout:10000})).stdout.trim();
    report.controller.python=(await execute('python3',['--version'],{env,timeout:10000})).stdout.trim();
    report.controller.php=(await execute('php',['-r','echo PHP_VERSION;'],{env,timeout:10000})).stdout.trim();
    for(const gate of gates) {
      const started=Date.now();report.activeGate=gate.id;console.log('Starting release gate: '+gate.id);
      const result=await runReportedGate(gate,{directory,root:rootDirectory});
      if(gate.id.startsWith('faults-')) result.evidence=validateFaultEvidence(await boundedJson(path.join(directory,gate.id+'-evidence.json')),gate.backend,env.CV_TEST_S3_PREFIX);
      if(gate.id.startsWith('hosts-')) result.evidence=await hostEvidence(rootDirectory,gate.backend,started,env.CV_TEST_S3_PREFIX);
      if(gate.id.startsWith('docs-')&&gate.id!=='docs-selftests') result.evidence=await docsEvidence(rootDirectory,gate.backend,started,env.CV_TEST_S3_PREFIX);
      if(gate.id.startsWith('mcp-')&&gate.id!=='mcp-build') {
        const value=await freshJson(path.join(rootDirectory,'tests/mcp/tooling','package-evidence-'+gate.backend+'.json'),started);
        if(value.backend!==gate.backend||!digestPattern.test(value.sha256)||!digestPattern.test(value.schema?.sha256)||value.schema.count!==value.tools.length||value.schema.count<1||!/^20\./.test(value.minimumNode)||value.sourceSiblingRequired!==false||value.minimumImageHasGit!==false) throw Error('Installed MCP package/schema evidence is incomplete');
        result.evidence=value;
      }
      report.gates.push(result);await writeFile(path.join(directory,'summary.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
      console.log('Passed release gate: '+gate.id+' ('+(result.tests??'build')+')');
    }
    const after=await sourceSnapshot(rootDirectory,env);if(!isDeepStrictEqual(report.source,after)) throw Error('Tracked or untracked release source changed during verification');
    delete report.activeGate;report.status='passed';report.completedAt=new Date().toISOString();
  } catch(error) {report.status='failed';report.failure='Verification stopped; inspect private diagnostics.';throw Error('Workspace release failed; private evidence: '+directory,{cause:error});}
  finally {await writeFile(path.join(directory,'summary.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});const destination=path.join(rootDirectory,'tests/acceptance/release-evidence.log');await writeFile(destination,JSON.stringify({...report,privateDiagnostics:directory},null,2)+'\n',{mode:0o600});await chmod(destination,0o600);}
  console.log(JSON.stringify({status:report.status,source:report.source,target:report.target,gates:report.gates.map(({id,tests,skipped})=>({id,tests,skipped})),report:path.join(rootDirectory,'tests/acceptance/release-evidence.log')}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{console.error(error.message);if(error.cause)console.error(error.cause.message);process.exitCode=1;});

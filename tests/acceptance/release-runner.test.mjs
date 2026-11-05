import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const runner = new URL('../../scripts/verify-workspace-release.mjs', import.meta.url);
async function api() {
  let value;
  try { value = await import(runner); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.ok(value, 'The strict release runner must exist and export its validators');
  return value;
}
async function fixture(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cv-release-selftest-'));
  try { await callback(directory); } finally { await rm(directory, {recursive:true,force:true}); }
}
const flags = ['--s3-provider','localstack','--require-all-hosts','--require-all-sdks'];
const goodReport = () => ({success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:[{name:'/repo/tests/a.test.ts',status:'passed',assertionResults:[{fullName:'required cell',title:'required cell',status:'passed'}]}]});

test('requires an explicit complete release and rejects unknown, duplicate, missing, and conflicting options', async () => {
  const {parseReleaseOptions} = await api();
  assert.deepEqual(parseReleaseOptions(flags),{s3Provider:'localstack',allHosts:true,allSdks:true,realS3:false});
  for (const args of [[],['--s3-provider'],[...flags,'--unknown'],[...flags,'--require-all-hosts'],[...flags,'--s3-provider','aws'],['--s3-provider','localstack','--require-all-hosts']]) assert.throws(()=>parseReleaseOptions(args));
  assert.throws(()=>parseReleaseOptions([...flags,'--require-real-s3']),/requires AWS/);
});

test('accepts actual positive Vitest coverage for every required file and title', async () => {
  const {validateVitest} = await api();
  const result = validateVitest(goodReport(),{root:'/repo',expectedFiles:['tests/a.test.ts'],requiredTitles:['required cell']});
  assert.equal(result.tests,1); assert.deepEqual(result.files,['tests/a.test.ts']);
});

for (const [name,change] of [
  ['failed suite',r=>{r.success=false;}],
  ['failed assertion',r=>{r.testResults[0].assertionResults[0].status='failed';}],
  ['zero tests',r=>{r.numTotalTests=0;r.numPassedTests=0;}],
  ['skipped test',r=>{r.numPendingTests=1;}],
  ['todo test',r=>{r.numTodoTests=1;}],
  ['missing suite',r=>{r.testResults=[];}],
  ['inconsistent test total',r=>{r.numTotalTests=2;r.numPassedTests=2;}],
]) test(`rejects a Vitest ${name} even when the process exits successfully`,async()=>{
  const {validateVitest}=await api(), report=goodReport(); change(report);
  assert.throws(()=>validateVitest(report,{root:'/repo',expectedFiles:['tests/a.test.ts'],requiredTitles:['required cell']}));
});

test('rejects omitted files, duplicate suites, and absent required matrix cells',async()=>{
  const {validateVitest}=await api();
  assert.throws(()=>validateVitest(goodReport(),{root:'/repo',expectedFiles:['tests/a.test.ts','tests/missing.test.ts']}),/coverage/);
  assert.throws(()=>validateVitest(goodReport(),{root:'/repo',expectedFiles:['tests/a.test.ts'],requiredTitles:['missing cell']}),/coverage/);
  const duplicate=goodReport();duplicate.testResults.push(duplicate.testResults[0]);
  assert.throws(()=>validateVitest(duplicate,{root:'/repo',expectedFiles:['tests/a.test.ts']}));
});

test('parses nested PHPUnit and pytest JUnit without double-counting their suites',async()=>{
  const {readJUnit}=await api();
  await fixture(async directory=>{
    const file=path.join(directory,'junit.xml');
    await writeFile(file,'<testsuites><testsuite tests="2" failures="0" errors="0" skipped="0"><testsuite tests="2" failures="0" errors="0"><testcase classname="Installed" name="git &amp; bytes"/><testcase classname="Installed" name="s3"/></testsuite></testsuite></testsuites>');
    const result=await readJUnit(file,{requiredNames:['git & bytes','s3']});
    assert.equal(result.tests,2);assert.equal(result.skipped,0);
  });
});

for(const [name,xml]of[
  ['zero','<testsuites><testsuite tests="0" failures="0" errors="0"/></testsuites>'],
  ['skipped','<testsuites><testsuite tests="1" failures="0" errors="0" skipped="1"><testcase name="required"><skipped/></testcase></testsuite></testsuites>'],
  ['failure','<testsuite tests="1" failures="1" errors="0"><testcase name="required"><failure/></testcase></testsuite>'],
  ['error','<testsuite tests="1" failures="0" errors="1"><testcase name="required"><error/></testcase></testsuite>'],
  ['inconsistent','<testsuite tests="2" failures="0" errors="0"><testcase name="required"/></testsuite>'],
  ['malformed','<testsuite>'],
]) test(`rejects ${name} JUnit reports`,async()=>{
  const {readJUnit}=await api();await fixture(async directory=>{const file=path.join(directory,'junit.xml');await writeFile(file,xml);await assert.rejects(readJUnit(file,{requiredNames:['required']}));});
});

test('rejects a missing JUnit report and missing installed backend case',async()=>{
  const {readJUnit}=await api();await fixture(async directory=>{
    const file=path.join(directory,'junit.xml');await assert.rejects(readJUnit(file));
    await writeFile(file,'<testsuite tests="1" failures="0" errors="0"><testcase name="git"/></testsuite>');
    await assert.rejects(readJUnit(file,{requiredNames:['git','s3']}),/coverage/);
  });
});

test('rejects failed commands, preserves private diagnostics, and removes secrets from logs',async()=>{
  const {runCommand}=await api();await fixture(async directory=>{
    const logPath=path.join(directory,'failed.log');
    await assert.rejects(runCommand({command:process.execPath,args:['-e','console.error(process.env.CV_API_KEY);process.exit(7)'],cwd:directory,env:{...process.env,CV_API_KEY:'private-release-secret'},logPath,timeoutMs:1000}),/Command failed/);
    const log=await readFile(logPath,'utf8');assert.ok(log.includes('[redacted]'));assert.ok(!log.includes('private-release-secret'));
  });
});

test('rejects successful commands with missing or malformed required JSON reports',async()=>{
  const {runReportedGate}=await api();await fixture(async directory=>{
    const report=path.join(directory,'report.json');const gate={id:'fixture',command:process.execPath,args:['-e',''],cwd:directory,env:process.env,format:'vitest',report,expectedFiles:['tests/a.test.ts']};
    await assert.rejects(runReportedGate(gate,{directory,root:'/repo'}),/report/);
    gate.args=['-e','require("node:fs").writeFileSync(process.argv[1],"not-json")',report];
    await assert.rejects(runReportedGate(gate,{directory,root:'/repo'}),/report/);
  });
});

test('kills an over-time child instead of waiting indefinitely',async()=>{
  const {runCommand}=await api();await fixture(async directory=>{
    const start=Date.now();await assert.rejects(runCommand({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:directory,env:process.env,logPath:path.join(directory,'timeout.log'),timeoutMs:30}),/Command failed/);assert.ok(Date.now()-start<3000);
  });
});

test('bounds a child that ignores SIGTERM',async()=>{
  const {runCommand}=await api();await fixture(async directory=>{
    const pidFile=path.join(directory,'child.pid');let timeout;
    try {
      const command=runCommand({command:process.execPath,args:['-e','require("node:fs").writeFileSync(process.argv[1],String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',pidFile],cwd:directory,env:process.env,logPath:path.join(directory,'stubborn.log'),timeoutMs:200});
      await assert.rejects(Promise.race([command,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('child exceeded hard deadline')),2500);})]),/Command failed/);
    } finally {clearTimeout(timeout);try{process.kill(Number(await readFile(pidFile,'utf8')),'SIGKILL');}catch{}}
  });
});

test('compares complete MCP schemas when tool names stay identical',async()=>{
  const {validateMcpSchemas}=await api();assert.equal(typeof validateMcpSchemas,'function');
  const tools=[{name:'checkout_workspace',description:'current authority',inputSchema:{type:'object',properties:{workspaceId:{type:'string'}},required:['workspaceId'],additionalProperties:false}}];
  const result=validateMcpSchemas([{tools},{tools:structuredClone(tools)},{tools:structuredClone(tools)}]);
  assert.equal(result.count,1);assert.match(result.sha256,/^[a-f0-9]{64}$/);
  for(const mutate of [t=>{t[0].inputSchema.required=[];},t=>{t[0].description='changed';},t=>{t[0].inputSchema.additionalProperties=true;}]){const changed=structuredClone(tools);mutate(changed);assert.throws(()=>validateMcpSchemas([{tools},{tools:changed},{tools}]),/schema/);}
});

test('never plans a partial release when the physical fault suite is missing',async()=>{
  const {createReleasePlan}=await api();assert.equal(typeof createReleasePlan,'function');
  await fixture(async directory=>{await assert.rejects(createReleasePlan({root:directory,directory,options:{s3Provider:'localstack',allHosts:true,allSdks:true,realS3:false},env:{}}),/tests\/faults/);});
});

test('plans every backend gate and each internally dual-backend SDK gate exactly once',async()=>{
  const {createReleasePlan}=await api();await fixture(async directory=>{
    const paths=['tests/faults/process-kills.test.ts','tests/faults/verification-guards.mjs','tests/acceptance/lifecycle.test.ts','tests/acceptance/legacy-webhooks.test.ts','tests/http/no-git-server.mjs','tests/docs/harness.test.mjs','sdk/php/vendor/bin/phpunit'];
    for(const group of ['unit','application','control','http','integration','revisions','security','submissions','contracts','adapters/git','adapters/s3','recovery','compat','mcp','hosts','sdk/typescript','migrations'])paths.push('tests/'+group+'/fixture.test.ts');
    paths.push('tests/sdk/python/test_fixture.py','tests/sdk/php/FixtureTest.php');
    for(const file of paths){await mkdir(path.dirname(path.join(directory,file)),{recursive:true});await writeFile(path.join(directory,file),'');}
    const env={PATH:process.env.PATH,CV_TEST_S3_PROVIDER:'localstack',CV_TEST_S3_ENDPOINT:'http://127.0.0.1:4566',CV_TEST_S3_BUCKET:'test-only',CV_TEST_S3_REGION:'us-east-1',CV_TEST_S3_PREFIX:'contextvault-tests/selected/',AWS_PROFILE:'foreign',AWS_SESSION_TOKEN:'foreign-token',CV_DATA_DIR:'/foreign',CV_STORAGE_BACKEND:'s3'};
    const gates=await createReleasePlan({root:directory,directory,options:{s3Provider:'localstack',allHosts:true,allSdks:true,realS3:false},env});
    assert.equal(gates.length,29);assert.equal(new Set(gates.map(g=>g.id)).size,29);
    assert.equal(gates.filter(g=>g.id==='revisions-s3').length,1);assert.equal(gates.filter(g=>g.id==='no-git-s3').length,1);
    for(const backend of ['git','s3'])for(const name of ['adapters','acceptance','recovery','legacy','mcp','faults','hosts','docs'])assert.equal(gates.filter(g=>g.id===name+'-'+backend).length,1);
    for(const language of ['typescript','python','php'])assert.equal(gates.filter(g=>g.language===language).length,1);
    for(const backend of ['git','s3'])assert.ok(gates.find(g=>g.id==='acceptance-'+backend).requiredTitles.includes('delivers signed workspace creation and deletion only to the current customer'));
    for(const gate of gates){assert.equal(gate.env.CV_TEST_S3_PREFIX,env.CV_TEST_S3_PREFIX);assert.equal(gate.env.AWS_ACCESS_KEY_ID,'test');assert.equal(gate.env.AWS_PROFILE,undefined);assert.equal(gate.env.AWS_SESSION_TOKEN,undefined);assert.equal(gate.env.CV_DATA_DIR,undefined);assert.equal(gate.env.CV_STORAGE_BACKEND,undefined);}
  });
});

test('requires actual production Node20 S3 behavior without Git inside the selected prefix',async()=>{
  const {validateNoGitEvidence}=await api();assert.equal(typeof validateNoGitEvidence,'function');
  const prefix='contextvault-tests/selected/',value={pass:true,provider:'localstack',image:'node:20-bookworm-slim',imageId:'sha256:'+'a'.repeat(64),node:'v20.20.0',gitAbsent:true,installedProductionDependencies:true,normalEntrypoint:'dist/index.js',binaryRoundTrip:true,finalized:true,aborted:true,prefix:prefix+'no-git-11111111-1111-4111-8111-111111111111/'};
  assert.equal(validateNoGitEvidence(value,prefix),value);
  for(const change of [{pass:false},{node:'v22.0.0'},{gitAbsent:false},{installedProductionDependencies:false},{normalEntrypoint:'fake.js'},{binaryRoundTrip:false},{finalized:false},{aborted:false},{prefix:'contextvault-tests/unselected/no-git-11111111-1111-4111-8111-111111111111/'}])assert.throws(()=>validateNoGitEvidence({...value,...change},prefix));
});

test('refuses CI cleanup state whose resource names do not belong to its recorded identity',async()=>{
  let module;try{module=await import('./release-ci.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
  assert.equal(typeof module?.validateCiState,'function','The CI helper must validate ownership before Docker mutation');
  const identity='11111111-1111-4111-8111-111111111111',state={schemaVersion:1,identity,container:'cv-release-s3-'+identity,network:'cv-release-s3-'+identity,bucket:'cv-release-'+identity,region:'us-east-1',prefix:'contextvault-tests/release-'+identity+'/'};
  assert.equal(module.validateCiState(state),state);
  for(const change of [{container:'unrelated'},{network:'unrelated'},{bucket:'customer-data'},{prefix:''},{identity:'not-an-owner'}])assert.throws(()=>module.validateCiState({...state,...change}));
});

test('rejects missing physical crash boundaries, stale fences, and a non-SIGKILL exit',async()=>{
  const {validateFaultEvidence}=await api();
  assert.throws(()=>validateFaultEvidence({schemaVersion:1,backend:'git',cases:[]},'git'),/fault/);
  const points=['before-candidate','during-transfer','after-candidate','before-acceptance','after-acceptance'];
  const value={schemaVersion:1,backend:'git',cases:points.map(boundary=>({boundary,pid:123,exit:{code:null,signal:'SIGKILL'},headBeforeKill:'base',headAfterKill:boundary==='after-acceptance'?'accepted':'base',headAfterRecovery:'accepted',revisionCountBefore:1,revisionCountAfter:2,publicationAuditCount:1,publicationOutboxCount:1,binarySha256:'a'.repeat(64),binaryByteLength:3,manifestPaths:['binary.bin'],oldFence:['during-transfer','after-acceptance'].includes(boundary)?null:1,newFence:['during-transfer','after-acceptance'].includes(boundary)?null:2,operationId:'same-operation',replayedOperationId:'same-operation'})),revocation:{pid:456,exit:{code:null,signal:'SIGKILL'},headUnchanged:true,acceptedPublicationCount:0,error:'CREDENTIAL_REVOKED'}};
  const cleanup=()=>({state:'complete',uncertainWriterCount:0,uncertainWriterIds:[],errors:[]});
  for(const item of value.cases){item.submissionId='submission-1';item.cleanup=cleanup();}
  value.revocation.cleanup=cleanup();
  const transfer=value.cases.find(item=>item.boundary==='during-transfer');
  Object.assign(transfer,{binaryByteLength:7*1024*1024,declaredByteLength:7*1024*1024,receivedByteLength:6*1024*1024,adapterProgress:{consumedByteLength:6*1024*1024,writerIds:['writer-1'],localTransfer:{byteLength:6*1024*1024,matchesDeclaredPrefix:true,sha256:'b'.repeat(64)}}});
  assert.equal(validateFaultEvidence(value,'git').cases.length,5);
  const stale=structuredClone(value);stale.cases[0].newFence=1;assert.throws(()=>validateFaultEvidence(stale,'git'));
  const graceful=structuredClone(value);graceful.cases[0].exit={code:0,signal:null};assert.throws(()=>validateFaultEvidence(graceful,'git'));
  const unstarted=structuredClone(value);unstarted.cases.find(item=>item.boundary==='during-transfer').adapterProgress.writerIds=[];assert.throws(()=>validateFaultEvidence(unstarted,'git'));
  const eligiblePending=structuredClone(value);eligiblePending.cases[0].cleanup.state='pending';assert.throws(()=>validateFaultEvidence(eligiblePending,'git'));
  const retained=structuredClone(value),item=retained.cases.find(item=>item.boundary==='during-transfer');item.cleanup={state:'failed',uncertainWriterCount:1,uncertainWriterIds:['writer-1'],errors:[{work:'collect-submission',code:'FORBIDDEN',id:item.submissionId}]};assert.equal(validateFaultEvidence(retained,'git').cases.length,5);
  const wrongSubmission=structuredClone(retained);wrongSubmission.cases.find(item=>item.boundary==='during-transfer').cleanup.errors[0].id='foreign';assert.throws(()=>validateFaultEvidence(wrongSubmission,'git'));
});

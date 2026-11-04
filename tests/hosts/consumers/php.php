<?php
declare(strict_types=1);
require getenv('CV_ARTIFACTS') . '/php/vendor/autoload.php';
use ContextVault\{Client, WorkspaceSession};
use ContextVault\Exception\OutcomeUnknownError;
function ensure(bool $value, string $message): void { if (!$value) throw new RuntimeException($message); }
function agent(string $directory, string $stage): void {
    $process = proc_open(['/bin/sh', __DIR__ . '/agent.sh', $directory, $stage], [0 => ['pipe','r'], 1 => ['pipe','w'], 2 => ['pipe','w']], $pipes, null, ['PATH' => getenv('PATH')]);
    fclose($pipes[0]); $out = stream_get_contents($pipes[1]); $error = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]); ensure(proc_close($process) === 0, $error);
}
function boundary(): array {
    foreach (array_keys(getenv()) as $name) ensure(strpos($name, 'AWS_') !== 0 && !in_array($name, ['CV_DATA_DIR','CV_S3_BUCKET','CV_S3_ENDPOINT'], true), 'No storage credentials in consumer');
    if (getenv('CV_BOUNDARY') === 'worker') return ['kind' => 'cooperating-host-process'];
    ensure(!file_exists(getenv('CV_HOST_ONLY_FILE')) && !file_exists('/var/run/docker.sock'), 'Host files are outside the agent boundary');
    $storageProbe = getenv('CV_STORAGE_PROBE_REQUIRED') === '1';
    foreach ($storageProbe ? [[getenv('CV_STORAGE_PROBE_IP'),4566],[getenv('CV_STORAGE_PROBE_HOST_IP'),(int)getenv('CV_STORAGE_PROBE_HOST_PORT')]] : [] as [$host,$port]) {
        $socket = @stream_socket_client('tcp://' . $host . ':' . $port, $errno, $error, 0.7); if ($socket !== false) { fclose($socket); throw new RuntimeException('Canonical storage is directly reachable'); }
    }
    $origin = parse_url(getenv('CV_API_URL')); $socket = stream_socket_client('tcp://' . $origin['host'] . ':' . $origin['port'], $errno, $error, 2);
    ensure($socket !== false, 'Reach the permitted API relay'); stream_set_timeout($socket, 2);
    fwrite($socket, 'GET http://' . getenv('CV_STORAGE_PROBE_IP') . ":4566/ HTTP/1.1\r\nHost: " . $origin['host'] . "\r\nConnection: close\r\n\r\n");
    $line = fgets($socket); fclose($socket); ensure(strpos($line, ' 400 ') !== false, 'Relay rejects alternate destinations');
    return ['kind'=>'isolated-container-network','storageIpDenied'=>$storageProbe ? true : null,'hostEndpointDenied'=>$storageProbe ? true : null,'relayDestinationDenied'=>true,'hostFilesystemDenied'=>true];
}
$parent = getenv('CV_CLIENT_PARENT'); $handle = $parent . '/handle.json'; $action = $argv[1];
if ($action === 'tamper') { $saved=json_decode(file_get_contents($handle),true,512,JSON_THROW_ON_ERROR); agent($saved['path'],'tamper'); echo "{\"ok\":true}\n"; exit(0); }
$isolation = boundary(); $client = new Client(getenv('CV_API_KEY'),getenv('CV_API_URL'),0); $first=hex2bin('00ff6167656e740a'); $second=hex2bin('ff006e657874800a');
if ($action === 'start') {
    $session=$client->createWorkspace(getenv('CV_CUSTOMER_ID'),'host-php',$parent,['agentLabel'=>'independent-shell-agent','task'=>'host matrix','reason'=>'client-local files']);
    $workspacePath=$session->path(); agent($workspacePath,'first'); $unknown=false; try { $session->checkpoint(true); } catch (OutcomeUnknownError $error) { $unknown=true; }
    ensure($unknown,'Expected lost response'); $state=$session->state(); ensure(is_string($state['pendingCommand']['idempotencyKey']),'Retain original key');
    ensure(file_get_contents($workspacePath.'/payload.bin')===$first,'Keep original ordinary files'); ensure(strpos(file_get_contents($session->recoveryPath()),getenv('CV_API_KEY'))===false,'No credentials in journal');
    $saved=['privatePath'=>$session->recoveryPath(),'path'=>$workspacePath,'workspaceId'=>$state['workspaceId'],'originalRunId'=>$state['run']['id'],'originalKey'=>$state['pendingCommand']['idempotencyKey']];
    $output=fopen($handle,'w'); fwrite($output,json_encode($saved,JSON_THROW_ON_ERROR)); fflush($output); fclose($output);
    echo json_encode(['phase'=>'crash']+$saved,JSON_THROW_ON_ERROR),"\n"; fflush(STDOUT); posix_kill(getmypid(),9); exit(99);
}
ensure($action==='resume','Expected resume'); $saved=json_decode(file_get_contents($handle),true,512,JSON_THROW_ON_ERROR); $session=$client->resumeWorkspace($saved['privatePath']);
ensure($session->state()['pendingCommand']['idempotencyKey']===$saved['originalKey'],'Resume original key'); $session->reconcile(true);
ensure($client->request('GET','/v1/workspaces/'.$saved['workspaceId'])['version']===2,'One accepted checkpoint'); ensure($session->state()['run']['id']!==$saved['originalRunId'],'Open next run');
ensure($client->runs()->get($saved['originalRunId'])['state']==='finalized','Original run accepted'); ensure(file_get_contents($session->path().'/payload.bin')===$first,'Restore original captured bytes');
$session->heartbeat(); $old=$session->path(); agent($old,'next'); $session->finalize(true); $session->cleanup(true); ensure(!is_dir($old),'Cleanup finalized directory');
$reader=$client->openWorkspace($saved['workspaceId'],$parent,['mode'=>'read-only']);
ensure(file_get_contents($reader->path().'/payload.bin')===$second,'Read exact binary'); ensure(is_dir($reader->path().'/empty')&&!file_exists($reader->path().'/delete-me.txt'),'Preserve directory and deletion'); ensure(file_get_contents($reader->path().'/café.txt')==="unicode file\n",'Read Unicode file'); $reader->finalize(true); $reader->cleanup(true);
$abort=$client->openWorkspace($saved['workspaceId'],$parent); agent($abort->path(),'abort'); $old=$abort->path(); $abort->abort('discard ordinary agent files',true); $abort->cleanup(true); ensure(!is_dir($old),'Cleanup aborted directory'); ensure($client->request('GET','/v1/workspaces/'.$saved['workspaceId'])['version']===3,'Abort does not publish');
echo json_encode(['ok'=>true,'language'=>'php','runtime'=>PHP_VERSION,'os'=>PHP_OS_FAMILY.'/'.php_uname('m'),'package'=>Composer\InstalledVersions::getVersion('contextvault/contextvault-php'),'isolation'=>$isolation,'workspaceId'=>$saved['workspaceId'],'version'=>3,'binaryDeletion'=>true,'checkpoint'=>true,'killedControllerRecovery'=>true,'originalKey'=>$saved['originalKey'],'finalized'=>true,'aborted'=>true,'cleaned'=>true],JSON_THROW_ON_ERROR),"\n";

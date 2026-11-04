<?php
declare(strict_types=1);
require __DIR__ . '/correction-faults.php';
require '/artifact/vendor/autoload.php';

use ContextVault\{Client, LocalFiles, Manifest};
use ContextVault\Exception\{AuthError, ContextVaultException, NetworkError, OutcomeUnknownError};

function check(bool $condition, string $message): void {
    $GLOBALS['checks'] = ($GLOBALS['checks'] ?? 0) + 1;
    if (!$condition) throw new RuntimeException($message);
}
function errorCode(callable $work, string $code): ContextVaultException {
    try { $work(); } catch (ContextVaultException $error) { check($error->getErrorCode() === $code, "Expected $code, got " . $error->getErrorCode() . ': ' . $error->getMessage() . '; previous=' . ($error->getPrevious() ? $error->getPrevious()->getMessage() : 'none')); return $error; }
    throw new RuntimeException("Expected $code");
}
function workspaceVersion(Client $client, string $id): int { return $client->request('GET', '/v1/workspaces/' . $id)['version']; }
function readSession(Client $client, string $id): ContextVault\WorkspaceSession { return $client->openWorkspace($id, '/scratch', ['mode' => 'read-only']); }

final class LossClient extends Client
{
    public ?string $lose = null;
    public bool $before = false;
    public bool $loseDownload = false;
    public bool $loseOperation = false;
    public bool $genericFailure = false;
    public bool $signalPollDenial = false;
    public array $finalizeKeys = [];
    public array $operationReads = [];
    public ?float $operationWaitStarted = null;
    public int $beforeFinalizeDelayUs = 0;
    public function request(string $method, string $uri, array $options = []): mixed {
        if ($method === 'POST' && substr($uri, -9) === '/finalize') {
            $this->finalizeKeys[] = $options['headers']['Idempotency-Key'];
            if ($this->signalPollDenial) $options['headers']['X-CV-Test-Deny-Poll'] = '1';
            if ($this->beforeFinalizeDelayUs > 0) { usleep($this->beforeFinalizeDelayUs); $this->beforeFinalizeDelayUs = 0; }
        }
        if ($method === 'GET' && strpos($uri, '/v1/operations/') === 0) { $this->operationReads[] = $uri; if ($this->operationWaitStarted === null) $this->operationWaitStarted = hrtime(true) / 1e9; }
        $matches = $method !== 'GET' && $this->lose !== null && preg_match($this->lose, $uri);
        if ($matches && $this->before) { $this->lose = null; throw new NetworkError('Injected request loss'); }
        $response = parent::request($method, $uri, $options);
        if ($this->loseOperation && $method === 'GET' && strpos($uri, '/v1/operations/') === 0) { $this->loseOperation = false; throw new NetworkError('Injected operation response loss'); }
        if ($matches) { $this->lose = null; if ($this->genericFailure) throw new RuntimeException('Injected post-dispatch failure'); throw new NetworkError('Injected response loss'); }
        return $response;
    }
    public function download(string $uri, array $entry, $destination): void {
        parent::download($uri, $entry, $destination);
        if ($this->loseDownload) { $this->loseDownload = false; throw new NetworkError('Injected hydration interruption'); }
    }
}
function verifyOperationDeadline(string $workspaceId): array
{
    $timed = new LossClient(getenv('CV_KEY_A'), getenv('CV_TIMEOUT_URL'), 3, ['timeout' => 3, 'operationTimeout' => 0.1]);
    $timedSession = $timed->openWorkspace($workspaceId, '/scratch'); $path = $timedSession->path();
    file_put_contents($path . '/deadline', 'accepted despite missing poll'); $timed->beforeFinalizeDelayUs = 1100000;
    $wholeStarted = hrtime(true) / 1e9; errorCode(fn() => $timedSession->finalize(true), 'PUBLICATION_OUTCOME_UNKNOWN'); $waitFinished = hrtime(true) / 1e9;
    check($timed->operationWaitStarted !== null, 'Reach the actual stalled operation GET');
    $prePollSeconds = $timed->operationWaitStarted - $wholeStarted; $waitSeconds = $waitFinished - $timed->operationWaitStarted;
    check($prePollSeconds >= 1.0, 'Exercise more than one second of preparation before operation polling');
    check($waitSeconds < 0.9, 'Operation deadline bounds the entire polling wait after preparation');
    $pollEvidence = $timed->request('GET', '/correction-operation-polls');
    check(($pollEvidence['operationGets'] ?? null) === 1, 'Exactly one operation GET reaches the proxy despite three configured read retries');
    $pending = $timedSession->state()['pendingCommand'];
    check(is_string($pending['operationId']) && $pending['idempotencyKey'] === $timed->finalizeKeys[0], 'Deadline retains the original command and durable operation');
    $recovery = new LossClient(getenv('CV_KEY_A'), getenv('CV_TIMEOUT_URL'), 3); $timedSession = $recovery->resumeWorkspace($timedSession->recoveryPath());
    check($timedSession->reconcile(true)['runState'] === 'finalized', 'Reconcile the accepted operation after polling timeout');
    check($recovery->finalizeKeys === [] && array_unique($recovery->operationReads) === ['/v1/operations/' . $pending['operationId']], 'Read the same operation without another publication');
    $timedSession->cleanup(true); check(!is_dir($path), 'Explicit cleanup follows the known accepted outcome');
    return ['prePollSeconds' => $prePollSeconds, 'operationWaitSeconds' => $waitSeconds, 'wholeFinalizeSeconds' => $waitFinished - $wholeStarted, 'operationGetRequests' => $pollEvidence['operationGets']];
}
check(PHP_VERSION === '8.0.30', 'The consumer must execute on PHP 8.0.30');
check(strpos((new ReflectionClass(ContextVault\Client::class))->getFileName(), '/artifact/vendor/contextvault/contextvault-php/') === 0, 'Use installed package');
$client = new Client(getenv('CV_KEY_A'), getenv('CV_URL'), 0);
if (getenv('CV_PHP_FOCUS_DEADLINE') === '1') {
    $seed = $client->createWorkspace(getenv('CV_CUSTOMER_A'), 'php-deadline-focus', '/scratch'); $workspaceId = $seed->state()['workspaceId'];
    $seed->abort('deadline fixture ready'); $seed->cleanup(true);
    echo json_encode(['runtime' => PHP_VERSION, 'installed' => true, 'deadline' => verifyOperationDeadline($workspaceId), 'checks' => $GLOBALS['checks']], JSON_THROW_ON_ERROR), "\n"; exit;
}
$session = $client->createWorkspace(getenv('CV_CUSTOMER_A'), 'php-installed', '/scratch');
$state = $session->state(); $path = $session->path(); $id = $state['workspaceId'];
check(is_dir($path), 'Materialize a client-local path');
check((fileperms($path) & 0777) === 0700, 'Owned directory is private');
check((fileperms($session->recoveryPath()) & 0777) === 0600, 'Private state is mode 0600');
check(strpos($session->recoveryPath(), $path . '/') !== 0, 'Control state is outside submitted content');
check(strpos(file_get_contents($session->recoveryPath()), getenv('CV_KEY_A')) === false, 'Never persist API credentials');
$fixture = json_decode(file_get_contents('/artifact/canonical.v1.json'), true, 512, JSON_THROW_ON_ERROR);
check(Manifest::bytes($fixture['input']) === $fixture['canonical'], 'Shared canonical bytes');
check(Manifest::digest($fixture['input']) === $fixture['sha256'], 'Shared manifest digest');
foreach ($fixture['files'] as $name => $file) file_put_contents($path . '/' . $name, hex2bin($file['hex']));
mkdir($path . '/empty');
$capture = LocalFiles::capture($path, dirname($session->recoveryPath()), $client->limits());
check(Manifest::digest($capture['manifest']) === $fixture['sha256'], 'Filesystem capture matches shared fixture');
check((fileperms($capture['directory'] . '/binary.bin') & 0777) === 0600, 'Private captured bytes use mode 0600');
LocalFiles::clear($capture['directory'], true);
foreach (['/absolute', '../escape', 'a/../b', 'a//b', 'a\\b', 'C:/file', 'a/', "a\0b", '.git/config', 'nested/.GIT/config', '.contextvault/handle', 'CON', 'com¹.txt', 'CONIN$', 'bad.', 'bad ', "e\u{0301}.txt", "bad\xff"] as $unsafe) errorCode(fn() => Manifest::path($unsafe), 'INVALID_MANIFEST');
$f = static fn(string $p): array => ['path' => $p, 'kind' => 'file', 'byteLength' => 0, 'sha256' => hash('sha256', '')];
foreach ([[$f('a'), $f('A')], [$f('straße'), $f('STRASSE')], [$f('a/one'), $f('A/two')], [$f('a'), $f('a/b')], [$f('Ｆoo'), $f('Foo')]] as $entries) errorCode(fn() => Manifest::canonical(['schemaVersion' => 1, 'entries' => $entries]), 'INVALID_MANIFEST');
errorCode(fn() => Manifest::canonical($fixture['input'], ['maxEntries' => 1]), 'QUOTA_EXCEEDED');
errorCode(fn() => Manifest::canonical($fixture['input'], ['maxFileBytes' => 1]), 'QUOTA_EXCEEDED');
errorCode(fn() => Manifest::canonical($fixture['input'], ['maxTotalBytes' => 1]), 'QUOTA_EXCEEDED');
errorCode(fn() => $session->finalize(), 'WRITERS_NOT_STOPPED');
symlink('/etc/passwd', $path . '/link'); errorCode(fn() => LocalFiles::capture($path, dirname($session->recoveryPath()), $client->limits()), 'INVALID_MANIFEST'); unlink($path . '/link');
link($path . '/notes.txt', $path . '/hard'); errorCode(fn() => LocalFiles::capture($path, dirname($session->recoveryPath()), $client->limits()), 'INVALID_MANIFEST'); unlink($path . '/hard');
posix_mkfifo($path . '/fifo', 0600); errorCode(fn() => LocalFiles::capture($path, dirname($session->recoveryPath()), $client->limits()), 'INVALID_MANIFEST'); unlink($path . '/fifo');
file_put_contents($path . "/bad\xff", 'invalid name'); errorCode(fn() => LocalFiles::capture($path, dirname($session->recoveryPath()), $client->limits()), 'INVALID_MANIFEST'); unlink($path . "/bad\xff");
mkdir($path . '/.GIT'); file_put_contents($path . '/.GIT/config', 'excluded');
mkdir($path . '/.contextvault'); file_put_contents($path . '/.contextvault/key', 'excluded');
file_put_contents($path . '/.gitignore', "ignored.txt\n"); file_put_contents($path . '/ignored.txt', 'ordinary content');
$large = fopen($path . '/large.bin', 'wb'); for ($i = 0; $i < 64; $i++) fwrite($large, str_repeat("\0\xff\r\n", 16384)); fclose($large);
$initialVersion = $state['run']['version']; $heartbeat = $session->heartbeat();
check($heartbeat['version'] === $initialVersion && $heartbeat['leaseVersion'] === 2, 'Lease and run versions remain separate');
$result = $session->finalize(true); check($result['runState'] === 'finalized' && $result['changed'], 'Finalize exact full snapshot');
check(is_file($path . '/binary.bin'), 'Finalize preserves local files');
$read = readSession($client, $id); $readPath = $read->path();
check(file_get_contents($readPath . '/binary.bin') === hex2bin('00ff800d0a'), 'Exact binary byte roundtrip');
check(file_get_contents($readPath . '/notes.txt') === "hello\r\n" && is_dir($readPath . '/empty'), 'Line endings and explicit directory roundtrip');
check(file_get_contents($readPath . '/ignored.txt') === 'ordinary content' && !file_exists($readPath . '/.GIT') && !file_exists($readPath . '/.contextvault'), 'Control exclusion and ordinary gitignore semantics');
check(hash_file('sha256', $readPath . '/large.bin') === hash_file('sha256', $path . '/large.bin'), 'Large resource streams preserve bytes');
$count = workspaceVersion($client, $id); $read->finalize(true); check(workspaceVersion($client, $id) === $count, 'Read-only finalize does not duplicate publication'); $read->cleanup(true);
$otherTenant = new Client(getenv('CV_KEY_B'), getenv('CV_URL'), 0);
$foreign = $otherTenant->createWorkspace(getenv('CV_CUSTOMER_B'), 'php-tenant-b', '/scratch');
try { $otherTenant->runs()->get($state['run']['id']); throw new RuntimeException('Tenant isolation missing'); } catch (ContextVaultException $error) { check(in_array($error->getStatusCode(), [403, 404], true), 'Run scope hides other tenant'); }
try { $otherTenant->openWorkspace($id, '/scratch'); throw new RuntimeException('Workspace isolation missing'); } catch (ContextVaultException $error) { check(in_array($error->getStatusCode(), [403, 404], true), 'Open enforces tenant scope'); }
$foreign->abort('tenant done', true); $foreign->cleanup(true);
$discardVersion = workspaceVersion($client, $id); $discard = $client->openWorkspace($id, '/scratch'); file_put_contents($discard->path() . '/discard.txt', 'not published'); $discard->abort('discard', true); check(workspaceVersion($client, $id) === $discardVersion, 'Abort does not publish'); $discard->cleanup(true);
$captureFailure = $client->openWorkspace($id, '/scratch'); $failurePath = $captureFailure->path(); symlink('/etc/passwd', $failurePath . '/link');
errorCode(fn() => $captureFailure->finalize(true), 'INVALID_MANIFEST');
check($captureFailure->state()['pendingCommand'] === null, 'Unsafe capture dispatches no mutation');
$captureFailure->abort('caller discards rejected local capture'); unlink($failurePath . '/link'); $captureFailure->cleanup(true);
$deletion = $client->openWorkspace($id, '/scratch'); LocalFiles::clear($deletion->path()); $deletion->finalize(true);
$empty = readSession($client, $id); check($client->runs()->manifest($empty->state()['run']['id'])['entries'] === [], 'Empty complete snapshot deletes all files and directories'); $empty->abort('empty verified', true); $empty->cleanup(true); $deletion->cleanup(true);
symlink('/etc/passwd', $path . '/unsafe-cleanup'); errorCode(fn() => $session->cleanup(true), 'INVALID_MANIFEST');
check($session->status()['state'] === 'finalized' && $session->recovery()['workflow']['localCleanup']['state'] === 'failed', 'Cleanup failure cannot overwrite publication');
unlink($path . '/unsafe-cleanup'); $session->cleanup(true); check(!is_dir($path), 'Explicit cleanup removes only owned local files');
$lifecycle = true;

// A publication and a later reopen have independent durable commands.
$loss = new LossClient(getenv('CV_KEY_A'), getenv('CV_URL'), 0);
$checkpoint = $loss->createWorkspace(getenv('CV_CUSTOMER_A'), 'php-checkpoint', '/scratch');
$checkpointPath = $checkpoint->path(); $checkpointId = $checkpoint->state()['workspaceId']; $oldRun = $checkpoint->state()['run']['id'];
file_put_contents($checkpointPath . '/checkpoint.txt', 'first checkpoint');
$loss->lose = '~/runs$~'; $loss->before = true;
errorCode(fn() => $checkpoint->checkpoint(true), 'PUBLICATION_OUTCOME_UNKNOWN');
$uncertain = $checkpoint->recovery(); $openKey = $uncertain['state']['pendingCommand']['idempotencyKey'];
check($uncertain['workflow']['recoveryStatus'] === 'published-needs-reopen', 'Persist publication before reopen');
$interloper = $client->openWorkspace($checkpointId, '/scratch'); file_put_contents($interloper->path() . '/new-base.txt', 'new pinned base'); $interloper->finalize(true); $interloper->cleanup(true);
$beforeReopen = workspaceVersion($client, $checkpointId);
$checkpoint = $client->resumeWorkspace($checkpoint->recoveryPath()); $checkpoint->checkpoint(true);
check($checkpoint->path() === $checkpointPath && $checkpoint->state()['run']['id'] !== $oldRun, 'Checkpoint preserves path across sequential runs');
check(is_file($checkpointPath . '/new-base.txt') && workspaceVersion($client, $checkpointId) === $beforeReopen, 'Reopen refreshes newer pinned base without republishing');
check($checkpoint->state()['pendingCommand'] === null && strlen($openKey) > 0, 'Original reopen command completes');
$checkpoint->abort('checkpoint done', true); check(($checkpoint->reconcile(true)['state'] ?? null) === 'aborted', 'Reconciliation retains the later abort after a previous checkpoint'); $checkpoint->cleanup(true);
$hydrating = new LossClient(getenv('CV_KEY_A'), getenv('CV_URL'), 0); $hydrating->loseDownload = true;
try { $hydrating->openWorkspace($checkpointId, '/scratch'); throw new RuntimeException('Expected hydration failure'); } catch (NetworkError $error) { $hydrationState = $error->getRecoveryPath(); }
check($hydrationState !== null, 'Hydration failure retains durable run identity');
$recoveredHydration = $client->resumeWorkspace($hydrationState); errorCode(fn() => $recoveredHydration->path(), 'LOCAL_WORKSPACE_NOT_READY'); $recoveredHydration->reconcile(true);
check(file_get_contents($recoveredHydration->path() . '/new-base.txt') === 'new pinned base', 'Fresh client repairs incomplete hydration'); $recoveredHydration->abort('hydration done', true); $recoveredHydration->cleanup(true);
$checkpointPassed = true;

// Each subprocess exits after a real accepted HTTP request, before receiving its server identity.
foreach (['create', 'open', 'submission', 'upload', 'seal', 'finalize', 'abort', 'heartbeat'] as $target) {
    $parent = '/scratch/restart-' . $target; mkdir($parent, 0700);
    $process = proc_open([PHP_BINARY, '/tests/restart.php', $target, $parent, $checkpointId], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    fclose($pipes[0]); $stdout = stream_get_contents($pipes[1]); fclose($pipes[1]); $stderr = stream_get_contents($pipes[2]); fclose($pipes[2]);
    check(proc_close($process) === 75, "Restart fault $target must fire after real HTTP: $stdout $stderr");
    $records = glob($parent . '/contextvault-private-*/session.json'); check(count($records) === 1, 'Restart has one private recovery identity');
    $record = json_decode(file_get_contents($records[0]), true, 512, JSON_THROW_ON_ERROR); $pending = $record['state']['pendingCommand'];
    check($pending !== null && $pending['phase'] === 'dispatched', "Persist $target before HTTP dispatch");
    if ($target === 'create') check($record['state']['workspaceId'] === null && $record['state']['run'] === null, 'Creation identity is durable before server IDs exist');
    if ($target === 'open') check($record['state']['run'] === null, 'Open command survives before run ID exists');
    if (in_array($target, ['submission', 'upload', 'seal', 'finalize'], true)) file_put_contents($record['state']['path'] . '/restart.bin', 'MUTATED AFTER CRASH');
    if ($target === 'finalize') {
        $denied = new Client('invalid-test-key', getenv('CV_URL'), 0); $deniedSession = $denied->resumeWorkspace($records[0]);
        try { $deniedSession->reconcile(true); throw new RuntimeException('Expected authorization denial'); } catch (AuthError $error) { /* Current denial cannot disprove earlier acceptance. */ }
        $deniedRecord = $deniedSession->recovery();
        check($deniedRecord['state']['pendingCommand']['idempotencyKey'] === $pending['idempotencyKey'] && is_dir($deniedRecord['workflow']['capture']['directory']), 'Denied reconciliation retains original command and immutable capture');
        errorCode(fn() => $deniedSession->cleanup(true), 'RECONCILIATION_REQUIRED');
    }
    $resumed = $client->resumeWorkspace($records[0]); $resumed->reconcile(true);
    check($resumed->state()['pendingCommand'] === null, "Same-key $target reconciliation completes");
    if (in_array($target, ['submission', 'upload', 'seal', 'finalize'], true)) {
        check($resumed->status()['state'] === 'finalized', 'Restart completes original publication');
        $verify = readSession($client, $checkpointId);
        check(file_get_contents($verify->path() . '/restart.bin') === "original\0\xff" . $target, 'Restart publishes immutable original capture, not mutated local bytes');
        $verify->abort('restart verified', true); $verify->cleanup(true);
    } elseif ($target !== 'abort') {
        if ($target === 'heartbeat') check($resumed->status()['leaseVersion'] === 2, 'Lost heartbeat does not renew twice');
        $resumed->abort('restart done', true);
    } else check($resumed->status()['state'] === 'aborted', 'Lost abort response reconciles durable outcome');
    $resumed->cleanup(true);
}

$first = $client->openWorkspace($checkpointId, '/scratch'); $stale = $client->openWorkspace($checkpointId, '/scratch');
file_put_contents($first->path() . '/winner', 'winner'); $first->finalize(true); file_put_contents($stale->path() . '/stale', 'loser');
errorCode(fn() => $stale->finalize(true), 'REVISION_CONFLICT');
errorCode(fn() => $stale->finalize(true), 'REVISION_CONFLICT');
$stale = $client->resumeWorkspace($stale->recoveryPath()); errorCode(fn() => $stale->reconcile(true), 'REVISION_CONFLICT');
check($stale->status()['state'] === 'conflicted', 'Stale complete snapshot has known conflict'); $first->cleanup(true); $stale->cleanup(true);
$uncertainClient = new LossClient(getenv('CV_KEY_A'), getenv('CV_URL'), 0);
$uncertainStale = $uncertainClient->openWorkspace($checkpointId, '/scratch');
$winning = $client->openWorkspace($checkpointId, '/scratch'); file_put_contents($winning->path() . '/next-winner', 'winner'); $winning->finalize(true); $winning->cleanup(true);
file_put_contents($uncertainStale->path() . '/loser', 'never accepted'); $uncertainClient->loseOperation = true;
errorCode(fn() => $uncertainStale->finalize(true), 'PUBLICATION_OUTCOME_UNKNOWN');
check(is_string($uncertainStale->state()['pendingCommand']['operationId']), 'Unknown polling retains known operation identity');
$uncertainStale = $client->resumeWorkspace($uncertainStale->recoveryPath());
errorCode(fn() => $uncertainStale->reconcile(true), 'REVISION_CONFLICT');
check($uncertainStale->state()['pendingCommand'] === null && $uncertainStale->recovery()['workflow']['recoveryStatus'] === 'known-failed', 'Known failed operation resolves prior uncertainty');
$uncertainStale->cleanup(true);
$deadlineEvidence = verifyOperationDeadline($checkpointId);
$expiry = $client->openWorkspace($checkpointId, '/scratch'); usleep(12200000);
errorCode(fn() => $expiry->heartbeat(), 'RUN_EXPIRED'); check($expiry->status()['state'] === 'expired', 'Expired lease cannot be revived');
$expiry->cleanup(true);
$corruptPath = $stale->recoveryPath(); $original = file_get_contents($corruptPath); file_put_contents($corruptPath, '{partial');
errorCode(fn() => $client->resumeWorkspace($corruptPath), 'CORRUPT_LOCAL_STATE'); file_put_contents($corruptPath, $original);
$malformed = json_decode($original, true, 512, JSON_THROW_ON_ERROR); $malformed['state']['path'] = [];
file_put_contents($corruptPath, json_encode($malformed, JSON_THROW_ON_ERROR));
errorCode(fn() => $client->resumeWorkspace($corruptPath), 'CORRUPT_LOCAL_STATE'); file_put_contents($corruptPath, $original);
$generic = new LossClient(getenv('CV_KEY_A'), getenv('CV_URL'), 0); $genericSession = $generic->openWorkspace($checkpointId, '/scratch');
file_put_contents($genericSession->path() . '/generic', 'original generic response'); $generic->lose = '~/finalize$~'; $generic->genericFailure = true;
errorCode(fn() => $genericSession->finalize(true), 'PUBLICATION_OUTCOME_UNKNOWN');
check($genericSession->state()['pendingCommand'] !== null && is_dir($genericSession->recovery()['workflow']['capture']['directory']), 'Generic dispatch failure retains command and capture');
$genericSession = $client->resumeWorkspace($genericSession->recoveryPath()); $genericSession->reconcile(true); $genericSession->cleanup(true);
$forged = json_decode($original, true, 512, JSON_THROW_ON_ERROR); $forged['workflow']['captures'][] = '/scratch/unrelated';
file_put_contents($corruptPath, json_encode($forged, JSON_THROW_ON_ERROR));
errorCode(fn() => $client->resumeWorkspace($corruptPath), 'CORRUPT_LOCAL_STATE'); file_put_contents($corruptPath, $original);
$recovery = true;
$legacy = $client->workspaces()->create(getenv('CV_CUSTOMER_A'), 'php-wrapper');
$checkout = $client->workspaces()->checkout($legacy['id']);
check(is_dir($checkout['path']) && $checkout['sandboxPath'] === $checkout['path'], 'Compatibility checkout returns client-local aliases');
file_put_contents($checkout['path'] . '/wrapper.bin', "wrapper\0\xff");
errorCode(fn() => $client->workspaces()->commit($legacy['id']), 'WRITERS_NOT_STOPPED');
$commit = $client->workspaces()->commit($legacy['id'], ['writersStopped' => true]);
check($commit['status'] === 'merged' && $commit['outcome'] === 'finalized' && is_dir($checkout['path']), 'Compatibility commit checkpoints and preserves v1 outcome');
$pull = $client->workspaces()->pull($legacy['id']);
check(is_dir($pull['path']) && file_get_contents($pull['path'] . '/wrapper.bin') === "wrapper\0\xff", 'Compatibility pull exposes truthful local materialization');
$pull['handle']->finalize(true); $pull['handle']->cleanup(true);
$client->workspaces()->destroy($legacy['id'], true);
check(!is_dir($checkout['path']), 'Compatibility destroy explicitly aborts active next run and cleans local files');
$priorMissingSessions = glob(realpath(sys_get_temp_dir()) . '/contextvault-private-*/session.json');
errorCode(fn() => $client->workspaces()->getFile($legacy['id'], '../escape'), 'INVALID_MANIFEST');
check(glob(realpath(sys_get_temp_dir()) . '/contextvault-private-*/session.json') === $priorMissingSessions, 'Invalid getFile path opens no session');
try { $client->workspaces()->getFile($legacy['id'], 'missing.txt'); throw new RuntimeException('Expected missing file'); }
catch (ContextVaultException $error) { $missingRecoveryPath = $error->getRecoveryPath(); check(is_string($missingRecoveryPath), 'Missing getFile exposes its owned recovery identity'); }
$missingSession = $client->resumeWorkspace($missingRecoveryPath); $missingPath = $missingSession->path();
check($missingSession->status()['state'] === 'active' && $missingSession->state()['run']['mode'] === 'read-only', 'Missing-file failure retains its read-only run');
check(file_get_contents($missingPath . '/wrapper.bin') === "wrapper\0\xff", 'Fresh recovery reads the original pinned bytes after getFile failure');
$missingSession->abort('caller discards missing-file read'); $missingSession->cleanup(true); check(!is_dir($missingPath), 'Caller explicitly cleans the recovered missing-file session');
foreach ([false, true] as $lostFinalizeResponse) {
    $pollClient = new LossClient(getenv('CV_KEY_A'), getenv('CV_TIMEOUT_URL'), 0); $pollClient->signalPollDenial = true;
    $pollSession = $pollClient->openWorkspace($checkpointId, '/scratch'); $pollPath = $pollSession->path();
    $originalPollBytes = 'original poll-denial bytes ' . (int) $lostFinalizeResponse; file_put_contents($pollPath . '/poll-denial.txt', $originalPollBytes);
    if ($lostFinalizeResponse) { $pollClient->lose = '~/finalize$~'; errorCode(fn() => $pollSession->finalize(true), 'PUBLICATION_OUTCOME_UNKNOWN'); }
    try { $lostFinalizeResponse ? $pollSession->reconcile(true) : $pollSession->finalize(true); throw new RuntimeException('Expected first operation poll AuthError'); }
    catch (AuthError $error) { check($error->getErrorCode() === 'FORBIDDEN' && $error->getRecoveryPath() === $pollSession->recoveryPath(), 'Poll denial keeps typed AuthError and recovery identity'); }
    $pollRecord = $pollSession->recovery(); $pollPending = $pollRecord['state']['pendingCommand'];
    check(is_string($pollPending['operationId'] ?? null) && $pollPending['idempotencyKey'] === $pollClient->finalizeKeys[0], 'Denied poll preserves newly known operation and original key');
    check(count(array_unique($pollClient->finalizeKeys)) === 1 && is_dir($pollRecord['workflow']['capture']['directory']), 'Response-loss retry keeps original command source');
    errorCode(fn() => $pollSession->cleanup(true), 'RECONCILIATION_REQUIRED'); file_put_contents($pollPath . '/poll-denial.txt', 'MUTATED after denied poll');
    $readRecoveryClient = new LossClient(getenv('CV_KEY_A'), getenv('CV_TIMEOUT_URL'), 0); $pollSession = $readRecoveryClient->resumeWorkspace($pollSession->recoveryPath());
    check($pollSession->reconcile(true)['runState'] === 'finalized', 'Current read authority reconciles the accepted publication');
    check($readRecoveryClient->finalizeKeys === [] && array_unique($readRecoveryClient->operationReads) === ['/v1/operations/' . $pollPending['operationId']], 'Fresh reconciliation reads the same operation without POST');
    $pollReadback = readSession($client, $checkpointId); check(file_get_contents($pollReadback->path() . '/poll-denial.txt') === $originalPollBytes, 'Readback confirms original immutable bytes after poll denial');
    $pollReadback->abort('poll readback complete'); $pollReadback->cleanup(true); $pollSession->cleanup(true);
}
foreach (['before', 'after'] as $mode) {
    $cleanupCase = $client->openWorkspace($checkpointId, '/scratch'); $cleanupPath = $cleanupCase->path(); $cleanupCase->abort('owned-root interruption');
    $GLOBALS['cvCorrectionRoot'] = $cleanupPath; $GLOBALS['cvCorrectionRootMode'] = $mode; $GLOBALS['cvCorrectionRootFired'] = false;
    try { $cleanupCase->cleanup(true); throw new RuntimeException('Expected exact owned-root interruption'); } catch (RuntimeException $error) { check($GLOBALS['cvCorrectionRootFired'], 'The fault targets the exact owned root'); }
    $cleanupCase = $client->resumeWorkspace($cleanupCase->recoveryPath()); $cleanupCase->cleanup(true);
    check(!is_dir($cleanupPath), 'Fresh cleanup removes the root or recognizes completed removal');
}
$GLOBALS['cvCorrectionRoot'] = null;
$foreignCaptureCase = $client->openWorkspace($checkpointId, '/scratch');
$foreignDirectory = dirname($foreignCaptureCase->recoveryPath()) . '/capture-' . str_repeat('0', 32); mkdir($foreignDirectory, 0700); file_put_contents($foreignDirectory . '/foreign.txt', 'unknown ownership');
errorCode(fn() => $client->resumeWorkspace($foreignCaptureCase->recoveryPath()), 'UNSAFE_LOCAL_STATE');
check(file_get_contents($foreignDirectory . '/foreign.txt') === 'unknown ownership', 'Unknown private captures are retained for ownership investigation');
unlink($foreignDirectory . '/foreign.txt'); rmdir($foreignDirectory); $foreignCaptureCase->abort('foreign test complete'); $foreignCaptureCase->cleanup(true);
$metadataClient = new Client(getenv('CV_KEY_A'), getenv('CV_TIMEOUT_URL'), 0);
$metadataFixture = $metadataClient->request('GET', '/correction-metadata');
check(count(Manifest::canonical($metadataFixture)['entries']) === 9000, 'Real HTTP parses the legal nine-megabyte manifest fixture');
echo json_encode(['runtime' => PHP_VERSION, 'installed' => true, 'lifecycle' => $lifecycle, 'checkpoint' => $checkpointPassed, 'recovery' => $recovery,
    'httpMetadataFixture' => true, 'correctionWorkspaceId' => $checkpointId, 'checks' => $GLOBALS['checks']], JSON_THROW_ON_ERROR), "\n";

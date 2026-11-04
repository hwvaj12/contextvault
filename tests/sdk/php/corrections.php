<?php
declare(strict_types=1);
require __DIR__ . '/correction-faults.php';
require getenv('CV_PHP_AUTOLOAD') ?: __DIR__ . '/../../../sdk/php/vendor/autoload.php';

use ContextVault\{Client, LocalFiles, Manifest};
use ContextVault\Exception\{AuthError, ContextVaultException, NetworkError};

function correctionCheck(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
function correctionCode(callable $work, string $code): void {
    try { $work(); } catch (ContextVaultException $error) { correctionCheck($error->getErrorCode() === $code, $error->getErrorCode() . ' != ' . $code); return; }
    throw new RuntimeException('Expected ' . $code);
}
/** Controlled response fixture for focused local durability checks, separate from the real backend acceptance. */
final class CorrectionFixtureClient extends Client
{
    private string $runState = 'active';
    public bool $conflict = false;
    public int $denyPolls = 0;
    public bool $loseFinalizeResponse = false;
    public int $finalizePosts = 0;
    public array $operationReads = [];
    public array $finalizeKeys = [];
    public int $openCalls = 0;
    public int $denyOpens = 0;
    public array $openKeys = [];
    private array $run = ['id' => 'correction-run', 'workspaceId' => 'correction-workspace', 'baseRevisionId' => 'correction-base', 'version' => 1, 'mode' => 'read-write', 'leaseVersion' => 1];
    public function request(string $method, string $uri, array $options = []): mixed {
        if ($method === 'POST' && substr($uri, -5) === '/runs') {
            $this->openCalls++; $this->openKeys[] = $options['headers']['Idempotency-Key'];
            if ($this->denyOpens > 0) { $this->denyOpens--; throw new AuthError('Injected reopen denial', 403, ['error' => ['code' => 'FORBIDDEN', 'message' => 'Injected reopen denial']]); }
            $this->runState = 'active'; $this->run['mode'] = $options['json']['mode'];
        }
        if (substr($uri, -19) === '/workspace/manifest') return ['schemaVersion' => 1, 'entries' => []];
        if (substr($uri, -12) === '/submissions') return ['id' => 'correction-submission', 'manifestDigest' => null];
        if (strpos($uri, '/files?') !== false) {
            $query = []; parse_str(parse_url($uri, PHP_URL_QUERY), $query);
            return ['id' => 'correction-receipt', 'path' => $query['path'], 'sha256' => $options['headers']['X-Content-SHA256'], 'byteLength' => (int) $options['headers']['Content-Length']];
        }
        if (substr($uri, -5) === '/seal') return ['id' => 'correction-submission', 'manifestDigest' => Manifest::digest($options['json']['manifest'])];
        if (substr($uri, -9) === '/finalize') {
            $this->finalizePosts++; $this->finalizeKeys[] = $options['headers']['Idempotency-Key'];
            $this->runState = $this->conflict ? 'conflicted' : 'finalized';
            if ($this->loseFinalizeResponse) { $this->loseFinalizeResponse = false; throw new NetworkError('Injected lost finalize response'); }
            return ['id' => 'correction-operation', 'kind' => 'finalize', 'state' => 'processing', 'phase' => 'claimed'];
        }
        if (strpos($uri, '/v1/operations/') === 0) {
            $this->operationReads[] = $uri;
            if ($this->denyPolls > 0) { $this->denyPolls--; throw new AuthError('Injected operation read denial', 403, ['error' => ['code' => 'FORBIDDEN', 'message' => 'Injected operation read denial']]); }
            return $this->conflict
            ? ['id' => 'correction-operation', 'state' => 'failed', 'error' => ['code' => 'REVISION_CONFLICT', 'message' => 'Known conflict']]
            : ['id' => 'correction-operation', 'state' => 'succeeded', 'result' => ['kind' => 'finalize', 'runState' => 'finalized', 'revisionId' => 'correction-revision', 'changed' => true]];
        }
        if (substr($uri, -6) === '/abort') $this->runState = 'aborted';
        return $this->run + ['state' => $this->runState];
    }
}
function correctionClient(): CorrectionFixtureClient { return new CorrectionFixtureClient('synthetic-local-only', 'http://127.0.0.1', 0); }
final class CorrectionMetadataClient extends Client
{
    public string $metadata;
    protected function send(string $method, string $uri, array $options): Psr\Http\Message\ResponseInterface { return new GuzzleHttp\Psr7\Response(200, [], $this->metadata); }
}
final class ReopenPolicyClient extends Client
{
    public ?string $failAcceptedOpen = null;
    public ?string $inspectRetryState = null;
    public bool $clearedProofSeen = false;
    public array $openCommands = [];
    public array $openResponses = [];
    public int $finalizePosts = 0;
    public function request(string $method, string $uri, array $options = []): mixed
    {
        $opening = $method === 'POST' && substr($uri, -5) === '/runs';
        if ($opening) {
            $this->openCommands[] = ['key' => $options['headers']['Idempotency-Key'], 'body' => $options['json']];
            if ($this->inspectRetryState !== null) {
                $record = json_decode(file_get_contents($this->inspectRetryState), true, 512, JSON_THROW_ON_ERROR);
                correctionCheck($record['workflow']['reopenRejectionProof'] === null && $record['workflow']['reopenAcceptancePossible'] === true
                    && $record['state']['pendingCommand']['phase'] === 'dispatched', 'Clear rejection proof on disk before the retry reaches HTTP');
                $this->clearedProofSeen = true;
            }
        }
        if ($method === 'POST' && substr($uri, -9) === '/finalize') $this->finalizePosts++;
        $response = parent::request($method, $uri, $options);
        if ($opening) {
            $this->openResponses[] = $response;
            if ($this->failAcceptedOpen === 'auth') { $this->failAcceptedOpen = null; throw new AuthError('Fabricated rejection after accepted open', 403, ['error' => ['code' => 'FORBIDDEN']]); }
            if ($this->failAcceptedOpen === 'network') { $this->failAcceptedOpen = null; throw new NetworkError('Lost accepted reopen response'); }
        }
        return $response;
    }
}
function reopenPolicyClient(): ReopenPolicyClient { return new ReopenPolicyClient(getenv('CV_KEY_A'), getenv('CV_TIMEOUT_URL'), 0); }
function setReopenPolicy(Client $client, string $id, string $mode): void { $client->request('GET', '/correction-reopen-policy?' . http_build_query(['workspace' => $id, 'mode' => $mode])); }
function rejectedCheckpoint(ReopenPolicyClient $client, string $label): array
{
    $session = $client->createWorkspace(getenv('CV_CUSTOMER_A'), 'php-reopen-' . $label, realpath(sys_get_temp_dir()));
    file_put_contents($session->path() . '/accepted.bin', "accepted-reopen\0\xff" . $label); $id = $session->state()['workspaceId'];
    setReopenPolicy($client, $id, 'deny'); correctionCode(fn() => $session->checkpoint(true), 'FORBIDDEN');
    $record = $session->recovery(); $pending = $record['state']['pendingCommand']; $receipt = $record['workflow']['acceptedCheckpoint'];
    correctionCheck($record['workflow']['recoveryStatus'] === 'published-needs-reopen' && $pending['kind'] === 'run:open', 'Keep original pending reopen after rejection');
    correctionCheck($receipt['result']['runState'] === 'finalized' && $receipt['operation']['state'] === 'succeeded'
        && $receipt['operation']['id'] !== '' && count($receipt['receipts']) === 1 && $record['workflow']['lastResult'] === $receipt['result'], 'Preserve accepted revision, operation, and receipt');
    correctionCheck($record['workflow']['reopenRejectionProof']['provenance'] === 'guzzle-http-response-v1' && $record['workflow']['reopenAcceptancePossible'] === false, 'Only genuine first HTTP rejection permits local abandonment');
    correctionCode(fn() => $session->cleanup(true), 'RECONCILIATION_REQUIRED');
    return [$session, $id, $pending, $receipt];
}
if (($argv[1] ?? '') === 'reopen-policy') {
    correctionCheck(PHP_VERSION === '8.0.30', 'Reopen policy must execute the installed PHP 8.0.30 client');
    correctionCheck(strpos((new ReflectionClass(Client::class))->getFileName(), '/artifact/vendor/contextvault/contextvault-php/') === 0, 'Use the Composer-installed artifact');
    $results = [];
    $client = reopenPolicyClient(); [$session, $id, $pending, $receipt] = rejectedCheckpoint($client, 'retry');
    $path = $session->state()['path']; file_put_contents($path . '/accepted.bin', 'MUTATED after known publication'); setReopenPolicy($client, $id, 'allow');
    $fresh = reopenPolicyClient(); $session = $fresh->resumeWorkspace($session->recoveryPath()); $fresh->inspectRetryState = $session->recoveryPath(); $session->reconcile(true);
    correctionCheck($fresh->clearedProofSeen && $fresh->openCommands === [['key' => $pending['idempotencyKey'], 'body' => $pending['request']['body']]] && $fresh->finalizePosts === 0, 'Retry only the exact original reopen after permission restoration');
    correctionCheck($session->path() === $path && file_get_contents($path . '/accepted.bin') === "accepted-reopen\0\xffretry" && $session->recovery()['workflow']['acceptedCheckpoint'] === $receipt, 'Refresh pinned accepted bytes and retain receipt');
    $session->abort('reopen retry verified'); $session->cleanup(true); $results['restoredPermissionRetry'] = true;

    $client = reopenPolicyClient(); [$session, $id, $pending, $receipt] = rejectedCheckpoint($client, 'abandon'); $path = $session->state()['path'];
    correctionCode(fn() => $session->abandonReopen(), 'WRITERS_NOT_STOPPED');
    correctionCheck($session->abandonReopen(true) === $receipt && is_dir($path), 'Abandon locally only after stopped writers and proven rejection');
    $record = $session->recovery(); correctionCheck($record['workflow']['abandonedReopen']['command']['idempotencyKey'] === $pending['idempotencyKey']
        && $record['workflow']['acceptedCheckpoint'] === $receipt && $record['state']['pendingCommand'] === null, 'Archive original open command without losing publication');
    correctionCheck($session->status()['state'] === 'finalized', 'Local abandonment never aborts the accepted run');
    $session->cleanup(true); correctionCheck(!is_dir($path), 'Explicit cleanup can follow a proven rejected reopen'); $results['provenRejectionAbandonment'] = true;

    $client = reopenPolicyClient(); $session = $client->createWorkspace(getenv('CV_CUSTOMER_A'), 'php-reopen-fabricated', realpath(sys_get_temp_dir()));
    $id = $session->state()['workspaceId']; file_put_contents($session->path() . '/accepted.bin', 'accepted before fabricated rejection'); setReopenPolicy($client, $id, 'allow');
    $client->failAcceptedOpen = 'auth'; correctionCode(fn() => $session->checkpoint(true), 'FORBIDDEN'); $record = $session->recovery();
    correctionCheck($record['workflow']['reopenRejectionProof'] === null && $record['workflow']['reopenAcceptancePossible'] === true, 'A fabricated typed error cannot prove rejected HTTP');
    correctionCode(fn() => $session->abandonReopen(true), 'RECONCILIATION_REQUIRED'); correctionCode(fn() => $session->cleanup(true), 'RECONCILIATION_REQUIRED');
    $acceptedRunId = end($client->openResponses)['id']; $originalKey = $record['state']['pendingCommand']['idempotencyKey'];
    $fresh = reopenPolicyClient(); $session = $fresh->resumeWorkspace($session->recoveryPath()); $session->reconcile(true);
    correctionCheck($session->state()['run']['id'] === $acceptedRunId && $fresh->openCommands[0]['key'] === $originalKey && $fresh->finalizePosts === 0, 'Recover the accepted original reopen after fabricated rejection');
    $session->abort('fabricated rejection reconciled'); $session->cleanup(true); $results['fabricatedRejectionProtected'] = true;

    $client = reopenPolicyClient(); [$session, $id, $pending, $receipt] = rejectedCheckpoint($client, 'lost-retry'); setReopenPolicy($client, $id, 'allow');
    $retry = reopenPolicyClient(); $session = $retry->resumeWorkspace($session->recoveryPath()); $retry->inspectRetryState = $session->recoveryPath(); $retry->failAcceptedOpen = 'network';
    correctionCode(fn() => $session->reconcile(true), 'PUBLICATION_OUTCOME_UNKNOWN'); $record = $session->recovery(); $acceptedRunId = end($retry->openResponses)['id'];
    correctionCheck($retry->clearedProofSeen && $record['workflow']['reopenRejectionProof'] === null && $record['workflow']['reopenAcceptancePossible'] === true, 'Lost accepted retry cannot retain the previous rejection proof');
    $fresh = reopenPolicyClient(); $session = $fresh->resumeWorkspace($session->recoveryPath()); correctionCode(fn() => $session->abandonReopen(true), 'RECONCILIATION_REQUIRED');
    setReopenPolicy($fresh, $id, 'deny'); correctionCode(fn() => $session->reconcile(true), 'FORBIDDEN');
    correctionCheck($session->recovery()['workflow']['reopenRejectionProof'] === null, 'A later real denial cannot disprove the earlier unknown acceptance');
    correctionCode(fn() => $session->cleanup(true), 'RECONCILIATION_REQUIRED'); correctionCode(fn() => $session->abandonReopen(true), 'RECONCILIATION_REQUIRED');
    setReopenPolicy($fresh, $id, 'allow'); $session->reconcile(true);
    correctionCheck($session->state()['run']['id'] === $acceptedRunId && $session->recovery()['workflow']['acceptedCheckpoint'] === $receipt && $fresh->finalizePosts === 0, 'Restore the same accepted reopen and preserve checkpoint publication');
    foreach ($fresh->openCommands as $command) correctionCheck($command === ['key' => $pending['idempotencyKey'], 'body' => $pending['request']['body']], 'Every retry keeps the exact original open request and key');
    $session->abort('lost reopen reconciled'); $session->cleanup(true); $results['lostAcceptedRetryProtected'] = true;
    echo json_encode(['runtime' => PHP_VERSION, 'installed' => true, 'reopenPolicy' => $results], JSON_THROW_ON_ERROR), "\n"; exit;
}

if (($argv[1] ?? '') === 'capture-worker') {
    $client = getenv('CV_CORRECTION_REAL_HTTP') === '1' ? new Client(getenv('CV_KEY_A'), getenv('CV_URL'), 0) : correctionClient();
    $session = $client->openWorkspace($argv[2], $argv[3]);
    file_put_contents($session->path() . '/private.txt', str_repeat('PRIVATE-CAPTURE-', 69905));
    echo json_encode(['recoveryPath' => $session->recoveryPath()]), "\n"; flush();
    $GLOBALS['cvCorrectionCapturePause'] = $argv[3] . '/capture-ready';
    $session->finalize(true); throw new RuntimeException('Capture kill did not fire');
}
if (($argv[1] ?? '') === 'capture-resume') {
    $client = new Client(getenv('CV_KEY_A'), getenv('CV_URL'), 0);
    $session = $client->resumeWorkspace($argv[2]); $record = $session->recovery();
    correctionCheck(count($record['workflow']['captures']) === 1, 'Capture ownership must precede the first payload byte');
    $session->abort('discard interrupted capture'); $session->cleanup(true);
    correctionCheck(glob(dirname($argv[2]) . '/capture-*') === [], 'Cleanup must remove interrupted private captures');
    echo json_encode(['captureCrashRecovered' => true]), "\n"; exit;
}

$parent = LocalFiles::unique(realpath(sys_get_temp_dir()), 'cv-correction-'); $results = [];
try {
    $tests = [
        'checkpointReopenRejection' => function () use ($parent): void {
            $client = correctionClient(); $session = $client->openWorkspace('correction-workspace', $parent); $client->denyOpens = 1;
            correctionCode(fn() => $session->checkpoint(true), 'FORBIDDEN'); $record = $session->recovery();
            correctionCheck($record['workflow']['recoveryStatus'] === 'published-needs-reopen' && $record['state']['pendingCommand']['kind'] === 'run:open', 'A rejected reopen must retain the checkpoint and original pending open');
            $pending = $record['state']['pendingCommand']; $receipt = $record['workflow']['acceptedCheckpoint'];
            correctionCheck($receipt['result']['runState'] === 'finalized' && $receipt['operation']['id'] === 'correction-operation', 'Accepted checkpoint result and operation survive reopen denial');
            correctionCode(fn() => $session->abandonReopen(true), 'RECONCILIATION_REQUIRED');
            $session = $client->resumeWorkspace($session->recoveryPath()); $session->reconcile(true);
            correctionCheck(array_slice($client->openKeys, -2) === [$pending['idempotencyKey'], $pending['idempotencyKey']], 'Permission restoration retries the exact original open key');
            correctionCheck($client->finalizePosts === 1 && $session->recovery()['workflow']['acceptedCheckpoint'] === $receipt, 'Retry never republishes or discards accepted checkpoint receipt');
            $session->abort('reopen fixture complete'); $session->cleanup(true);
        },
        'missingFileRecoveryIdentity' => function (): void {
            $client = correctionClient(); $opens = $client->openCalls;
            correctionCode(fn() => $client->workspaces()->getFile('correction-workspace', '../escape'), 'INVALID_MANIFEST');
            correctionCheck($client->openCalls === $opens, 'Reject nonportable file paths before opening a session');
            $prior = glob(realpath(sys_get_temp_dir()) . '/contextvault-private-*/session.json'); $recoveryPath = null;
            try { $client->workspaces()->getFile('correction-workspace', 'missing.txt'); throw new RuntimeException('Expected missing local file'); }
            catch (ContextVaultException $error) { $recoveryPath = $error->getRecoveryPath(); }
            try {
                correctionCheck(is_string($recoveryPath) && is_file($recoveryPath), 'Missing getFile must expose its owned recovery identity');
                $session = $client->resumeWorkspace($recoveryPath); $path = $session->path();
                correctionCheck($session->status()['state'] === 'active' && $session->state()['run']['mode'] === 'read-only', 'Error preserves a readable active read-only session');
                correctionCheck($session->manifest()['entries'] === [], 'Recovery reads the original pinned metadata');
                $session->abort('missing-file caller cleanup'); $session->cleanup(true);
                correctionCheck(!is_dir($path), 'Caller explicitly aborts and cleans the recovered session');
            } finally {
                // This fixture owns every identity created by its one call, including the expected failing pre-fix run.
                foreach (array_diff(glob(realpath(sys_get_temp_dir()) . '/contextvault-private-*/session.json'), $prior) as $ownedState) {
                    $owned = $client->resumeWorkspace($ownedState);
                    if ($owned->state()['path'] !== null) { $owned->abort('owned fixture cleanup'); $owned->cleanup(true); }
                    LocalFiles::clear(dirname($ownedState), true);
                }
            }
        },
        'operationPollDenial' => function () use ($parent): void {
            foreach ([false, true] as $loseResponse) {
                $client = correctionClient(); $session = $client->openWorkspace('correction-workspace', $parent);
                file_put_contents($session->path() . '/original.txt', 'immutable original');
                if ($loseResponse) {
                    $client->loseFinalizeResponse = true; correctionCode(fn() => $session->finalize(true), 'PUBLICATION_OUTCOME_UNKNOWN');
                }
                $client->denyPolls = 1;
                try { $loseResponse ? $session->reconcile(true) : $session->finalize(true); throw new RuntimeException('Expected operation read AuthError'); }
                catch (AuthError $error) { correctionCheck($error->getErrorCode() === 'FORBIDDEN', 'Keep the typed read-denial error'); }
                $record = $session->recovery(); $pending = $record['state']['pendingCommand'];
                correctionCheck($pending !== null && $pending['operationId'] === 'correction-operation', 'A denied first poll must retain the newly known operation');
                correctionCheck($pending['phase'] === 'outcome-unknown' && is_dir($record['workflow']['capture']['directory']), 'Poll denial retains exact command and captured source');
                correctionCode(fn() => $session->cleanup(true), 'RECONCILIATION_REQUIRED');
                $posts = $client->finalizePosts; $session = $client->resumeWorkspace($session->recoveryPath());
                correctionCheck($session->reconcile(true)['runState'] === 'finalized', 'Current read authority reconciles the recorded operation');
                correctionCheck($client->finalizePosts === $posts && count(array_unique($client->finalizeKeys)) === 1, 'Known-operation reconciliation sends no new mutation');
                correctionCheck(count(array_unique($client->operationReads)) === 1, 'Reconcile the same durable operation identity');
                $session->cleanup(true);
            }
        },
        'terminalFailureReplay' => function () use ($parent): void {
            $client = correctionClient();
            $session = $client->openWorkspace('correction-workspace', $parent);
            $session->checkpoint(true); $client->conflict = true;
            correctionCode(fn() => $session->finalize(true), 'REVISION_CONFLICT');
            $resumed = $client->resumeWorkspace($session->recoveryPath());
            correctionCode(fn() => $resumed->finalize(true), 'REVISION_CONFLICT');
            correctionCode(fn() => $resumed->reconcile(true), 'REVISION_CONFLICT');
            correctionCheck($resumed->status()['state'] === 'conflicted', 'Remote failure stays terminal'); $resumed->cleanup(true);
        },
        'captureOwnershipBeforeBytes' => function () use ($parent): void {
            $root = LocalFiles::unique($parent, 'capture-case-');
            $process = proc_open([PHP_BINARY, '-d', 'memory_limit=512M', __FILE__, 'capture-worker', 'correction-workspace', $root], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            fclose($pipes[0]); stream_set_blocking($pipes[1], false); $output = ''; $deadline = microtime(true) + 5;
            while (microtime(true) < $deadline && !is_file($root . '/capture-ready')) { $output .= stream_get_contents($pipes[1]); usleep(1000); }
            correctionCheck(is_file($root . '/capture-ready'), 'Reach a capture with actual private bytes');
            proc_terminate($process, 9); $output .= stream_get_contents($pipes[1]); fclose($pipes[1]); fclose($pipes[2]); proc_close($process);
            $statePath = json_decode(trim($output), true, 512, JSON_THROW_ON_ERROR)['recoveryPath'];
            $session = correctionClient()->resumeWorkspace($statePath); $record = $session->recovery();
            $tracked = count($record['workflow']['captures']) === 1;
            $session->abort('discard killed capture'); $session->cleanup(true);
            correctionCheck($tracked && glob(dirname($statePath) . '/capture-*') === [], 'Interrupted capture bytes need durable ownership and complete cleanup');
        },
        'interruptedRootRemoval' => function () use ($parent): void {
            foreach (['before', 'after'] as $mode) {
                $client = correctionClient(); $session = $client->openWorkspace('correction-workspace', $parent); $path = $session->path(); $session->abort('cleanup fixture');
                $GLOBALS['cvCorrectionRoot'] = $path; $GLOBALS['cvCorrectionRootMode'] = $mode; $GLOBALS['cvCorrectionRootFired'] = false;
                try { $session->cleanup(true); throw new RuntimeException('Expected root removal interruption'); } catch (RuntimeException $error) { correctionCheck($GLOBALS['cvCorrectionRootFired'], 'Inject only the exact owned root'); }
                $session = $client->resumeWorkspace($session->recoveryPath()); $session->cleanup(true);
                correctionCheck(!is_dir($path), 'Retry must remove an owned root or recognize its completed removal');
            }
            $GLOBALS['cvCorrectionRoot'] = null;
        },
        'legalMetadataBudgets' => function () use ($parent): void {
            $prefix = str_repeat('a', 220) . '/' . str_repeat('b', 220) . '/' . str_repeat('c', 220) . '/'; $entries = [];
            for ($i = 0; $i < 9000; $i++) $entries[] = ['path' => $prefix . str_repeat('d', 210) . sprintf('%08d', $i), 'kind' => 'file', 'byteLength' => 0, 'sha256' => hash('sha256', '')];
            $manifest = Manifest::canonical(['schemaVersion' => 1, 'entries' => $entries]); $path = $parent . '/legal-metadata.json';
            LocalFiles::atomicJson($path, ['manifest' => $manifest]); correctionCheck(filesize($path) > 8 * 1024 * 1024, 'Regression fixture exceeds the old unrelated cap');
            correctionCheck(LocalFiles::readJson($path)['manifest'] === $manifest, 'Every successful metadata write must remain readable');
            $http = new CorrectionMetadataClient('synthetic-local-only', 'http://127.0.0.1', 0); $http->metadata = Manifest::bytes($manifest);
            correctionCheck($http->request('GET', '/fixture-metadata') === $manifest, 'HTTP JSON parsing supports the same legal manifest budget');
            $safe = $parent . '/previous-readable.json'; LocalFiles::atomicJson($safe, ['saved' => 'original'], 128);
            correctionCode(fn() => LocalFiles::atomicJson($safe, ['oversized' => str_repeat('x', 129)], 128), 'QUOTA_EXCEEDED');
            correctionCheck(LocalFiles::readJson($safe, 128) === ['saved' => 'original'], 'Oversized saves preserve the previous readable journal before dispatch');
        },
        'checkpointHistoryAccounting' => function () use ($parent): void {
            $client = correctionClient(); $session = $client->openWorkspace('correction-workspace', $parent);
            for ($i = 0; $i < 24; $i++) {
                file_put_contents($session->path() . '/checkpoint.txt', 'checkpoint-' . $i); $session->checkpoint(true);
                correctionCheck($session->recovery()['workflow']['captures'] === [], 'Known checkpoints retire their owned capture history');
                correctionCheck(filesize($session->recoveryPath()) < 32768, 'Successful checkpoints keep bounded journal history');
            }
            $session->abort('history checked'); correctionCheck(($session->reconcile(true)['state'] ?? null) === 'aborted', 'A later abort must supersede the earlier checkpoint result'); $session->cleanup(true);
        },
    ];
    foreach ($tests as $name => $test) {
        try { $test(); $results[$name] = ['passed' => true]; }
        catch (Throwable $error) { $results[$name] = ['passed' => false, 'error' => get_class($error) . ': ' . $error->getMessage()]; }
    }
} finally { $GLOBALS['cvCorrectionRoot'] = null; LocalFiles::clear($parent, true); }
echo json_encode($results, JSON_THROW_ON_ERROR), "\n";
exit(count(array_filter($results, static fn(array $result): bool => !$result['passed'])) ? 1 : 0);

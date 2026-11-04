<?php
declare(strict_types=1);
namespace ContextVault;

use ContextVault\Exception\{ContextVaultException, NetworkError, OutcomeUnknownError};

/** Durable session for ordinary, separately managed agents. Never starts or stops writers. */
final class WorkspaceSession
{
    private Client $client;
    private string $statePath;
    private array $record;
    private ?array $captureManifestCache = null;
    private ?string $captureManifestCacheKey = null;
    private $lock = null;
    private function __construct(Client $client, string $statePath, array $record) { $this->client = $client; $this->statePath = $statePath; $this->record = $record; }

    public static function create(Client $client, ?string $workspaceId, ?string $parent, array $runOptions, ?array $creation = null): self
    {
        $parent = $parent ?? realpath(sys_get_temp_dir()); LocalFiles::directory($parent);
        $request = array_replace(['mode' => 'read-write', 'agentLabel' => 'php-client', 'task' => 'workspace session', 'reason' => 'caller requested workspace'], $runOptions);
        if (array_diff_key($request, array_flip(['mode', 'agentLabel', 'task', 'reason'])) || !in_array($request['mode'], ['read-only', 'read-write'], true)) Manifest::fail('INVALID_REQUEST', 'Invalid run options');
        foreach (['agentLabel', 'task', 'reason'] as $field) if (!is_string($request[$field]) || $request[$field] === '') Manifest::fail('INVALID_REQUEST', 'Run labels must be nonempty strings');
        $private = LocalFiles::unique($parent, 'contextvault-private-'); $path = LocalFiles::unique($parent, 'contextvault-workspace-');
        $statePath = $private . '/session.json';
        $state = ['schemaVersion' => 1, 'sessionId' => Client::key(), 'serverOrigin' => $client->getBaseUrl(), 'workspaceId' => $workspaceId,
            'run' => null, 'path' => $path, 'privateStatePath' => $statePath, 'state' => 'provisioning', 'pendingCommand' => null];
        $workflow = ['action' => 'open', 'stage' => $creation === null ? 'open' : 'create', 'runRequest' => $request, 'creation' => $creation,
            'runView' => null, 'capture' => null, 'captures' => [], 'captureIdentities' => [], 'receipts' => [], 'submission' => null, 'uploadIndex' => 0,
            'lastResult' => null, 'acceptedCheckpoint' => null, 'terminalFailure' => null, 'reopenAttempts' => 0,
            'reopenAcceptancePossible' => false, 'reopenRejectionProof' => null,
            'recoveryStatus' => 'provisioning', 'localCleanup' => ['state' => 'pending', 'lastError' => null],
            'workspaceIdentity' => LocalFiles::identity($path), 'privateIdentity' => LocalFiles::identity($private), 'hydration' => null, 'hydrationIdentity' => null];
        $session = new self($client, $statePath, ['schemaVersion' => 1, 'state' => $state, 'workflow' => $workflow]); $session->save(); return $session;
    }
    public static function load(Client $client, string $statePath): self
    {
        $record = LocalFiles::readJson($statePath, Manifest::metadataBudget($client->limits(), true));
        $session = new self($client, $statePath, $record); $session->validate(); return $session;
    }
    private function validate(): void
    {
        $s = $this->record['state'] ?? []; $w = $this->record['workflow'] ?? [];
        $fields = ['schemaVersion', 'sessionId', 'serverOrigin', 'workspaceId', 'run', 'path', 'privateStatePath', 'state', 'pendingCommand'];
        if (!is_array($s) || count($s) !== count($fields) || array_diff($fields, array_keys($s))
            || (!is_string($s['path']) && $s['path'] !== null) || (!is_string($s['workspaceId']) && $s['workspaceId'] !== null)
            || (!is_array($s['run']) && $s['run'] !== null) || !in_array($s['state'], ['provisioning', 'ready', 'failed'], true)) Manifest::fail('CORRUPT_LOCAL_STATE', 'Invalid client-state fields; retain local files');
        if (($this->record['schemaVersion'] ?? null) !== 1 || ($s['schemaVersion'] ?? null) !== 1 || !is_string($s['sessionId'] ?? null) || ($s['privateStatePath'] ?? null) !== $this->statePath || ($s['serverOrigin'] ?? null) !== $this->client->getBaseUrl() || !is_array($w) || !is_string($w['privateIdentity'] ?? null)) Manifest::fail('CORRUPT_LOCAL_STATE', 'Invalid recovery identity or server origin; retain local files');
        if (!in_array($w['action'] ?? null, [null, 'open', 'finalize', 'checkpoint', 'abort', 'heartbeat'], true) || !is_string($w['stage'] ?? null)) Manifest::fail('CORRUPT_LOCAL_STATE', 'Invalid workflow state');
        if ($s['run'] !== null) {
            $run = $s['run'];
            foreach (['id', 'workspaceId', 'baseRevisionId'] as $field) if (!is_string($run[$field] ?? null) || $run[$field] === '') Manifest::fail('CORRUPT_LOCAL_STATE', 'Invalid saved run identity');
            if (!is_int($run['version'] ?? null) || $run['version'] < 1 || !in_array($run['mode'] ?? null, ['read-only', 'read-write'], true) || $run['workspaceId'] !== $s['workspaceId']) Manifest::fail('CORRUPT_LOCAL_STATE', 'Invalid saved run version or mode');
        }
        LocalFiles::directory(dirname($this->statePath));
        if (LocalFiles::identity(dirname($this->statePath)) !== $w['privateIdentity'] || (fileperms(dirname($this->statePath)) & 0777) !== 0700) Manifest::fail('UNSAFE_LOCAL_STATE', 'Private directory ownership or permissions changed');
        if (!is_array($w['captures'] ?? null) || !is_array($w['captureIdentities'] ?? null)) Manifest::fail('CORRUPT_LOCAL_STATE', 'Invalid owned capture references');
        foreach ($w['captures'] as $capture) {
            if (!$this->privateChild($capture, 'capture-') || !is_string($w['captureIdentities'][$capture] ?? null)) Manifest::fail('CORRUPT_LOCAL_STATE', 'Capture reference escapes its owned private directory');
            if (file_exists($capture) || is_link($capture)) {
                LocalFiles::directory($capture);
                if (LocalFiles::identity($capture) !== $w['captureIdentities'][$capture]) Manifest::fail('UNSAFE_LOCAL_STATE', 'Capture directory identity changed');
            }
        }
        $names = scandir(dirname($this->statePath));
        if ($names === false) Manifest::fail('LOCAL_IO_ERROR', 'Cannot inspect owned private artifacts');
        foreach ($names as $name) {
            if (strncmp($name, 'capture-', 8) === 0 && !in_array(dirname($this->statePath) . '/' . $name, $w['captures'], true)) Manifest::fail('UNSAFE_LOCAL_STATE', 'Untracked private capture requires ownership investigation; retained without deletion');
        }
        if (($w['hydration'] ?? null) !== null) {
            if (!$this->privateChild($w['hydration'], 'hydration-')) Manifest::fail('CORRUPT_LOCAL_STATE', 'Hydration reference escapes its private directory');
            if (file_exists($w['hydration']) || is_link($w['hydration'])) {
                LocalFiles::directory($w['hydration']);
                if (LocalFiles::identity($w['hydration']) !== ($w['hydrationIdentity'] ?? null)) Manifest::fail('UNSAFE_LOCAL_STATE', 'Hydration identity changed');
            }
        }
        if ($s['path'] !== null) {
            $removedDuringCleanup = !file_exists($s['path']) && !is_link($s['path'])
                && in_array($w['localCleanup']['state'] ?? null, ['running', 'failed'], true)
                && ($w['localCleanup']['rootPath'] ?? null) === $s['path'] && ($w['localCleanup']['rootIdentity'] ?? null) === $w['workspaceIdentity'];
            if (!$removedDuringCleanup) {
                LocalFiles::directory($s['path']);
                if (LocalFiles::identity($s['path']) !== ($w['workspaceIdentity'] ?? null)) Manifest::fail('UNSAFE_LOCAL_STATE', 'Workspace ownership changed');
            }
            if (strncmp(dirname($this->statePath) . '/', $s['path'] . '/', strlen($s['path']) + 1) === 0) Manifest::fail('UNSAFE_LOCAL_STATE', 'Workspace contains private state');
        }
        $pending = $s['pendingCommand'] ?? null;
        if ($pending !== null && (!is_array($pending) || !is_string($pending['idempotencyKey'] ?? null) || !is_array($pending['request'] ?? null) || !in_array($pending['phase'] ?? null, ['prepared', 'dispatched', 'outcome-unknown'], true))) Manifest::fail('CORRUPT_LOCAL_STATE', 'Invalid pending command; retain local files');
        if ($pending !== null) {
            $kinds = ['create' => 'workspace:create', 'open' => 'run:open', 'reopen' => 'run:open', 'submission' => 'submission:create', 'upload' => 'submission:file', 'seal' => 'submission:seal', 'finalize' => 'finalize', 'abort' => 'abort', 'heartbeat' => 'run:heartbeat'];
            if (($kinds[$w['stage']] ?? null) !== ($pending['kind'] ?? null)) Manifest::fail('CORRUPT_LOCAL_STATE', 'Pending authority differs from its durable workflow stage');
        }
        if ($pending !== null && ($pending['kind'] ?? null) === 'submission:file') {
            $entry = $this->captureManifest()['entries'][$w['uploadIndex']] ?? null; $capture = $pending['request']['capture'] ?? [];
            if (!is_array($entry) || ($entry['kind'] ?? null) !== 'file' || !in_array($w['capture']['directory'] ?? null, $w['captures'], true)
                || ($capture['privateFilePath'] ?? null) !== $w['capture']['directory'] . '/' . $entry['path'] || ($capture['byteLength'] ?? null) !== $entry['byteLength'] || ($capture['sha256'] ?? null) !== $entry['sha256']) Manifest::fail('CORRUPT_LOCAL_STATE', 'Pending upload lost its original immutable capture identity');
        }
    }
    private function privateChild($path, string $prefix): bool
    {
        return is_string($path) && dirname($path) === dirname($this->statePath) && preg_match('/^' . preg_quote($prefix, '/') . '[a-f0-9]{32}$/D', basename($path)) === 1;
    }
    private function save(): void
    {
        $record = $this->record;
        if (($record['state']['pendingCommand']['request']['body'] ?? null) === []) $record['state']['pendingCommand']['request']['body'] = new \stdClass();
        LocalFiles::atomicJson($this->statePath, $record, Manifest::metadataBudget($this->client->limits(), true));
    }
    private function locked(callable $work)
    {
        LocalFiles::directory(dirname($this->statePath)); $lockPath = dirname($this->statePath) . '/lock';
        if (!file_exists($lockPath) && !is_link($lockPath)) { $file = LocalFiles::createFile($lockPath); fclose($file); }
        $this->lock = LocalFiles::openRegular(dirname($lockPath), basename($lockPath));
        if (!flock($this->lock, LOCK_EX | LOCK_NB)) { fclose($this->lock); $this->lock = null; Manifest::fail('LOCAL_SESSION_BUSY', 'Another client owns this local session'); }
        try { $this->record = LocalFiles::readJson($this->statePath, Manifest::metadataBudget($this->client->limits(), true)); $this->validate(); return $work(); }
        finally { flock($this->lock, LOCK_UN); fclose($this->lock); $this->lock = null; }
    }
    public function recoveryPath(): string { return $this->statePath; }
    public function state(): array { $this->record = LocalFiles::readJson($this->statePath, Manifest::metadataBudget($this->client->limits(), true)); $this->validate(); return $this->record['state']; }
    public function recovery(): array { $this->state(); return $this->record; }
    public function path(): string
    {
        $state = $this->state();
        if ($state['path'] === null || $state['state'] !== 'ready' || $this->record['workflow']['recoveryStatus'] !== 'ready') Manifest::fail('LOCAL_WORKSPACE_NOT_READY', 'Reconcile this recovery identity before starting writers: ' . $this->statePath);
        return $state['path'];
    }
    private static function stopped(bool $stopped): void { if (!$stopped) Manifest::fail('WRITERS_NOT_STOPPED', 'The caller must stop all local agent writers first'); }
    /** Pinned metadata stays in one bounded private file, outside workspace contents and the workflow journal. */
    public function manifest(): array
    {
        return $this->locked(function (): array {
            if ($this->record['state']['state'] !== 'ready' || $this->record['state']['path'] === null) Manifest::fail('LOCAL_WORKSPACE_NOT_READY', 'Pinned metadata requires completed materialization');
            $reference = $this->record['workflow']['baseManifestRef'] ?? null;
            if ($reference === null && isset($this->record['workflow']['baseManifest'])) return Manifest::canonical($this->record['workflow']['baseManifest'], $this->client->limits());
            if (!is_array($reference) || ($reference['path'] ?? null) !== dirname($this->statePath) . '/base-manifest.json') Manifest::fail('CORRUPT_LOCAL_STATE', 'Missing pinned manifest reference');
            return $this->verifiedManifest($reference['path'], $reference['digest']);
        });
    }
    private function verifiedManifest(string $path, string $digest): array
    {
        $manifest = Manifest::canonical(LocalFiles::readJson($path, Manifest::metadataBudget($this->client->limits())), $this->client->limits());
        if (Manifest::digest($manifest, $this->client->limits()) !== $digest) Manifest::fail('CORRUPT_LOCAL_STATE', 'Private manifest digest changed');
        return $manifest;
    }
    private function captureManifest(): array
    {
        $capture = $this->record['workflow']['capture'];
        if (isset($capture['manifest'])) return Manifest::canonical($capture['manifest'], $this->client->limits());
        $path = $capture['manifestPath'] ?? null; $digest = $capture['manifestDigest'] ?? null;
        if (!is_string($path) || !is_string($digest) || $path !== $capture['directory'] . '/.contextvault/manifest.json' || !in_array($capture['directory'], $this->record['workflow']['captures'], true)) Manifest::fail('CORRUPT_LOCAL_STATE', 'Invalid immutable capture manifest reference');
        if ($this->captureManifestCacheKey !== $path . ':' . $digest) {
            $this->captureManifestCache = $this->verifiedManifest($path, $digest); $this->captureManifestCacheKey = $path . ':' . $digest;
        }
        return $this->captureManifestCache;
    }
    private function rememberFailure(ContextVaultException $error): void
    {
        $this->record['workflow']['terminalFailure'] = ['code' => $error->getErrorCode(), 'message' => $error->getMessage(), 'status' => $error->getStatusCode(), 'body' => $error->getResponseBody()];
        $this->record['workflow']['lastError'] = $error->getErrorCode(); $this->record['workflow']['lastResult'] = null;
    }
    private function terminalResult(): array
    {
        $w = $this->record['workflow']; $failure = $w['terminalFailure'] ?? null;
        if ($failure !== null) throw Client::error($failure['code'], $failure['message'], $failure['status'], $failure['body'])->withRecoveryPath($this->statePath);
        if ($w['recoveryStatus'] === 'known-failed') throw Client::error($w['lastError'] ?? 'OPERATION_FAILED', 'Previously recorded command failure')->withRecoveryPath($this->statePath);
        if ($w['recoveryStatus'] === 'aborted') return $w['runView'];
        return $w['lastResult'] ?? $w['runView'] ?? [];
    }
    /** Successful checkpoints release old payloads; failed release retains its ownership reference and bounded journal accounting. */
    private function releasePublishedCaptures(): void
    {
        foreach ($this->record['workflow']['captures'] as $capture) {
            try {
                if (file_exists($capture) || is_link($capture)) LocalFiles::clear($capture, true);
                $this->record['workflow']['captures'] = array_values(array_diff($this->record['workflow']['captures'], [$capture]));
                unset($this->record['workflow']['captureIdentities'][$capture], $this->record['workflow']['privateCleanupErrors'][$capture]);
            } catch (\Throwable $error) { $this->record['workflow']['privateCleanupErrors'][$capture] = $error->getMessage(); }
        }
    }
    private function identity(array $run): void
    {
        foreach (['id', 'workspaceId', 'baseRevisionId', 'version', 'mode'] as $field) if (!isset($run[$field])) Manifest::fail('INVALID_RESPONSE', 'Run identity is incomplete');
        if ($run['workspaceId'] !== $this->record['state']['workspaceId']) Manifest::fail('INVALID_RESPONSE', 'Run belongs to a different workspace');
        $this->record['state']['run'] = array_intersect_key($run, array_flip(['id', 'workspaceId', 'baseRevisionId', 'version', 'mode']));
        $this->record['workflow']['runView'] = $run;
    }
    private function prepare(string $kind, string $path, array $body, ?array $capture = null): void
    {
        $request = $capture === null ? ['method' => 'POST', 'path' => $path, 'body' => $body] : ['method' => 'PUT', 'path' => $path, 'capture' => $capture];
        if ($this->record['state']['pendingCommand'] !== null) {
            $pending = $this->record['state']['pendingCommand'];
            if ($pending['kind'] !== $kind || $pending['request'] !== $request) Manifest::fail('CORRUPT_LOCAL_STATE', 'Pending command differs from its durable workflow');
            return;
        }
        $pending = ['kind' => $kind, 'idempotencyKey' => Client::key(), 'request' => $request, 'phase' => 'prepared', 'operationId' => null, 'preparedAt' => gmdate('Y-m-d\TH:i:s\Z')];
        if ($kind === 'finalize') {
            $pending['mode'] = $this->record['state']['run']['mode'];
            $pending['selectedSubmission'] = isset($body['submissionId']) ? ['submissionId' => $body['submissionId'], 'manifestDigest' => $this->record['workflow']['submission']['manifestDigest']] : null;
        }
        $this->record['state']['pendingCommand'] = $pending; $this->save();
    }
    private function dispatch(): array
    {
        $pending = $this->record['state']['pendingCommand']; $wasUncertain = in_array($pending['phase'], ['dispatched', 'outcome-unknown'], true);
        $checkpointReopen = $this->record['workflow']['action'] === 'checkpoint' && $this->record['workflow']['stage'] === 'reopen' && $pending['kind'] === 'run:open';
        $priorReopenAcceptancePossible = $this->record['workflow']['reopenAcceptancePossible'] ?? true;
        if ($checkpointReopen) {
            // A retry can reach the server even if this process never receives its response.
            $this->record['workflow']['reopenRejectionProof'] = null;
            $this->record['workflow']['reopenAcceptancePossible'] = true;
            $this->record['workflow']['reopenAttempts'] = ($this->record['workflow']['reopenAttempts'] ?? 0) + 1;
        }
        $readingOperation = false;
        $this->record['state']['pendingCommand']['phase'] = 'dispatched'; $this->save();
        $httpAttempt = $checkpointReopen ? $this->client->beginHttpAttempt($pending['request']['method'], $pending['request']['path'], $pending['idempotencyKey']) : null;
        try {
            if ($pending['operationId'] !== null) { $readingOperation = true; return $this->client->operations()->wait($pending['operationId']); }
            $request = $pending['request'];
            if ($pending['kind'] === 'submission:file') {
                $capture = $request['capture']; $entry = ['path' => $this->captureManifest()['entries'][$this->record['workflow']['uploadIndex']]['path'], 'kind' => 'file', 'byteLength' => $capture['byteLength'], 'sha256' => $capture['sha256']];
                $result = $this->client->upload($request['path'], $capture['privateFilePath'], $entry, $pending['idempotencyKey']);
            } else {
                $result = $this->client->request($request['method'], $request['path'], ['json' => $request['body'], 'headers' => ['Idempotency-Key' => $pending['idempotencyKey']]]);
            }
            if (isset($result['kind'], $result['state'], $result['phase'], $result['id'])) {
                $this->record['state']['pendingCommand']['operationId'] = $result['id']; $this->save();
                $readingOperation = true;
                return $this->client->operations()->wait($result['id']);
            }
            return $result;
        } catch (\Throwable $error) {
            $transportRejection = $error instanceof ContextVaultException
                ? $this->client->httpRejection($error, $pending['request']['method'], $pending['request']['path'], $pending['idempotencyKey'], $httpAttempt) : null;
            if ($checkpointReopen) {
                $this->record['state']['pendingCommand']['phase'] = 'outcome-unknown';
                $this->record['workflow']['recoveryStatus'] = 'published-needs-reopen';
                $this->record['workflow']['reopenError'] = ['code' => $error instanceof ContextVaultException ? $error->getErrorCode() : 'CLIENT_ERROR', 'message' => $error->getMessage()];
                if ($error instanceof ContextVaultException && isset($error->getResponseBody()['error']['operationId'])) $this->record['state']['pendingCommand']['operationId'] = $error->getResponseBody()['error']['operationId'];
                if (!$priorReopenAcceptancePossible && !$readingOperation && $this->record['state']['pendingCommand']['operationId'] === null && $transportRejection !== null
                    && in_array($transportRejection['status'], [401, 403], true) && in_array($transportRejection['code'], ['UNAUTHENTICATED', 'FORBIDDEN'], true)) {
                    $this->record['workflow']['reopenAcceptancePossible'] = false;
                    $this->record['workflow']['reopenRejectionProof'] = $transportRejection + ['request' => $pending['request'], 'attempt' => $this->record['workflow']['reopenAttempts'], 'observedAt' => gmdate('Y-m-d\TH:i:s\Z')];
                }
                $this->save();
                if ($error instanceof ContextVaultException && $error->getStatusCode() >= 400 && $error->getStatusCode() < 500 && $error->getErrorCode() !== 'PUBLICATION_OUTCOME_UNKNOWN') throw $error->withRecoveryPath($this->statePath);
                throw new OutcomeUnknownError('Checkpoint published; reconcile the original reopen command', $this->statePath, $error);
            }
            if ($error instanceof ContextVaultException && $error->getErrorCode() === 'INVALID_TRANSITION' && $this->record['state']['run'] !== null) {
                try {
                    $current = $this->client->runs()->get($this->record['state']['run']['id']);
                    if ($current['state'] === 'expired') $error = Client::error('RUN_EXPIRED', 'The authoritative run lease expired', 410);
                } catch (\Throwable $lookupError) { /* An unavailable lookup cannot change the original command's outcome. */ }
            }
            // Only a definite client HTTP rejection or a durable failed operation proves failure after dispatch.
            $knownHttpRejection = $error instanceof ContextVaultException && $error->getStatusCode() >= 400 && $error->getStatusCode() < 500 && $error->getErrorCode() !== 'PUBLICATION_OUTCOME_UNKNOWN';
            $unknown = !$knownHttpRejection;
            $knownFailedOperation = $error instanceof ContextVaultException && ($error->getResponseBody()['operation']['state'] ?? null) === 'failed';
            if (!$knownFailedOperation && ($unknown || $wasUncertain || $readingOperation)) {
                $this->record['state']['pendingCommand']['phase'] = 'outcome-unknown';
                if ($this->record['workflow']['recoveryStatus'] !== 'published-needs-reopen') $this->record['workflow']['recoveryStatus'] = 'outcome-unknown';
                if ($error instanceof ContextVaultException && isset($error->getResponseBody()['error']['operationId'])) $this->record['state']['pendingCommand']['operationId'] = $error->getResponseBody()['error']['operationId'];
                $this->save();
                if ($unknown) throw new OutcomeUnknownError('Command outcome requires reconciliation; retained original command and source', $this->statePath, $error);
                if ($error instanceof ContextVaultException) $error->withRecoveryPath($this->statePath);
                throw $error; // A denied operation read cannot reject the preceding accepted mutation.
            }
            $this->record['workflow']['recoveryStatus'] = 'known-failed'; $this->record['workflow']['lastError'] = $error instanceof ContextVaultException ? $error->getErrorCode() : 'CLIENT_ERROR';
            $this->rememberFailure($error);
            $this->record['state']['pendingCommand'] = null; $this->record['workflow']['action'] = null; $this->record['workflow']['stage'] = 'done';
            $this->save(); throw $error;
        }
    }
    private function completed(string $nextStage): void { $this->record['state']['pendingCommand'] = null; $this->record['workflow']['stage'] = $nextStage; $this->save(); }
    private function drive(): array
    {
        while (true) {
            $s = $this->record['state']; $w = $this->record['workflow']; $runId = $s['run']['id'] ?? null;
            switch ($w['stage']) {
                case 'create':
                    $this->prepare('workspace:create', '/v1/workspaces', $w['creation']); $result = $this->dispatch();
                    $id = $result['result']['workspaceId'] ?? $result['id'] ?? null;
                    if (!is_string($id)) Manifest::fail('INVALID_RESPONSE', 'Creation did not return a workspace identity');
                    $this->record['state']['workspaceId'] = $id; $this->record['workflow']['workspace'] = $result; $this->completed('open'); break;
                case 'open': case 'reopen':
                    $this->prepare('run:open', '/v1/workspaces/' . rawurlencode($s['workspaceId']) . '/runs', $w['runRequest']);
                    $run = $this->dispatch();
                    if (isset($run['result']['runId'])) $run = $this->client->runs()->get($run['result']['runId']);
                    $this->identity($run); $this->record['state']['state'] = 'provisioning'; $this->completed('hydrate'); break;
                case 'hydrate':
                    $this->record['state']['state'] = 'provisioning'; $this->record['workflow']['recoveryStatus'] = 'hydration-incomplete';
                    if ($w['hydration'] !== null && is_dir($w['hydration'])) LocalFiles::clear($w['hydration'], true);
                    $staging = LocalFiles::unique(dirname($this->statePath), 'hydration-'); $this->record['workflow']['hydration'] = $staging; $this->record['workflow']['hydrationIdentity'] = LocalFiles::identity($staging); $this->save();
                    try { $manifest = LocalFiles::hydrate($this->client, $runId, $s['path'], $staging); }
                    catch (\Throwable $error) { $this->record['state']['state'] = 'failed'; $this->record['workflow']['recoveryStatus'] = 'hydration-failed'; $this->save(); throw $error; }
                    $baseManifestPath = dirname($this->statePath) . '/base-manifest.json';
                    LocalFiles::atomicJson($baseManifestPath, $manifest, Manifest::metadataBudget($this->client->limits()));
                    $this->record['workflow']['hydration'] = null; $this->record['workflow']['hydrationIdentity'] = null;
                    $this->record['workflow']['baseManifestRef'] = ['path' => $baseManifestPath, 'digest' => Manifest::digest($manifest, $this->client->limits())];
                    unset($this->record['workflow']['baseManifest']);
                    if ($w['action'] === 'checkpoint') $this->releasePublishedCaptures();
                    $this->record['state']['state'] = 'ready'; $this->record['workflow']['recoveryStatus'] = 'ready';
                    $this->record['workflow']['action'] = null; $this->record['workflow']['stage'] = 'ready'; $this->record['workflow']['capture'] = null;
                    $this->record['workflow']['submission'] = null; $this->record['workflow']['receipts'] = []; $this->record['workflow']['uploadIndex'] = 0;
                    $this->record['workflow']['terminalFailure'] = null; $this->save();
                    return $this->record['workflow']['runView'];
                case 'capture':
                    if ($s['run']['mode'] === 'read-only') { $this->completed('finalize'); break; }
                    // A killed, incomplete capture has no publication command. Retire its recorded owned bytes before recapturing.
                    if ($w['capture'] === null && $w['captures']) { $this->releasePublishedCaptures(); $this->save(); }
                    $capture = LocalFiles::capture($s['path'], dirname($this->statePath), $this->client->limits(), function (array $ownership): void {
                        $this->record['workflow']['captures'][] = $ownership['directory'];
                        $this->record['workflow']['captureIdentities'][$ownership['directory']] = $ownership['identity']; $this->save();
                    });
                    $this->captureManifestCache = $capture['manifest']; $this->captureManifestCacheKey = $capture['manifestPath'] . ':' . $capture['manifestDigest'];
                    unset($capture['manifest']); $this->record['workflow']['capture'] = $capture; $this->completed('submission'); break;
                case 'submission':
                    $this->prepare('submission:create', Runs::route($runId) . '/submissions', []);
                    $this->record['workflow']['submission'] = $this->dispatch(); $this->completed('upload'); break;
                case 'upload':
                    $entries = $this->captureManifest()['entries']; $index = $w['uploadIndex'];
                    while ($index < count($entries) && $entries[$index]['kind'] !== 'file') $index++;
                    if ($index === count($entries)) { $this->completed('seal'); break; }
                    $entry = $entries[$index]; $this->record['workflow']['uploadIndex'] = $index;
                    $this->prepare('submission:file', Submissions::route($runId, $w['submission']['id']) . '/files?' . http_build_query(['path' => $entry['path']], '', '&', PHP_QUERY_RFC3986), [],
                        ['captureId' => $w['capture']['captureId'], 'privateFilePath' => $w['capture']['directory'] . '/' . $entry['path'], 'byteLength' => $entry['byteLength'], 'sha256' => $entry['sha256']]);
                    $receipt = $this->dispatch(); $this->record['workflow']['receipts'][] = ['path' => $entry['path'], 'receiptId' => $receipt['id']];
                    $this->record['workflow']['uploadIndex'] = $index + 1; $this->completed('upload'); break;
                case 'seal':
                    $this->prepare('submission:seal', Submissions::route($runId, $w['submission']['id']) . '/seal', ['manifest' => $this->captureManifest(), 'receipts' => $w['receipts']]);
                    $this->record['workflow']['submission'] = $this->dispatch(); $this->completed('finalize'); break;
                case 'finalize':
                    $body = ['expectedRunVersion' => $s['run']['version']];
                    if ($s['run']['mode'] === 'read-write') $body['submissionId'] = $w['submission']['id'];
                    $this->prepare('finalize', Runs::route($runId) . '/finalize', $body); $operation = $this->dispatch();
                    $result = $operation['result'] ?? null;
                    if (!is_array($result) || ($result['kind'] ?? null) !== 'finalize') throw new OutcomeUnknownError('Finalization returned no durable result', $this->statePath);
                    $this->record['workflow']['lastResult'] = $result;
                    if ($result['runState'] !== 'finalized') {
                        $this->record['state']['pendingCommand'] = null; $this->record['workflow']['action'] = null;
                        $this->record['workflow']['stage'] = 'done'; $this->record['workflow']['recoveryStatus'] = 'known-failed';
                        $error = Client::error($result['runState'] === 'conflicted' ? 'REVISION_CONFLICT' : 'OPERATION_FAILED', 'Finalization has a known terminal outcome');
                        $this->rememberFailure($error); $this->save(); throw $error;
                    }
                    if ($w['action'] === 'checkpoint') {
                        $this->record['workflow']['acceptedCheckpoint'] = ['run' => $s['run'], 'operation' => $operation, 'result' => $result,
                            'submission' => $w['submission'], 'receipts' => $w['receipts']];
                        $this->record['workflow']['reopenAttempts'] = 0; $this->record['workflow']['reopenAcceptancePossible'] = false;
                        $this->record['workflow']['reopenRejectionProof'] = null;
                        $this->record['workflow']['recoveryStatus'] = 'published-needs-reopen'; $this->completed('reopen'); break;
                    }
                    $this->record['workflow']['recoveryStatus'] = 'finalized'; $this->record['workflow']['action'] = null; $this->completed('done'); return $result;
                case 'abort':
                    $this->prepare('abort', Runs::route($runId) . '/abort', ['expectedRunVersion' => $s['run']['version'], 'reason' => $w['abortReason']]);
                    $run = $this->dispatch();
                    if (($run['state'] ?? null) !== 'aborted') throw new OutcomeUnknownError('Abort outcome is not proven', $this->statePath);
                    $this->identity($run); $this->record['workflow']['action'] = null; $this->record['workflow']['recoveryStatus'] = 'aborted'; $this->completed('done'); return $run;
                case 'heartbeat':
                    $this->prepare('run:heartbeat', Runs::route($runId) . '/heartbeat', ['expectedLeaseVersion' => $w['runView']['leaseVersion']]);
                    $run = $this->dispatch(); $this->identity($run); $this->record['workflow']['action'] = null; $this->record['workflow']['recoveryStatus'] = 'ready'; $this->completed('ready'); return $run;
                case 'ready': return $w['lastResult'] ?? $w['runView'] ?? [];
                case 'done': return $this->terminalResult();
                default: Manifest::fail('CORRUPT_LOCAL_STATE', 'Unknown durable workflow stage');
            }
        }
    }
    public function reconcile(bool $writersStopped = false): array
    {
        self::stopped($writersStopped); return $this->locked(fn(): array => $this->drive());
    }
    private function finish(string $action, bool $writersStopped): array
    {
        self::stopped($writersStopped);
        return $this->locked(function () use ($action): array {
            $w = $this->record['workflow'];
            if ($w['action'] !== null) {
                if ($w['action'] !== $action) Manifest::fail('RECONCILIATION_REQUIRED', 'Reconcile the existing command before starting another action');
                return $this->drive();
            }
            if ($w['stage'] === 'done') return $this->terminalResult();
            if ($w['stage'] !== 'ready' || $w['recoveryStatus'] !== 'ready') Manifest::fail('RECONCILIATION_REQUIRED', 'Workspace is not ready');
            $this->record['workflow']['action'] = $action; $this->record['workflow']['stage'] = 'capture';
            $this->record['workflow']['recoveryStatus'] = 'capturing'; $this->save(); return $this->drive();
        });
    }
    public function finalize(bool $writersStopped = false): array { return $this->finish('finalize', $writersStopped); }
    public function checkpoint(bool $writersStopped = false): array { return $this->finish('checkpoint', $writersStopped); }
    /** Abandon only a proven never-accepted reopen. Publication stays finalized; filesystem cleanup remains explicit. */
    public function abandonReopen(bool $writersStopped = false): array
    {
        self::stopped($writersStopped);
        return $this->locked(function (): array {
            $w = $this->record['workflow']; $pending = $this->record['state']['pendingCommand'];
            $receipt = $w['acceptedCheckpoint'] ?? null; $proof = $w['reopenRejectionProof'] ?? null;
            if ($w['action'] !== 'checkpoint' || $w['stage'] !== 'reopen' || $w['recoveryStatus'] !== 'published-needs-reopen'
                || ($pending['kind'] ?? null) !== 'run:open' || !is_array($receipt) || ($receipt['result']['runState'] ?? null) !== 'finalized'
                || ($receipt['operation']['state'] ?? null) !== 'succeeded' || ($receipt['operation']['result'] ?? null) !== $receipt['result']
                || ($receipt['run']['id'] ?? null) !== ($this->record['state']['run']['id'] ?? null)
                || ($w['reopenAcceptancePossible'] ?? true) !== false || !is_array($proof)
                || ($proof['provenance'] ?? null) !== 'guzzle-http-response-v1' || !in_array($proof['status'] ?? null, [401, 403], true)
                || ($proof['requests'] ?? null) !== 1 || !is_string($proof['transportAttempt'] ?? null)
                || !in_array($proof['code'] ?? null, ['UNAUTHENTICATED', 'FORBIDDEN'], true)
                || ($proof['attempt'] ?? null) !== ($w['reopenAttempts'] ?? null) || ($proof['idempotencyKey'] ?? null) !== $pending['idempotencyKey']
                || ($proof['request'] ?? null) !== $pending['request'] || $pending['operationId'] !== null) Manifest::fail('RECONCILIATION_REQUIRED', 'Reopen may have been accepted; retain its original command and source');
            $this->record['workflow']['abandonedReopen'] = ['command' => $pending, 'rejectionProof' => $proof, 'abandonedAt' => gmdate('Y-m-d\TH:i:s\Z')];
            $this->record['state']['pendingCommand'] = null; $this->record['workflow']['action'] = null; $this->record['workflow']['stage'] = 'done';
            $this->record['workflow']['recoveryStatus'] = 'published-reopen-abandoned'; $this->save();
            return $receipt;
        });
    }
    public function heartbeat(): array
    {
        return $this->locked(function (): array {
            $w = $this->record['workflow'];
            if ($w['action'] !== null && $w['action'] !== 'heartbeat') Manifest::fail('RECONCILIATION_REQUIRED', 'Reconcile the existing command first');
            if ($w['action'] === null && $w['stage'] !== 'ready') Manifest::fail('INVALID_TRANSITION', 'Heartbeat requires a ready active run');
            $this->record['workflow']['action'] = 'heartbeat'; $this->record['workflow']['stage'] = 'heartbeat'; $this->save(); return $this->drive();
        });
    }
    public function status(): array
    {
        return $this->locked(function (): array {
            $id = $this->record['state']['run']['id'] ?? null;
            if ($id === null) Manifest::fail('RECONCILIATION_REQUIRED', 'Run identity is not known; reconcile the original command');
            $run = $this->client->runs()->get($id); $this->record['workflow']['observedRun'] = $run; $this->save(); return $run;
        });
    }
    public function abort(string $reason = 'caller aborted', bool $writersStopped = false): array
    {
        return $this->locked(function () use ($reason): array {
            $w = $this->record['workflow'];
            if ($w['action'] !== 'abort') {
                if ($this->record['state']['pendingCommand'] !== null || in_array($w['recoveryStatus'], ['outcome-unknown', 'published-needs-reopen'], true) || $this->record['state']['run'] === null) Manifest::fail('RECONCILIATION_REQUIRED', 'Reconcile the existing command before abort');
                $current = $this->client->runs()->get($this->record['state']['run']['id']);
                if ($current['state'] === 'expired') throw Client::error('RUN_EXPIRED', 'Run has expired', 410);
                if ($current['state'] !== 'active') Manifest::fail('INVALID_TRANSITION', 'Abort requires a known active run');
                $this->identity($current); $this->record['workflow']['abortReason'] = $reason;
                $this->record['workflow']['terminalFailure'] = null; unset($this->record['workflow']['lastError']);
            }
            $this->record['workflow']['action'] = 'abort'; $this->record['workflow']['stage'] = 'abort'; $this->save(); return $this->drive();
        });
    }
    public function cleanup(bool $writersStopped = false): array
    {
        self::stopped($writersStopped);
        return $this->locked(function (): array {
            $s = $this->record['state']; $w = $this->record['workflow'];
            if ($w['localCleanup']['state'] === 'complete') return $w['localCleanup'];
            if ($s['pendingCommand'] !== null || $w['action'] !== null || in_array($w['recoveryStatus'], ['outcome-unknown', 'published-needs-reopen'], true)) Manifest::fail('RECONCILIATION_REQUIRED', 'Unknown commands retain local files and captures');
            $run = $this->client->runs()->get($s['run']['id']);
            if (!in_array($run['state'], ['finalized', 'aborted', 'conflicted', 'failed', 'expired'], true)) Manifest::fail('INVALID_TRANSITION', 'Cleanup requires a known terminal run');
            $this->record['workflow']['localCleanup'] = ['state' => 'running', 'lastError' => null, 'rootPath' => $s['path'], 'rootIdentity' => $w['workspaceIdentity']]; $this->save();
            try {
                if ($s['path'] !== null) {
                    if (file_exists($s['path']) || is_link($s['path'])) LocalFiles::clear($s['path'], true);
                    $this->record['state']['path'] = null; $this->save();
                }
                foreach ($w['captures'] as $capture) if (is_dir($capture)) LocalFiles::clear($capture, true);
                if ($w['hydration'] !== null && is_dir($w['hydration'])) LocalFiles::clear($w['hydration'], true);
                $this->record['workflow']['localCleanup'] = ['state' => 'complete', 'lastError' => null];
            } catch (\Throwable $error) { $this->record['workflow']['localCleanup']['state'] = 'failed'; $this->record['workflow']['localCleanup']['lastError'] = $error->getMessage(); $this->save(); throw $error; }
            $this->save(); return $this->record['workflow']['localCleanup'];
        });
    }
}

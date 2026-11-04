<?php
declare(strict_types=1);
require getenv('CV_PHP_AUTOLOAD') ?: __DIR__ . '/../../../sdk/php/vendor/autoload.php';

use ContextVault\{Client, LocalFiles};
use ContextVault\Exception\ContextVaultException;

function transportError(callable $work): ?string {
    try { $work(); return null; } catch (ContextVaultException $error) { return $error->getErrorCode(); }
}
function transportControl(Client $client, string $mode, ?string $workspace = null): array {
    return $client->request('GET', '/transport-control?' . http_build_query(['mode' => $mode, 'workspace' => $workspace]));
}
// Deliberately conflicting low-level options must not disable mutation transport safety.
final class TransportOptionsClient extends Client {
    protected function send(string $method, string $uri, array $options): Psr\Http\Message\ResponseInterface {
        $options['curl'][CURLOPT_FRESH_CONNECT] = false;
        $options['curl'][CURLOPT_FORBID_REUSE] = false;
        return parent::send($method, $uri, $options);
    }
}

$parent = LocalFiles::unique(realpath(sys_get_temp_dir()), 'cv-transport-');
$client = new TransportOptionsClient(getenv('CV_KEY_A'), getenv('CV_TRANSPORT_URL'), 2, ['timeout' => 5]);
$result = ['runtime' => PHP_VERSION, 'curl' => curl_version()['version']];
try {
    $session = $client->createWorkspace(getenv('CV_CUSTOMER_A'), 'transport accepted reopen', $parent);
    $path = $session->path(); file_put_contents($path . '/accepted.bin', "accepted-checkpoint\0\xff");
    transportControl($client, 'drop-reopen', $session->state()['workspaceId']);
    $result['checkpointError'] = transportError(fn() => $session->checkpoint(true));
    $before = $session->recovery(); $pending = $before['state']['pendingCommand'];
    $receipt = $before['workflow']['acceptedCheckpoint']; $capture = $before['workflow']['capture'];
    $result['before'] = ['pending' => $pending, 'acceptancePossible' => $before['workflow']['reopenAcceptancePossible'],
        'proof' => $before['workflow']['reopenRejectionProof'], 'receiptRetained' => ($receipt['operation']['state'] ?? null) === 'succeeded'];
    $result['abandonError'] = transportError(fn() => $session->abandonReopen(true));
    $result['cleanupError'] = transportError(fn() => $session->cleanup(true));
    $result['pathRetained'] = is_dir($path);
    $result['captureRetained'] = is_array($capture) && is_file($capture['directory'] . '/accepted.bin')
        && file_get_contents($capture['directory'] . '/accepted.bin') === "accepted-checkpoint\0\xff";
    $result['firstTrace'] = transportControl($client, 'trace');
    if ($result['abandonError'] !== null && $result['cleanupError'] !== null) {
        // A later real rejection cannot erase uncertainty from the accepted, lost response.
        $session = $client->resumeWorkspace($session->recoveryPath());
        $result['laterRejection'] = transportError(fn() => $session->reconcile(true));
        $later = $session->recovery();
        $result['laterProtected'] = $later['workflow']['reopenAcceptancePossible'] === true
            && $later['workflow']['reopenRejectionProof'] === null && $later['state']['pendingCommand'] === $pending
            && $later['workflow']['acceptedCheckpoint'] === $receipt
            && $later['workflow']['capture'] === $capture && file_get_contents($capture['directory'] . '/accepted.bin') === "accepted-checkpoint\0\xff"
            && transportError(fn() => $session->abandonReopen(true)) === 'RECONCILIATION_REQUIRED'
            && transportError(fn() => $session->cleanup(true)) === 'RECONCILIATION_REQUIRED';
        transportControl($client, 'allow-reopen', $session->state()['workspaceId']);
        $session->reconcile(true);
        $result['reconciledRun'] = $session->state()['run']['id'];
        $result['reconciledReceipt'] = $session->recovery()['workflow']['acceptedCheckpoint'] === $receipt;
        $result['samePath'] = $session->path() === $path && file_get_contents($path . '/accepted.bin') === "accepted-checkpoint\0\xff";
        $session->abort('owned transport reconciliation complete'); $session->cleanup(true);
    }

    $positive = $client->createWorkspace(getenv('CV_CUSTOMER_A'), 'transport first rejection', $parent);
    file_put_contents($positive->path() . '/first.bin', "first-rejection\0\xff");
    transportControl($client, 'deny-reopen', $positive->state()['workspaceId']);
    $result['firstRejection'] = transportError(fn() => $positive->checkpoint(true));
    $positiveRecord = $positive->recovery();
    $result['firstRejectionProof'] = $positiveRecord['workflow']['reopenRejectionProof'];
    $positive->abandonReopen(true); $positive->cleanup(true);
    $result['firstRejectionAbandoned'] = $positive->state()['pendingCommand'] === null;

    foreach (['POST', 'PUT', 'PATCH', 'DELETE'] as $method) {
        transportControl($client, 'warm');
        $key = Client::key(); $token = $client->beginHttpAttempt($method, '/transport-legacy', $key); $proof = null;
        try { $client->request($method, '/transport-legacy', ['json' => ['method' => $method], 'headers' => ['Idempotency-Key' => $key]]); $errorCode = null; }
        catch (ContextVaultException $error) { $errorCode = $error->getErrorCode(); $proof = $client->httpRejection($error, $method, '/transport-legacy', $key, $token); }
        $result['legacy'][$method] = ['error' => $errorCode, 'proof' => $proof];
    }
    $binary = "binary-upload\0\xff"; $file = $parent . '/upload.bin'; file_put_contents($file, $binary);
    $entry = ['path' => 'upload.bin', 'kind' => 'file', 'byteLength' => strlen($binary), 'sha256' => hash('sha256', $binary)];
    transportControl($client, 'warm');
    $result['binaryError'] = transportError(fn() => $client->upload('/transport-binary', $file, $entry, Client::key()));
    $result['readResult'] = $client->request('GET', '/transport-read');
    $result['trace'] = transportControl($client, 'trace');
    echo json_encode($result, JSON_THROW_ON_ERROR), "\n";
} finally { LocalFiles::clear($parent, true); }

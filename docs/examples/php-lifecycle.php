<?php
declare(strict_types=1);
// Resolve Composer's installed package from the consumer project.
require getcwd() . '/vendor/autoload.php';

use ContextVault\Client;

function check(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}
foreach (['CV_API_URL', 'CV_API_KEY', 'CV_CUSTOMER_ID'] as $variable) {
    if (!getenv($variable)) throw new RuntimeException($variable . ' is required');
}
$client = new Client(getenv('CV_API_KEY'), getenv('CV_API_URL'));
$parent = realpath(getcwd()) . '/contextvault-example-' . bin2hex(random_bytes(12));
check(mkdir($parent, 0700), 'Cannot create a private example directory');
$payload = "\x00\xff\x80\n";
$session = null;
$options = ['agentLabel' => 'php-example', 'task' => 'Documented lifecycle', 'reason' => 'Run the documented lifecycle'];
try {
    $session = $client->createWorkspace(getenv('CV_CUSTOMER_ID'), 'PHP documentation example', $parent, $options);
    $workspaceId = $session->state()['workspaceId'];
    file_put_contents($session->path() . '/output.bin', $payload);
    file_put_contents($session->path() . '/remove.txt', 'This file is removed in the next revision.');
    mkdir($session->path() . '/empty', 0700);
    // The application stops every agent writer before this explicit publication.
    check($session->finalize(true)['runState'] === 'finalized', 'Publication failed');
    $session->cleanup(true);

    $session = $client->openWorkspace($workspaceId, $parent, $options);
    check(file_get_contents($session->path() . '/output.bin') === $payload, 'Binary bytes changed');
    unlink($session->path() . '/remove.txt');
    check($session->finalize(true)['runState'] === 'finalized', 'Deletion failed');
    $session->cleanup(true);

    $session = $client->openWorkspace($workspaceId, $parent, $options);
    file_put_contents($session->path() . '/discarded.txt', 'This edit is never published.');
    check($session->abort('Demonstrate explicit abort', true)['state'] === 'aborted', 'Abort failed');
    $session->cleanup(true);

    $session = $client->openWorkspace($workspaceId, $parent, array_merge($options, ['mode' => 'read-only']));
    check(file_get_contents($session->path() . '/output.bin') === $payload, 'Binary bytes changed');
    check(!file_exists($session->path() . '/remove.txt'), 'Deletion was not retained');
    check(!file_exists($session->path() . '/discarded.txt'), 'Aborted edit was published');
    check(is_dir($session->path() . '/empty'), 'Empty directory was lost');
    check($session->finalize(true)['runState'] === 'finalized', 'Read-only completion failed');
    $recovery = $session->recoveryPath();
    $session->cleanup(true);
    echo json_encode(['language' => 'php', 'workspaceId' => $workspaceId, 'privateStatePath' => $recovery,
                     'binary' => true, 'deletion' => true, 'abort' => true, 'cleanup' => true], JSON_THROW_ON_ERROR) . PHP_EOL;
} catch (Throwable $error) {
    // Retain files and the exact journal when an outcome needs reconciliation.
    $recovery = method_exists($error, 'getRecoveryPath') ? $error->getRecoveryPath() : null;
    fwrite(STDERR, json_encode(['error' => method_exists($error, 'getErrorCode') ? $error->getErrorCode() : 'EXAMPLE_FAILED',
                               'privateStatePath' => $recovery ?? ($session ? $session->recoveryPath() : null)]) . PHP_EOL);
    exit(1);
}

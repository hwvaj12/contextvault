<?php
declare(strict_types=1);
require getenv('CV_PHP_AUTOLOAD') ?: __DIR__ . '/vendor/autoload.php';
use ContextVault\Client;
$argv = json_decode(getenv('AGENT_COMMAND_JSON'), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($argv) || !$argv || count(array_filter($argv, 'is_string')) !== count($argv)) throw new InvalidArgumentException('AGENT_COMMAND_JSON must be an argument array');
$client = new Client(getenv('CV_API_KEY'), getenv('CV_API_URL'), 0); $session = null; $publication = null;
try {
    $options = ['agentLabel' => getenv('AGENT_LABEL') ?: 'existing-agent', 'task' => getenv('AGENT_TASK') ?: 'ordinary agent workspace', 'reason' => getenv('AGENT_REASON') ?: 'owner requested agent work'];
    $parent = getenv('CV_LOCAL_PARENT');
    $session = getenv('CV_WORKSPACE_ID') ? $client->openWorkspace(getenv('CV_WORKSPACE_ID'), $parent, $options) : $client->createWorkspace(getenv('CV_CUSTOMER_ID'), getenv('CV_WORKSPACE_NAME') ?: 'agent-task', $parent, $options);
    echo json_encode(['stage' => 'ready', 'path' => $session->path(), 'privateStatePath' => $session->recoveryPath(), 'runId' => $session->state()['run']['id']], JSON_THROW_ON_ERROR), "\n"; fflush(STDOUT);
    $environment = ['PATH' => getenv('PATH'), 'WORKSPACE_PATH' => $session->path()];
    foreach (array_filter(explode(',', getenv('AGENT_ENV_NAMES') ?: '')) as $name) {
        if (!preg_match('/^[A-Z_][A-Z0-9_]*$/', $name) || strncmp($name, 'CV_', 3) === 0 || strncmp($name, 'CONTEXTVAULT_', 13) === 0 || strncmp($name, 'AWS_', 4) === 0) throw new InvalidArgumentException('Exclude ContextVault and storage credentials from agent environment names');
        if (getenv($name) !== false) $environment[$name] = getenv($name);
    }
    $interval = (float)(getenv('CV_HEARTBEAT_SECONDS') ?: '10');
    if ($interval < 0.01 || $interval > 120 || !is_finite($interval)) throw new InvalidArgumentException('Invalid heartbeat interval');
    $agent = proc_open($argv, [STDIN, STDOUT, STDERR], $pipes, $session->path(), $environment);
    if (!is_resource($agent)) throw new RuntimeException('Agent could not start');
    $nextHeartbeat = microtime(true) + $interval;
    try {
        while (($status = proc_get_status($agent))['running']) {
            if (microtime(true) >= $nextHeartbeat) { $session->heartbeat(); $nextHeartbeat = microtime(true) + $interval; }
            usleep((int)(min(0.05, $interval) * 1000000));
        }
    } catch (Throwable $error) {
        proc_terminate($agent); $deadline = microtime(true) + 2;
        while (proc_get_status($agent)['running'] && microtime(true) < $deadline) usleep(10000);
        if (proc_get_status($agent)['running']) proc_terminate($agent, 9);
        proc_close($agent); throw $error;
    }
    $closed = proc_close($agent); $exitCode = $status['exitcode'] >= 0 ? $status['exitcode'] : $closed;
    if ($exitCode !== 0) throw new RuntimeException('Agent stopped without success; workspace retained for inspection');
    $publication = $session->finalize(true); $cleanup = $session->cleanup(true);
    echo json_encode(['stage' => 'complete', 'publication' => $publication, 'cleanupState' => $cleanup['state'], 'privateStatePath' => $session->recoveryPath()], JSON_THROW_ON_ERROR), "\n";
} catch (Throwable $error) {
    fwrite(STDERR, json_encode(['stage' => 'retained', 'error' => method_exists($error, 'getErrorCode') ? $error->getErrorCode() : get_class($error), 'privateStatePath' => (method_exists($error, 'getRecoveryPath') ? $error->getRecoveryPath() : null) ?? ($session ? $session->recoveryPath() : null), 'publication' => $publication], JSON_THROW_ON_ERROR) . "\n");
    exit(1);
}

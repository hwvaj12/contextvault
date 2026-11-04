<?php
declare(strict_types=1);
require '/artifact/vendor/autoload.php';

final class RestartClient extends ContextVault\Client
{
    public string $target;
    public function request(string $method, string $uri, array $options = []): mixed
    {
        $result = parent::request($method, $uri, $options);
        $patterns = ['create' => '~^/v1/workspaces$~', 'open' => '~/runs$~', 'submission' => '~/submissions$~',
            'upload' => '~/files\?~', 'seal' => '~/seal$~', 'finalize' => '~/finalize$~', 'abort' => '~/abort$~', 'heartbeat' => '~/heartbeat$~'];
        if ($method !== 'GET' && preg_match($patterns[$this->target], $uri)) exit(75); // The real response never reaches the session.
        return $result;
    }
}
$client = new RestartClient(getenv('CV_KEY_A'), getenv('CV_URL'), 0);
$client->target = $argv[1];
$session = $argv[1] === 'create'
    ? $client->createWorkspace(getenv('CV_CUSTOMER_A'), 'restart-create', $argv[2])
    : $client->openWorkspace($argv[3], $argv[2]);
$path = $session->path();
file_put_contents($path . '/restart.bin', "original\0\xff" . $argv[1]);
if ($argv[1] === 'abort') $session->abort('restart abort', true);
elseif ($argv[1] === 'heartbeat') $session->heartbeat();
else $session->finalize(true);
throw new RuntimeException('Fault did not fire');

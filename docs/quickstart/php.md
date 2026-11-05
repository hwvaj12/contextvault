# PHP client quickstart

The PHP SDK requires PHP 8.0 or later, `ext-curl`, `ext-json`, and its Composer dependencies.
Declared Unicode polyfills support installations without `intl` or `mbstring`.
Local workspaces use POSIX filesystem behavior verified by the installed-package tests.

## Install a local Composer artifact

Use a repository-built archive containing the SDK's `composer.json` and `src` directory.
The following consumer metadata selects local artifact version `1.0.0` for dependency resolution.
It does not claim a published registry release.

1. Save this package definition as the consumer's `composer.json`.

```json
{
  "name": "example/contextvault-consumer",
  "require": { "contextvault/contextvault-php": "1.0.0" },
  "repositories": [
    {
      "type": "package",
      "package": {
        "name": "contextvault/contextvault-php",
        "version": "1.0.0",
        "type": "library",
        "dist": {
          "type": "tar",
          "url": "file:///absolute/artifacts/contextvault-php.tar.gz"
        },
        "require": {
          "php": ">=8.0",
          "ext-curl": "*",
          "ext-json": "*",
          "guzzlehttp/guzzle": "^7.0",
          "symfony/polyfill-intl-normalizer": "^1.31",
          "symfony/polyfill-mbstring": "^1.31"
        },
        "autoload": { "psr-4": { "ContextVault\\": "src/" } }
      }
    }
  ]
}
```

2. Install the local artifact and declared runtime dependencies.

```sh
composer install --no-dev --no-scripts --no-plugins --no-interaction
```

3. Configure the environment described in the [common quickstart](clients.md).

The executable example loads the consumer's `vendor/autoload.php`.
It does not import the repository source directory directly.

## Open, write, and finalize

```php
<?php
require getcwd() . '/vendor/autoload.php';

use ContextVault\Client;

$client = new Client(getenv('CV_API_KEY'), getenv('CV_API_URL'));
$session = $client->createWorkspace(
    getenv('CV_CUSTOMER_ID'),
    'client-example',
    '/absolute/existing/private-parent',
    [
        'agentLabel' => 'existing-agent',
        'task' => 'Write the requested result',
        'reason' => 'Nonproduction example',
    ]
);
$recoveryPath = $session->recoveryPath();
file_put_contents($session->path() . '/result.bin', "\0\xff\x80");
// Stop every agent writer before this call.
$operation = $session->finalize(true);
$session->cleanup(true);
```

The local parent must already exist.
The SDK creates private workspace and state directories beneath that client-side parent.
For an existing workspace, use `openWorkspace` with the same parent and run options.
`mode` can select a read-only run.

## Recovery and coordination

```php
$session = $client->resumeWorkspace($savedRecoveryPath);
$operation = $session->reconcile(true);
```

`resumeWorkspace` loads the journal without HTTP dispatch or file mutation.
`reconcile(true)` requires caller-stopped writers and preserves the original command and capture.
A lost response or later authorization denial does not prove that publication failed.

The application schedules synchronous `heartbeat()` calls while the agent works.
With the default five-minute server lease, renew about once per minute.
An expired run cannot be revived.

Checkpoint publishes and opens the next run over the same local path.
An incomplete reopen preserves its accepted checkpoint and original reopen command.
Use the package-specific abandonment API only when its recorded rejection evidence permits it.

Abort discards a known active run.
Cleanup has an independent result and cannot undo accepted publication.
Generic exceptions never authorize automatic abort or file deletion.

Run the maintained [installed example](clients.md#run-the-installed-client-examples) for executable lifecycle checks.
See the [SDK reference](../../sdk/php/README.md#recovery-and-checkpoints) for error types and detailed recovery rules.

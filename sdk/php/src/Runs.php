<?php
declare(strict_types=1);
namespace ContextVault;
/** Low-level resources require caller-managed stable keys and durable retry inputs. */
final class Runs
{
    private Client $client;
    public function __construct(Client $client) { $this->client = $client; }
    public static function route(string $id): string { return '/v1/runs/' . rawurlencode($id); }
    public function open(string $workspaceId, array $request, string $key): array { return $this->client->request('POST', '/v1/workspaces/' . rawurlencode($workspaceId) . '/runs', ['json' => $request, 'headers' => ['Idempotency-Key' => $key]]); }
    public function get(string $id): array { return $this->client->request('GET', self::route($id)); }
    public function manifest(string $id): array { return Manifest::canonical($this->client->request('GET', self::route($id) . '/workspace/manifest'), $this->client->limits()); }
    public function heartbeat(string $id, int $leaseVersion, string $key): array { return $this->client->request('POST', self::route($id) . '/heartbeat', ['json' => ['expectedLeaseVersion' => $leaseVersion], 'headers' => ['Idempotency-Key' => $key]]); }
    public function finalize(string $id, array $request, string $key): array { return $this->client->request('POST', self::route($id) . '/finalize', ['json' => $request, 'headers' => ['Idempotency-Key' => $key]]); }
    public function abort(string $id, int $version, string $reason, string $key): array { return $this->client->request('POST', self::route($id) . '/abort', ['json' => ['expectedRunVersion' => $version, 'reason' => $reason], 'headers' => ['Idempotency-Key' => $key]]); }
}

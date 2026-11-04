<?php
declare(strict_types=1);
namespace ContextVault;
use ContextVault\Exception\{NetworkError, OutcomeUnknownError};
final class Operations
{
    private Client $client;
    public function __construct(Client $client) { $this->client = $client; }
    public function get(string $id): array { return $this->client->request('GET', '/v1/operations/' . rawurlencode($id)); }
    public function wait(string $id, ?float $timeout = null): array
    {
        $duration = $timeout ?? $this->client->operationTimeout();
        if (!is_finite($duration) || $duration <= 0 || $duration > 120) throw new \InvalidArgumentException('Invalid operation deadline');
        $deadline = hrtime(true) / 1e9 + $duration;
        while (true) {
            $remaining = $deadline - hrtime(true) / 1e9;
            if ($remaining <= 0) throw new OutcomeUnknownError('Operation deadline elapsed; reconcile the original operation');
            $bound = min($remaining, $this->client->requestTimeout());
            try { $operation = $this->client->request('GET', '/v1/operations/' . rawurlencode($id), ['timeout' => $bound, 'connect_timeout' => $bound, 'cv_no_retries' => true]); }
            catch (NetworkError $error) { throw new OutcomeUnknownError('Operation polling did not complete; retain its identity', null, $error); }
            if (($operation['state'] ?? null) === 'failed') {
                $error = $operation['error'] ?? [];
                throw Client::error($error['code'] ?? 'OPERATION_FAILED', $error['message'] ?? 'Operation failed', 0,
                    ['error' => $error, 'operation' => ['id' => $id, 'state' => 'failed']]);
            }
            if (($operation['state'] ?? null) === 'succeeded') return $operation;
            if (!in_array($operation['state'] ?? '', ['pending', 'processing'], true)) throw new OutcomeUnknownError('Unrecognized durable operation state');
            $remaining = $deadline - hrtime(true) / 1e9;
            if ($remaining > 0) usleep((int) min(20000, $remaining * 1e6));
        }
    }
}

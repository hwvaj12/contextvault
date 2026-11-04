<?php
declare(strict_types=1);
namespace ContextVault;
final class Submissions
{
    private Client $client;
    public function __construct(Client $client) { $this->client = $client; }
    public static function route(string $run, string $submission): string { return Runs::route($run) . '/submissions/' . rawurlencode($submission); }
    public function create(string $run, string $key): array { return $this->client->request('POST', Runs::route($run) . '/submissions', ['json' => new \stdClass(), 'headers' => ['Idempotency-Key' => $key]]); }
    public function upload(string $run, string $submission, string $privateFilePath, array $entry, string $key): array { return $this->client->upload(self::route($run, $submission) . '/files?' . http_build_query(['path' => $entry['path']], '', '&', PHP_QUERY_RFC3986), $privateFilePath, $entry, $key); }
    public function seal(string $run, string $submission, array $manifest, array $receipts, string $key): array { return $this->client->request('POST', self::route($run, $submission) . '/seal', ['json' => ['manifest' => Manifest::canonical($manifest, $this->client->limits()), 'receipts' => $receipts], 'headers' => ['Idempotency-Key' => $key]]); }
}

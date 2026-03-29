<?php

declare(strict_types=1);

namespace ContextVault;

use GuzzleHttp\RequestOptions;

/**
 * API key operations for the ContextVault API.
 */
class ApiKeysResource
{
    private Client $client;

    public function __construct(Client $client)
    {
        $this->client = $client;
    }

    /**
     * Create a new API key. The plain key is only returned once.
     *
     * @param string $customerId Customer identifier.
     * @param string $name       Human-readable name for the key.
     * @return array API key data including plainKey.
     */
    public function create(string $customerId, string $name): array
    {
        return $this->client->request('POST', '/api-keys', [
            RequestOptions::JSON => [
                'customerId' => $customerId,
                'name' => $name,
            ],
        ]);
    }

    /**
     * List API keys for the authenticated customer.
     *
     * @return array<int, array> List of API key objects (without plain key values).
     */
    public function list(): array
    {
        $result = $this->client->request('GET', '/api-keys');

        return $result['data'] ?? $result;
    }

    /**
     * Revoke (delete) an API key by ID.
     *
     * @param string $keyId API key identifier.
     * @return void
     */
    public function revoke(string $keyId): void
    {
        $encodedId = rawurlencode($keyId);
        $this->client->request('DELETE', "/api-keys/{$encodedId}");
    }
}

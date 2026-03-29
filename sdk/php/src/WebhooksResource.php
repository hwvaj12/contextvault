<?php

declare(strict_types=1);

namespace ContextVault;

use GuzzleHttp\RequestOptions;

/**
 * Webhook operations for the ContextVault API.
 */
class WebhooksResource
{
    private Client $client;

    public function __construct(Client $client)
    {
        $this->client = $client;
    }

    /**
     * Register a webhook endpoint.
     *
     * @param string   $customerId Customer identifier.
     * @param string   $url        URL to receive POST callbacks.
     * @param string[] $events     Event types to subscribe to.
     * @param string|null $secret  Optional secret for HMAC-SHA256 signing.
     * @return array Webhook data with id, customerId, url, events, active, createdAt.
     */
    public function register(string $customerId, string $url, array $events, ?string $secret = null): array
    {
        $body = [
            'customerId' => $customerId,
            'url' => $url,
            'events' => $events,
        ];

        if ($secret !== null) {
            $body['secret'] = $secret;
        }

        return $this->client->request('POST', '/webhooks', [
            RequestOptions::JSON => $body,
        ]);
    }

    /**
     * List webhooks for a customer.
     *
     * @param string $customerId Customer identifier.
     * @return array<int, array> List of webhook objects.
     */
    public function list(string $customerId): array
    {
        $result = $this->client->request('GET', '/webhooks', [
            RequestOptions::QUERY => ['customerId' => $customerId],
        ]);

        return $result['data'] ?? $result;
    }

    /**
     * Delete a webhook by ID.
     *
     * @param string $webhookId Webhook identifier.
     * @return void
     */
    public function delete(string $webhookId): void
    {
        $encodedId = rawurlencode($webhookId);
        $this->client->request('DELETE', "/webhooks/{$encodedId}");
    }
}

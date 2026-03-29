<?php

declare(strict_types=1);

namespace ContextVault;

use ContextVault\Exception\ConflictError;
use ContextVault\Exception\NotFoundError;
use ContextVault\Exception\ValidationError;
use ContextVault\Exception\NetworkError;
use ContextVault\Exception\AuthError;
use ContextVault\Exception\ContextVaultException;
use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Exception\RequestException;
use GuzzleHttp\RequestOptions;

class Client
{
    private GuzzleClient $http;
    private string $apiKey;
    private string $baseUrl;
    private int $maxRetries;
    private ?Workspaces $workspaces = null;

    public function __construct(
        string $apiKey,
        string $baseUrl = 'http://localhost:3000',
        int $maxRetries = 3
    ) {
        $this->apiKey = $apiKey;
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->maxRetries = $maxRetries;

        $this->http = new GuzzleClient([
            'base_uri' => $this->baseUrl,
            'headers' => [
                'X-API-Key' => $this->apiKey,
                'Content-Type' => 'application/json',
                'Accept' => 'application/json',
            ],
            RequestOptions::TIMEOUT => 30,
            RequestOptions::CONNECT_TIMEOUT => 10,
        ]);
    }

    /**
     * Get the workspaces resource.
     *
     * @return Workspaces
     */
    public function workspaces(): Workspaces
    {
        if ($this->workspaces === null) {
            $this->workspaces = new Workspaces($this);
        }

        return $this->workspaces;
    }

    /**
     * Get the configured base URL.
     *
     * @return string
     */
    public function getBaseUrl(): string
    {
        return $this->baseUrl;
    }

    /**
     * Get the configured API key.
     *
     * @return string
     */
    public function getApiKey(): string
    {
        return $this->apiKey;
    }

    /**
     * Send an HTTP request with automatic retry and error mapping.
     *
     * @param string $method  HTTP method
     * @param string $uri     Request URI (relative to base URL)
     * @param array  $options Guzzle request options
     * @return mixed Decoded JSON response
     *
     * @throws AuthError
     * @throws NotFoundError
     * @throws ValidationError
     * @throws NetworkError
     * @throws ConflictError
     * @throws ContextVaultException
     */
    public function request(string $method, string $uri, array $options = []): mixed
    {
        $lastException = null;

        for ($attempt = 0; $attempt <= $this->maxRetries; $attempt++) {
            if ($attempt > 0) {
                $delay = (int) (pow(2, $attempt - 1) * 1000 * 1000); // microseconds
                usleep($delay);
            }

            try {
                $response = $this->http->request($method, $uri, $options);
                $body = (string) $response->getBody();

                if ($body === '') {
                    return null;
                }

                $decoded = json_decode($body, true);

                return is_array($decoded) ? $decoded : null;
            } catch (ConnectException $e) {
                $lastException = new NetworkError(
                    'Failed to connect: ' . $e->getMessage(),
                    $e
                );
                // Retry on network errors
                continue;
            } catch (RequestException $e) {
                $response = $e->getResponse();

                if ($response === null) {
                    $lastException = new NetworkError(
                        'Request failed: ' . $e->getMessage(),
                        $e
                    );
                    // Retry when no response (network-level failure)
                    continue;
                }

                $statusCode = $response->getStatusCode();
                $body = (string) $response->getBody();
                $responseBody = json_decode($body, true);
                $responseBody = is_array($responseBody) ? $responseBody : null;
                $message = $this->extractMessage($responseBody) ?? $e->getMessage();

                // Do not retry client errors (4xx) -- they won't change on retry
                throw $this->mapException($statusCode, $message, $responseBody, $e);
            }
        }

        // Exhausted all retries
        throw $lastException ?? new NetworkError('Request failed after retries');
    }

    /**
     * Extract error message from response body.
     */
    private function extractMessage(?array $body): ?string
    {
        if ($body === null) {
            return null;
        }

        if (isset($body['error'])) {
            if (is_string($body['error'])) {
                return $body['error'];
            }
            if (is_array($body['error']) && isset($body['error']['message'])) {
                return $body['error']['message'];
            }
        }

        if (isset($body['message']) && is_string($body['message'])) {
            return $body['message'];
        }

        return null;
    }

    /**
     * Map HTTP status code and response body to appropriate exception.
     */
    private function mapException(
        int $statusCode,
        string $message,
        ?array $responseBody,
        ?\Throwable $previous
    ): ContextVaultException {
        return match (true) {
            $statusCode === 401, $statusCode === 403
                => new AuthError($message, $statusCode, $responseBody, $previous),
            $statusCode === 404
                => new NotFoundError($message, $responseBody, $previous),
            $statusCode === 409
                => new ConflictError($message, $responseBody, $previous),
            $statusCode === 422, $statusCode === 400
                => new ValidationError($message, $statusCode, $responseBody, $previous),
            default
                => new ContextVaultException($message, $statusCode, $responseBody, $previous),
        };
    }
}

<?php
declare(strict_types=1);
namespace ContextVault;

use ContextVault\Exception\{AuthError, ConflictError, ContextVaultException, ExpiredError, NetworkError, NotFoundError, OutcomeUnknownError, ValidationError};
use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Handler\CurlHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Exception\GuzzleException;
use Psr\Http\Message\ResponseInterface;

class Client
{
    private GuzzleClient $http;
    private string $apiKey;
    private string $baseUrl;
    private int $maxRetries;
    private float $timeout;
    private float $operationTimeout;
    private array $limits;
    private ?ResponseInterface $lastTransportResponse = null;
    private ?array $lastTransportRequest = null;
    private ?ContextVaultException $lastTransportRejection = null;
    private ?array $lastTransportRejectionProof = null;
    private ?array $httpAttemptWitness = null;
    private ?Workspaces $workspaces = null;
    private ?WebhooksResource $webhooksResource = null;
    private ?ApiKeysResource $apiKeysResource = null;

    public function __construct(string $apiKey, string $baseUrl = 'http://localhost:3000', int $maxRetries = 3, array $options = [])
    {
        $parts = parse_url($baseUrl);
        if (!$parts || !isset($parts['scheme'], $parts['host']) || !in_array($parts['scheme'], ['http', 'https'], true) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment']) || !in_array($parts['path'] ?? '', ['', '/'], true)) throw new \InvalidArgumentException('Use an HTTP origin without credentials or a path');
        if ($maxRetries < 0 || $maxRetries > 10) throw new \InvalidArgumentException('Invalid read retry bound');
        $this->timeout = (float) ($options['timeout'] ?? 15);
        $this->operationTimeout = (float) ($options['operationTimeout'] ?? 30);
        if (!is_finite($this->timeout) || !is_finite($this->operationTimeout) || $this->timeout <= 0 || $this->timeout > 120 || $this->operationTimeout <= 0 || $this->operationTimeout > 120) throw new \InvalidArgumentException('Deadlines must be positive and at most 120 seconds');
        $this->limits = Manifest::limits($options['limits'] ?? []);
        Manifest::metadataBudget($this->limits, true);
        $this->apiKey = $apiKey; $this->baseUrl = rtrim($baseUrl, '/'); $this->maxRetries = $maxRetries;
        // CurlHandler streams request resources. Guzzle's StreamHandler buffers upload bodies.
        if (!extension_loaded('curl')) throw new \RuntimeException('ext-curl is required for bounded binary uploads');
        $this->http = new GuzzleClient(['base_uri' => $this->baseUrl,
            'handler' => HandlerStack::create(new CurlHandler()), 'allow_redirects' => false, 'http_errors' => false,
            'timeout' => $this->timeout, 'connect_timeout' => min(5, $this->timeout),
            'headers' => ['X-API-Key' => $apiKey, 'Accept' => 'application/json']]);
    }
    public function workspaces(): Workspaces { return $this->workspaces ?? ($this->workspaces = new Workspaces($this)); }
    public function runs(): Runs { return new Runs($this); }
    public function submissions(): Submissions { return new Submissions($this); }
    public function operations(): Operations { return new Operations($this); }
    public function webhooks(): WebhooksResource { return $this->webhooksResource ?? ($this->webhooksResource = new WebhooksResource($this)); }
    public function apiKeys(): ApiKeysResource { return $this->apiKeysResource ?? ($this->apiKeysResource = new ApiKeysResource($this)); }
    public function getBaseUrl(): string { return $this->baseUrl; }
    public function getApiKey(): string { return $this->apiKey; }
    public function limits(): array { return $this->limits; }
    public function operationTimeout(): float { return $this->operationTimeout; }
    public function requestTimeout(): float { return $this->timeout; }
    public static function key(): string { return bin2hex(random_bytes(24)); }

    public function createWorkspace(string $customerId, string $name, ?string $localParent = null, array $runOptions = []): WorkspaceSession
    {
        $session = WorkspaceSession::create($this, null, $localParent, $runOptions, ['customerId' => $customerId, 'name' => $name]);
        try { $session->reconcile(true); } catch (ContextVaultException $error) { $error->withRecoveryPath($session->recoveryPath()); throw $error; }
        return $session;
    }
    public function openWorkspace(string $workspaceId, ?string $localParent = null, array $runOptions = []): WorkspaceSession
    {
        $session = WorkspaceSession::create($this, $workspaceId, $localParent, $runOptions);
        try { $session->reconcile(true); } catch (ContextVaultException $error) { $error->withRecoveryPath($session->recoveryPath()); throw $error; }
        return $session;
    }
    /** Loading never dispatches, recaptures, aborts, or deletes. Credentials come from this client. */
    public function resumeWorkspace(string $privateStatePath): WorkspaceSession { return WorkspaceSession::load($this, $privateStatePath); }

    protected function send(string $method, string $uri, array $options): ResponseInterface
    {
        if ($uri === '' || $uri[0] !== '/' || substr($uri, 0, 2) === '//' || preg_match('/[\r\n]/', $uri)) throw new \InvalidArgumentException('Use a relative API path');
        $this->lastTransportResponse = null; $this->lastTransportRequest = null;
        $this->lastTransportRejection = null; $this->lastTransportRejectionProof = null;
        if ($this->httpAttemptWitness !== null && $this->httpAttemptWitness['method'] === $method && $this->httpAttemptWitness['path'] === $uri
            && $this->httpAttemptWitness['idempotencyKey'] === ($options['headers']['Idempotency-Key'] ?? null)) $this->httpAttemptWitness['requests']++;
        try {
            $response = $this->http->request($method, $uri, $options);
            $this->lastTransportResponse = $response;
            $this->lastTransportRequest = ['method' => $method, 'path' => $uri, 'idempotencyKey' => $options['headers']['Idempotency-Key'] ?? null];
            return $response;
        }
        catch (GuzzleException $error) { throw new NetworkError('HTTP response was not received completely', $error); }
    }
    /** Evidence is bound to an actual Guzzle response and this exact thrown error, never its fabricated status alone. */
    final public function beginHttpAttempt(string $method, string $path, string $key): string
    {
        $token = self::key();
        $this->httpAttemptWitness = ['token' => $token, 'method' => $method, 'path' => $path, 'idempotencyKey' => $key, 'requests' => 0];
        return $token;
    }
    final public function httpRejection(ContextVaultException $error, string $method, string $path, string $key, ?string $attemptToken = null): ?array
    {
        $proof = $this->lastTransportRejectionProof;
        if ($attemptToken === null || ($this->httpAttemptWitness['token'] ?? null) !== $attemptToken || ($this->httpAttemptWitness['requests'] ?? null) !== 1
            || $error !== $this->lastTransportRejection || $proof === null || $proof['method'] !== $method || $proof['path'] !== $path || $proof['idempotencyKey'] !== $key) return null;
        return $proof + ['transportAttempt' => $attemptToken, 'requests' => 1];
    }
    private function jsonBody(ResponseInterface $response): ?array
    {
        $body = $response->getBody(); $bytes = '';
        try {
            while (!$body->eof()) {
                $chunk = $body->read($this->limits['maxChunkBytes']);
                if ($chunk === '' && !$body->eof()) throw new NetworkError('HTTP response made no progress');
                $bytes .= $chunk;
                if (strlen($bytes) > Manifest::metadataBudget($this->limits)) Manifest::fail('QUOTA_EXCEEDED', 'JSON response exceeds its manifest-derived metadata budget');
            }
        } catch (\RuntimeException $error) { if ($error instanceof ContextVaultException) throw $error; throw new NetworkError('Incomplete HTTP body', $error); }
        finally { $body->close(); }
        if ($bytes === '') return null;
        try { $json = json_decode($bytes, true, 512, JSON_THROW_ON_ERROR); }
        catch (\JsonException $error) { throw new NetworkError('Invalid JSON response', $error); }
        if (!is_array($json)) throw new NetworkError('Expected a JSON object or array');
        return $json;
    }
    public static function error(string $code, string $message, int $status = 0, ?array $body = null): ContextVaultException
    {
        $body = $body ?? ['error' => ['code' => $code, 'message' => $message]];
        if ($status === 401 || $status === 403) return new AuthError($message, $status, $body);
        if ($status === 404) return new NotFoundError($message, $body);
        if ($status === 410 || $code === 'RUN_EXPIRED' || $code === 'SUBMISSION_EXPIRED') return new ExpiredError($message, $status ?: 410, $body);
        if ($status === 409 || $code === 'REVISION_CONFLICT') return new ConflictError($message, $body);
        if (in_array($status, [400, 413, 422], true)) return new ValidationError($message, $status, $body);
        return new ContextVaultException($message, $status, $body);
    }
    private function checked(ResponseInterface $response): ?array
    {
        $json = $this->jsonBody($response); $status = $response->getStatusCode();
        if ($status < 200 || $status > 299) {
            $error = $json['error'] ?? [];
            $failure = self::error(is_array($error) ? ($error['code'] ?? 'HTTP_ERROR') : 'HTTP_ERROR', is_array($error) ? ($error['message'] ?? 'HTTP request failed') : (string) $error, $status, $json);
            if ($response === $this->lastTransportResponse && $this->lastTransportRequest !== null && $status >= 400 && $status < 500) {
                $this->lastTransportRejection = $failure;
                $this->lastTransportRejectionProof = $this->lastTransportRequest + ['status' => $status, 'code' => $failure->getErrorCode(), 'provenance' => 'guzzle-http-response-v1'];
            }
            throw $failure;
        }
        return $json;
    }
    /** Low-level callers own stable keys and reconciliation; mutations are never automatically retried. */
    public function request(string $method, string $uri, array $options = []): mixed
    {
        $method = strtoupper($method);
        if ($method !== 'GET' && strncmp($uri, '/v1/', 4) === 0 && empty($options['headers']['Idempotency-Key'])) Manifest::fail('INVALID_REQUEST', 'A caller-managed mutation requires a stable Idempotency-Key');
        if (isset($options['json']) && $options['json'] === []) $options['json'] = new \stdClass();
        $attempts = $method === 'GET' && empty($options['cv_no_retries']) ? $this->maxRetries : 0;
        unset($options['cv_no_retries']);
        for ($i = 0; ; $i++) {
            try { return $this->checked($this->send($method, $uri, $options)); }
            catch (NetworkError $error) { if ($i >= $attempts) throw $error; usleep(min(250000, 10000 * (2 ** $i))); }
        }
    }
    public function download(string $uri, array $entry, $destination): void
    {
        Manifest::canonical(['schemaVersion' => 1, 'entries' => [$entry]], $this->limits);
        $response = $this->send('GET', $uri, ['stream' => true]);
        if ($response->getStatusCode() !== 200) { $this->checked($response); throw new NetworkError('Unexpected download response'); }
        $body = $response->getBody();
        try {
            if ($response->getHeaderLine('X-Content-SHA256') !== $entry['sha256'] || $response->getHeaderLine('Content-Length') !== (string) $entry['byteLength'] || strtolower(explode(';', $response->getHeaderLine('Content-Type'))[0]) !== 'application/octet-stream') Manifest::fail('RECEIPT_MISMATCH', 'Download metadata differs from manifest');
            $hash = hash_init('sha256'); $length = 0;
            while (!$body->eof()) {
                $chunk = $body->read($this->limits['maxChunkBytes']);
                if ($chunk === '' && !$body->eof()) throw new NetworkError('Download made no progress');
                $length += strlen($chunk);
                if ($length > $entry['byteLength']) Manifest::fail('RECEIPT_MISMATCH', 'Download exceeds declared length');
                hash_update($hash, $chunk); LocalFiles::write($destination, $chunk);
            }
            if ($length !== $entry['byteLength'] || hash_final($hash) !== $entry['sha256']) Manifest::fail('RECEIPT_MISMATCH', 'Download bytes differ from manifest');
            LocalFiles::flush($destination);
        } catch (\RuntimeException $error) { if ($error instanceof ContextVaultException) throw $error; throw new NetworkError('Incomplete download', $error); }
        finally { $body->close(); }
    }
    /** A descriptor-backed Guzzle body streams bytes through ext-curl without JSON/base64 conversion. */
    public function upload(string $uri, string $privateFilePath, array $entry, string $key): array
    {
        Manifest::canonical(['schemaVersion' => 1, 'entries' => [$entry]], $this->limits);
        $file = LocalFiles::openRegular(dirname($privateFilePath), basename($privateFilePath));
        try {
            LocalFiles::verify($file, $entry, $this->limits); rewind($file);
            $body = new \GuzzleHttp\Psr7\PumpStream(function (int $length) use ($file) {
                if (feof($file)) return false;
                $bytes = fread($file, min($length, $this->limits['maxChunkBytes']));
                if ($bytes === false) Manifest::fail('LOCAL_IO_ERROR', 'Immutable upload read failed');
                return $bytes === '' && feof($file) ? false : $bytes;
            }, ['size' => $entry['byteLength']]);
            $result = $this->request('PUT', $uri, ['body' => $body, 'headers' => ['Idempotency-Key' => $key,
                'Content-Type' => 'application/octet-stream', 'Content-Length' => (string) $entry['byteLength'], 'X-Content-SHA256' => $entry['sha256']]]);
            if (($result['path'] ?? null) !== $entry['path'] || ($result['sha256'] ?? null) !== $entry['sha256'] || ($result['byteLength'] ?? null) !== $entry['byteLength'] || !is_string($result['id'] ?? null)) Manifest::fail('RECEIPT_MISMATCH', 'Receipt differs from immutable capture');
            rewind($file); LocalFiles::verify($file, $entry, $this->limits);
            return $result;
        } finally { if (is_resource($file)) fclose($file); }
    }
}

<?php

declare(strict_types=1);

namespace ContextVault\Exception;

use RuntimeException;

class ContextVaultException extends RuntimeException
{
    protected int $statusCode;
    protected ?array $responseBody;
    protected ?string $localRecoveryPath = null;

    public function __construct(
        string $message = '',
        int $statusCode = 0,
        ?array $responseBody = null,
        ?\Throwable $previous = null
    ) {
        $this->statusCode = $statusCode;
        $this->responseBody = $responseBody;
        parent::__construct($message, $statusCode, $previous);
    }

    public function getStatusCode(): int
    {
        return $this->statusCode;
    }

    public function getResponseBody(): ?array
    {
        return $this->responseBody;
    }

    public function getErrorCode(): string
    {
        return $this->responseBody['error']['code'] ?? ($this->statusCode === 0 ? 'NETWORK_ERROR' : 'HTTP_ERROR');
    }

    public function withRecoveryPath(string $path): self { $this->localRecoveryPath = $path; return $this; }
    public function getRecoveryPath(): ?string { return $this->localRecoveryPath; }
}

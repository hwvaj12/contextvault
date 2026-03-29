<?php

declare(strict_types=1);

namespace ContextVault\Exception;

use RuntimeException;

class ContextVaultException extends RuntimeException
{
    protected int $statusCode;
    protected ?array $responseBody;

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
}

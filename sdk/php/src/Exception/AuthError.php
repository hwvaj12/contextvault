<?php

declare(strict_types=1);

namespace ContextVault\Exception;

class AuthError extends ContextVaultException
{
    public function __construct(
        string $message = 'Authentication failed',
        int $statusCode = 401,
        ?array $responseBody = null,
        ?\Throwable $previous = null
    ) {
        parent::__construct($message, $statusCode, $responseBody, $previous);
    }
}

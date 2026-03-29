<?php

declare(strict_types=1);

namespace ContextVault\Exception;

class ValidationError extends ContextVaultException
{
    public function __construct(
        string $message = 'Validation error',
        int $statusCode = 400,
        ?array $responseBody = null,
        ?\Throwable $previous = null
    ) {
        parent::__construct($message, $statusCode, $responseBody, $previous);
    }
}

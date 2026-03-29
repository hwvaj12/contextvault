<?php

declare(strict_types=1);

namespace ContextVault\Exception;

/**
 * Thrown when the server returns a conflict (HTTP 409).
 */
class ConflictError extends ContextVaultException
{
    public function __construct(
        string $message = 'Conflict',
        ?array $responseBody = null,
        ?\Throwable $previous = null
    ) {
        parent::__construct($message, 409, $responseBody, $previous);
    }
}

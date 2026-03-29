<?php

declare(strict_types=1);

namespace ContextVault\Exception;

class NotFoundError extends ContextVaultException
{
    public function __construct(
        string $message = 'Resource not found',
        ?array $responseBody = null,
        ?\Throwable $previous = null
    ) {
        parent::__construct($message, 404, $responseBody, $previous);
    }
}

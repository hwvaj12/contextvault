<?php

declare(strict_types=1);

namespace ContextVault\Exception;

class NetworkError extends ContextVaultException
{
    public function __construct(
        string $message = 'Network error',
        ?\Throwable $previous = null
    ) {
        parent::__construct($message, 0, null, $previous);
    }
}

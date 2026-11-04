<?php
declare(strict_types=1);
namespace ContextVault\Exception;

class OutcomeUnknownError extends ContextVaultException
{
    private ?string $recoveryPath;
    public function __construct(string $message, ?string $recoveryPath = null, ?\Throwable $previous = null)
    {
        $this->recoveryPath = $recoveryPath;
        parent::__construct($message, 0, ['error' => ['code' => 'PUBLICATION_OUTCOME_UNKNOWN', 'retryable' => true]], $previous);
    }
    public function getRecoveryPath(): ?string { return $this->recoveryPath; }
}

<?php
declare(strict_types=1);
require_once __DIR__ . '/Harness.php';
final class CheckpointTest extends PHPUnit\Framework\TestCase
{
    public function testCheckpointReopensWithoutRepeatingPublication(): void
    {
        foreach (PhpSdkHarness::results() as $result) self::assertTrue($result['checkpoint']);
    }
}

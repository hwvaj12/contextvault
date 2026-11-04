<?php
declare(strict_types=1);
require_once __DIR__ . '/Harness.php';
final class RecoveryTest extends PHPUnit\Framework\TestCase
{
    public function testDurableOriginalCommandsAndImmutableCaptureSurviveRestart(): void
    {
        foreach (PhpSdkHarness::results() as $result) { self::assertTrue($result['recovery']); self::assertTrue($result['corrections']); }
    }
}

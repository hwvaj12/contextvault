<?php
declare(strict_types=1);
require_once __DIR__ . '/Harness.php';
final class WorkspaceLifecycleTest extends PHPUnit\Framework\TestCase
{
    public function testInstalledLifecycleAndSafeCanonicalFiles(): void
    {
        foreach (PhpSdkHarness::results() as $result) self::assertTrue($result['lifecycle']);
    }
}

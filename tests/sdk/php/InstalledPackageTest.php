<?php
declare(strict_types=1);
require_once __DIR__ . '/Harness.php';

final class InstalledPackageTest extends PHPUnit\Framework\TestCase
{
    public function testComposerInstalledClientExecutesOnPhp80ForBothBackends(): void
    {
        $results = PhpSdkHarness::results();
        self::assertSame(['git', 's3'], array_keys($results));
        foreach ($results as $result) {
            self::assertSame('8.0.30', $result['runtime']);
            self::assertTrue($result['installed']);
        }
    }
}

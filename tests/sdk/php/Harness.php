<?php
declare(strict_types=1);

final class PhpSdkHarness
{
    private static ?array $results = null;
    private static ?Throwable $failure = null;

    public static function results(): array
    {
        if (self::$results !== null) return self::$results;
        if (self::$failure !== null) throw self::$failure;
        $command = [getenv('CV_TEST_SERVER_NODE') ?: 'node', __DIR__ . '/installed.mjs'];
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', 'php://stderr', 'w']], $pipes);
        if (!is_resource($process)) throw new RuntimeException('Could not start installed PHP acceptance');
        fclose($pipes[0]);
        $output = stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        $status = proc_close($process);
        if ($status !== 0) { self::$failure = new RuntimeException("Installed PHP acceptance failed ($status): $output"); throw self::$failure; }
        self::$results = json_decode($output, true, 512, JSON_THROW_ON_ERROR);
        return self::$results;
    }
}

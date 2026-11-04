<?php
declare(strict_types=1);
namespace ContextVault;

use ContextVault\Exception\ContextVaultException;

/** Canonical complete snapshots use unsigned UTF-8 sorting and exact JSON field order. */
final class Manifest
{
    public const LIMITS = ['maxEntries' => 10000, 'maxPathBytes' => 1024, 'maxComponentBytes' => 255,
        'maxFileBytes' => 67108864, 'maxTotalBytes' => 536870912, 'maxConcurrentStreams' => 4, 'maxChunkBytes' => 65536];

    public static function fail(string $code, string $message): void
    {
        throw new ContextVaultException($message, 0, ['error' => ['code' => $code]]);
    }
    public static function limits(array $overrides = []): array
    {
        if (array_diff_key($overrides, self::LIMITS)) self::fail('INVALID_REQUEST', 'Unknown workspace limit');
        $limits = array_replace(self::LIMITS, $overrides);
        foreach ($limits as $value) if (!is_int($value) || $value < 1 || $value > 9007199254740991) self::fail('INVALID_REQUEST', 'Limits must be positive safe integers');
        return $limits;
    }
    /** Metadata bounds follow the full entry/path quotas; content bytes never enter these JSON documents. */
    public static function metadataBudget(array $overrides = [], bool $journal = false): int
    {
        $limits = self::limits($overrides);
        $factor = $journal ? 6 : 1; $headroom = $journal ? 4194304 : 1048576;
        if ($limits['maxPathBytes'] > PHP_INT_MAX - 192 || $limits['maxEntries'] > intdiv(PHP_INT_MAX - $headroom, $factor * ($limits['maxPathBytes'] + 192))) self::fail('INVALID_REQUEST', 'Configured metadata budget exceeds this runtime');
        return $headroom + $factor * $limits['maxEntries'] * ($limits['maxPathBytes'] + 192);
    }
    public static function portableKey(string $value): string
    {
        $normalized = \Normalizer::normalize($value, \Normalizer::FORM_KC);
        if ($normalized === false) self::fail('INVALID_MANIFEST', 'Names require valid Unicode');
        return mb_strtolower(mb_strtoupper($normalized, 'UTF-8'), 'UTF-8');
    }
    public static function controlName(string $name): bool { return in_array(self::portableKey($name), ['.git', '.contextvault'], true); }
    public static function path($value, array $overrides = []): string
    {
        $limits = self::limits($overrides);
        if (!is_string($value) || $value === '' || !preg_match('//u', $value) || \Normalizer::normalize($value, \Normalizer::FORM_C) !== $value) self::fail('INVALID_MANIFEST', 'Paths require valid Unicode NFC names');
        if (strlen($value) > $limits['maxPathBytes']) self::fail('QUOTA_EXCEEDED', 'Path byte limit exceeded');
        if (preg_match('/[\\\\\x00-\x1f\x7f<>:"|?*]/u', $value)) self::fail('INVALID_MANIFEST', 'Nonportable path character');
        foreach (explode('/', $value) as $part) {
            if ($part === '' || $part === '.' || $part === '..' || preg_match('/[. ]$/u', $part) || self::controlName($part) || preg_match('/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu', $part)) self::fail('INVALID_MANIFEST', 'Unsafe or reserved path component');
            if (strlen($part) > $limits['maxComponentBytes']) self::fail('QUOTA_EXCEEDED', 'Component byte limit exceeded');
        }
        return $value;
    }
    private static function keys(array $value, array $expected): void
    {
        $keys = array_keys($value); sort($keys); sort($expected);
        if ($keys !== $expected) self::fail('INVALID_MANIFEST', 'Unsupported or missing manifest fields');
    }
    public static function canonical(array $input, array $overrides = []): array
    {
        $limits = self::limits($overrides);
        self::keys($input, ['schemaVersion', 'entries']);
        if ($input['schemaVersion'] !== 1 || !is_array($input['entries']) || array_values($input['entries']) !== $input['entries']) self::fail('INVALID_MANIFEST', 'Expected a complete manifest v1');
        if (count($input['entries']) > $limits['maxEntries']) self::fail('QUOTA_EXCEEDED', 'Entry limit exceeded');
        $entries = []; $paths = []; $prefixes = []; $total = 0;
        foreach ($input['entries'] as $raw) {
            if (!is_array($raw)) self::fail('INVALID_MANIFEST', 'Invalid manifest entry');
            $path = self::path($raw['path'] ?? null, $limits);
            if (isset($paths[$path])) self::fail('INVALID_MANIFEST', 'Duplicate path');
            $parts = explode('/', $path);
            for ($i = 1; $i <= count($parts); $i++) {
                $prefix = implode('/', array_slice($parts, 0, $i)); $key = self::portableKey($prefix);
                if (isset($prefixes[$key]) && $prefixes[$key] !== $prefix) self::fail('INVALID_MANIFEST', 'Portable-name collision');
                $prefixes[$key] = $prefix;
            }
            if (($raw['kind'] ?? null) === 'directory') {
                self::keys($raw, ['path', 'kind']); $entry = ['path' => $path, 'kind' => 'directory'];
            } elseif (($raw['kind'] ?? null) === 'file') {
                self::keys($raw, ['path', 'kind', 'byteLength', 'sha256']);
                if (!is_int($raw['byteLength']) || $raw['byteLength'] < 0 || $raw['byteLength'] > 9007199254740991 || !is_string($raw['sha256']) || !preg_match('/^[a-f0-9]{64}$/D', $raw['sha256'])) self::fail('INVALID_MANIFEST', 'Invalid file length or SHA-256');
                $total += $raw['byteLength'];
                if ($raw['byteLength'] > $limits['maxFileBytes'] || $total > $limits['maxTotalBytes']) self::fail('QUOTA_EXCEEDED', 'Content byte limit exceeded');
                $entry = ['path' => $path, 'kind' => 'file', 'byteLength' => $raw['byteLength'], 'sha256' => $raw['sha256']];
            } else { self::fail('INVALID_MANIFEST', 'Only regular files and directories are supported'); }
            $paths[$path] = $entry['kind']; $entries[] = $entry;
        }
        foreach ($entries as $entry) {
            $parts = explode('/', $entry['path']);
            for ($i = 1; $i < count($parts); $i++) if (($paths[implode('/', array_slice($parts, 0, $i))] ?? null) === 'file') self::fail('INVALID_MANIFEST', 'File contains another entry');
        }
        usort($entries, static fn(array $a, array $b): int => strcmp($a['path'], $b['path']));
        return ['schemaVersion' => 1, 'entries' => $entries];
    }
    public static function bytes(array $input, array $limits = []): string
    {
        return json_encode(self::canonical($input, $limits), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS | JSON_THROW_ON_ERROR);
    }
    public static function digest(array $input, array $limits = []): string { return hash('sha256', self::bytes($input, $limits)); }
}

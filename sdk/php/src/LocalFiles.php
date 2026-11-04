<?php
declare(strict_types=1);
namespace ContextVault;

/** POSIX identity validation for stopped writers; this is not hostile same-UID containment. */
final class LocalFiles
{
    private static function stat(string $path): array
    {
        clearstatcache(true, $path); $stat = @lstat($path);
        if ($stat === false) Manifest::fail('UNSAFE_LOCAL_STATE', 'Local path is missing or unreadable: ' . $path);
        return $stat;
    }
    public static function identity(string $path): string { $stat = self::stat($path); return $stat['dev'] . ':' . $stat['ino']; }
    public static function directory(string $path): void
    {
        if ($path === '' || $path[0] !== '/' || strpos($path, "\0") !== false) Manifest::fail('UNSAFE_LOCAL_STATE', 'Local roots must be absolute');
        $current = '';
        foreach (explode('/', $path) as $part) {
            if ($part === '') continue;
            if ($part === '.' || $part === '..') Manifest::fail('UNSAFE_LOCAL_STATE', 'Unsafe local ancestry');
            $current .= '/' . $part; $stat = self::stat($current);
            if (($stat['mode'] & 0170000) !== 0040000) Manifest::fail('UNSAFE_LOCAL_STATE', 'Local ancestry contains a link or non-directory');
        }
    }
    public static function mkdir(string $path): void
    {
        if (is_dir($path) || is_link($path)) { self::directory($path); return; }
        self::directory(dirname($path));
        $old = umask(0077);
        try { if (!@mkdir($path, 0700)) Manifest::fail('LOCAL_IO_ERROR', 'Could not create private directory'); }
        finally { umask($old); }
        self::directory($path);
    }
    public static function parents(string $root, string $relative): string
    {
        Manifest::path($relative); self::directory($root); $current = $root;
        foreach (array_slice(explode('/', $relative), 0, -1) as $part) { $current .= '/' . $part; self::mkdir($current); }
        return $root . '/' . $relative;
    }
    public static function unique(string $parent, string $prefix): string
    {
        self::directory($parent); $path = rtrim($parent, '/') . '/' . $prefix . bin2hex(random_bytes(16)); self::mkdir($path); return $path;
    }
    public static function createFile(string $path)
    {
        self::directory(dirname($path)); $old = umask(0077);
        try { $file = @fopen($path, 'x+b'); }
        finally { umask($old); }
        if ($file === false) Manifest::fail('LOCAL_IO_ERROR', 'Could not create owned file');
        return $file;
    }
    public static function write($file, string $bytes): void
    {
        $offset = 0;
        while ($offset < strlen($bytes)) {
            $written = fwrite($file, substr($bytes, $offset));
            if ($written === false || $written === 0) Manifest::fail('LOCAL_IO_ERROR', 'Local write made no progress');
            $offset += $written;
        }
    }
    public static function flush($file): void
    {
        if (!fflush($file)) Manifest::fail('LOCAL_IO_ERROR', 'Could not flush local file');
        // PHP 8.0 has no fsync(). Atomic files support process restart, not physical power-loss guarantees.
        if (function_exists('fsync') && !fsync($file)) Manifest::fail('LOCAL_IO_ERROR', 'Could not synchronize local file');
    }
    public static function openRegular(string $root, string $relative)
    {
        Manifest::path($relative); $path = $root . '/' . $relative; self::directory(dirname($path));
        $before = self::stat($path);
        if (($before['mode'] & 0170000) !== 0100000 || $before['nlink'] !== 1) Manifest::fail('INVALID_MANIFEST', 'Only regular files with one link are supported');
        $file = @fopen($path, 'rb');
        if ($file === false) Manifest::fail('LOCAL_IO_ERROR', 'Could not open local regular file');
        $opened = fstat($file); $after = self::stat($path);
        if (($opened['mode'] & 0170000) !== 0100000 || $opened['nlink'] !== 1 || $before['dev'] !== $opened['dev'] || $before['ino'] !== $opened['ino'] || $after['ino'] !== $opened['ino'] || $after['dev'] !== $opened['dev']) { fclose($file); Manifest::fail('CAPTURE_CHANGED', 'Local file identity changed'); }
        self::directory(dirname($path)); return $file;
    }
    public static function verify($file, array $entry, array $limits): void
    {
        $hash = hash_init('sha256'); $length = 0;
        while (!feof($file)) {
            $bytes = fread($file, $limits['maxChunkBytes']);
            if ($bytes === false || ($bytes === '' && !feof($file))) Manifest::fail('LOCAL_IO_ERROR', 'Local read made no progress');
            $length += strlen($bytes);
            if ($length > $entry['byteLength']) Manifest::fail('RECEIPT_MISMATCH', 'Local bytes exceed immutable declaration');
            hash_update($hash, $bytes);
        }
        if ($length !== $entry['byteLength'] || hash_final($hash) !== $entry['sha256']) Manifest::fail('RECEIPT_MISMATCH', 'Local bytes differ from immutable declaration');
    }
    private static function stamp(array $stat): array { return array_intersect_key($stat, array_flip(['dev', 'ino', 'mode', 'nlink', 'size', 'mtime', 'ctime'])); }
    public static function walk(string $root, array $limits, bool $includeControl = false): array
    {
        self::directory($root); $entries = [];
        $visit = function (string $relative) use (&$visit, &$entries, $root, $limits, $includeControl): void {
            $parent = $relative === '' ? $root : $root . '/' . $relative; self::directory($parent);
            $names = scandir($parent);
            if ($names === false) Manifest::fail('LOCAL_IO_ERROR', 'Could not list local directory');
            foreach ($names as $name) {
                if ($name === '.' || $name === '..' || (!$includeControl && Manifest::controlName($name))) continue;
                $path = $relative === '' ? $name : $relative . '/' . $name;
                if (!$includeControl) Manifest::path($path, $limits);
                $stat = self::stat($root . '/' . $path); $kind = $stat['mode'] & 0170000;
                if (!in_array($kind, [0040000, 0100000], true) || ($kind === 0100000 && $stat['nlink'] !== 1)) Manifest::fail('INVALID_MANIFEST', 'Local tree contains a link or special file');
                $entries[] = ['path' => $path, 'kind' => $kind === 0040000 ? 'directory' : 'file', 'stamp' => self::stamp($stat)];
                if (!$includeControl && count($entries) > $limits['maxEntries']) Manifest::fail('QUOTA_EXCEEDED', 'Local entry limit exceeded');
                if ($kind === 0040000) $visit($path);
            }
        };
        $visit(''); usort($entries, static fn(array $a, array $b): int => strcmp($a['path'], $b['path'])); return $entries;
    }
    public static function clear(string $root, bool $removeRoot = false): void
    {
        $entries = self::walk($root, Manifest::LIMITS, true); // Validate everything before deleting anything.
        usort($entries, static fn(array $a, array $b): int => substr_count($b['path'], '/') <=> substr_count($a['path'], '/'));
        foreach ($entries as $entry) {
            $path = $root . '/' . $entry['path']; self::directory(dirname($path));
            $current = self::stamp(self::stat($path));
            $expected = $entry['stamp'];
            // Removing children changes directory timestamps and link counts. Its identity must remain the same.
            if ($entry['kind'] === 'directory') {
                $current = array_intersect_key($current, array_flip(['dev', 'ino', 'mode']));
                $expected = array_intersect_key($expected, array_flip(['dev', 'ino', 'mode']));
            }
            if ($current !== $expected) Manifest::fail('CAPTURE_CHANGED', 'Local tree changed before cleanup');
            if (!($entry['kind'] === 'directory' ? @rmdir($path) : @unlink($path))) Manifest::fail('LOCAL_IO_ERROR', 'Local cleanup failed');
        }
        if ($removeRoot && !@rmdir($root)) Manifest::fail('LOCAL_IO_ERROR', 'Owned directory cleanup failed');
    }
    public static function capture(string $root, string $privateDirectory, array $limits, ?callable $reserveOwnership = null): array
    {
        $listed = self::walk($root, $limits); $entries = [];
        foreach ($listed as $item) $entries[] = $item['kind'] === 'directory' ? ['path' => $item['path'], 'kind' => 'directory'] : ['path' => $item['path'], 'kind' => 'file', 'byteLength' => $item['stamp']['size'], 'sha256' => str_repeat('0', 64)];
        Manifest::canonical(['schemaVersion' => 1, 'entries' => $entries], $limits);
        $directory = self::unique($privateDirectory, 'capture-');
        try {
            // The session persists this identity before any captured payload can exist.
            if ($reserveOwnership !== null) $reserveOwnership(['captureId' => basename($directory), 'directory' => $directory, 'identity' => self::identity($directory)]);
            foreach ($entries as &$entry) {
                $target = self::parents($directory, $entry['path']);
                if ($entry['kind'] === 'directory') { self::mkdir($target); continue; }
                $source = self::openRegular($root, $entry['path']); $destination = self::createFile($target);
                $hash = hash_init('sha256'); $length = 0;
                try {
                    while (!feof($source)) {
                        $bytes = fread($source, $limits['maxChunkBytes']);
                        if ($bytes === false || ($bytes === '' && !feof($source))) Manifest::fail('CAPTURE_CHANGED', 'Source read failed');
                        $length += strlen($bytes);
                        if ($length > $entry['byteLength']) Manifest::fail('CAPTURE_CHANGED', 'Source grew during capture');
                        hash_update($hash, $bytes); self::write($destination, $bytes);
                    }
                    if ($length !== $entry['byteLength']) Manifest::fail('CAPTURE_CHANGED', 'Source changed during capture');
                    $entry['sha256'] = hash_final($hash); self::flush($destination);
                    rewind($source);
                    try { self::verify($source, $entry, $limits); } catch (\Throwable $error) { Manifest::fail('CAPTURE_CHANGED', 'Source changed during capture'); }
                } finally { fclose($source); fclose($destination); }
                if (!chmod($target, 0600)) Manifest::fail('LOCAL_IO_ERROR', 'Could not protect private capture');
            }
            unset($entry);
            if (self::walk($root, $limits) !== $listed) Manifest::fail('CAPTURE_CHANGED', 'Source tree changed during capture');
            $manifest = Manifest::canonical(['schemaVersion' => 1, 'entries' => $entries], $limits);
            self::mkdir($directory . '/.contextvault'); $manifestPath = $directory . '/.contextvault/manifest.json';
            self::atomicJson($manifestPath, $manifest, Manifest::metadataBudget($limits));
            return ['captureId' => basename($directory), 'directory' => $directory, 'identity' => self::identity($directory), 'manifest' => $manifest,
                'manifestPath' => $manifestPath, 'manifestDigest' => Manifest::digest($manifest, $limits)];
        } catch (\Throwable $error) { self::clear($directory, true); throw $error; }
    }
    public static function hydrate(Client $client, string $runId, string $root, string $staging): array
    {
        $manifest = $client->runs()->manifest($runId);
        foreach ($manifest['entries'] as $entry) {
            $target = self::parents($staging, $entry['path']);
            if ($entry['kind'] === 'directory') { self::mkdir($target); continue; }
            $file = self::createFile($target);
            try { $client->download(Runs::route($runId) . '/workspace/files?' . http_build_query(['path' => $entry['path']], '', '&', PHP_QUERY_RFC3986), $entry, $file); }
            finally { fclose($file); }
        }
        self::clear($root);
        foreach (scandir($staging) as $name) {
            if ($name === '.' || $name === '..') continue;
            if (!rename($staging . '/' . $name, $root . '/' . $name)) Manifest::fail('LOCAL_IO_ERROR', 'Hydration replacement failed');
        }
        self::clear($staging, true); return $manifest;
    }
    public static function atomicJson(string $path, array $value, ?int $maximumBytes = null): void
    {
        $maximumBytes = $maximumBytes ?? Manifest::metadataBudget([], true);
        if ($maximumBytes < 1) Manifest::fail('INVALID_REQUEST', 'Invalid metadata budget');
        $bytes = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS | JSON_THROW_ON_ERROR);
        // Reject before opening a temporary or replacing the previous readable journal.
        if (strlen($bytes) > $maximumBytes) Manifest::fail('QUOTA_EXCEEDED', 'Private metadata exceeds its bounded journal budget');
        self::directory(dirname($path));
        if (file_exists($path) || is_link($path)) {
            $stat = self::stat($path);
            if (($stat['mode'] & 0170000) !== 0100000 || $stat['nlink'] !== 1) Manifest::fail('UNSAFE_LOCAL_STATE', 'Unsafe private state file');
        }
        $temporary = dirname($path) . '/state-' . Client::key(); $file = self::createFile($temporary);
        try { self::write($file, $bytes); self::flush($file); }
        finally { fclose($file); }
        if (!rename($temporary, $path)) Manifest::fail('LOCAL_IO_ERROR', 'Could not atomically save private state');
    }
    public static function readJson(string $path, ?int $maximumBytes = null): array
    {
        $maximumBytes = $maximumBytes ?? Manifest::metadataBudget([], true);
        if ($maximumBytes < 1) Manifest::fail('INVALID_REQUEST', 'Invalid metadata budget');
        $file = self::openRegular(dirname($path), basename($path));
        try {
            $stat = fstat($file);
            if (($stat['mode'] & 0777) !== 0600 || $stat['size'] > $maximumBytes) Manifest::fail('CORRUPT_LOCAL_STATE', 'Invalid private metadata mode or bounded length');
            $bytes = stream_get_contents($file, $maximumBytes);
            try { $value = json_decode($bytes, true, 512, JSON_THROW_ON_ERROR); }
            catch (\JsonException $error) { Manifest::fail('CORRUPT_LOCAL_STATE', 'Private state is corrupt; retain files for recovery'); }
            if (!is_array($value)) Manifest::fail('CORRUPT_LOCAL_STATE', 'Private state must contain a recovery envelope');
            return $value;
        } finally { fclose($file); }
    }
}

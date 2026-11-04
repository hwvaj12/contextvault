<?php
declare(strict_types=1);
namespace ContextVault;

function rmdir(string $path): bool
{
    if (($GLOBALS['cvCorrectionRoot'] ?? null) === $path && empty($GLOBALS['cvCorrectionRootFired'])) {
        $GLOBALS['cvCorrectionRootFired'] = true;
        if (($GLOBALS['cvCorrectionRootMode'] ?? 'before') === 'after') \rmdir($path);
        throw new \RuntimeException('Injected owned-root removal interruption');
    }
    return \rmdir($path);
}

function fwrite($stream, string $bytes)
{
    $written = \fwrite($stream, $bytes);
    $pause = $GLOBALS['cvCorrectionCapturePause'] ?? null;
    if ($pause !== null && preg_match('~/capture-[a-f0-9]{32}/~', \stream_get_meta_data($stream)['uri'])) {
        \fflush($stream);
        \file_put_contents($pause, 'capture bytes exist');
        \usleep(10000000);
    }
    return $written;
}

"""Portable complete snapshots and checked local files, independent of server source."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import unicodedata
import uuid

from .exceptions import ConflictError, ValidationError

DEFAULT_LIMITS = dict(maxEntries=10000, maxPathBytes=1024, maxComponentBytes=255,
                      maxFileBytes=64 * 1024 * 1024, maxTotalBytes=512 * 1024 * 1024,
                      maxConcurrentStreams=4, maxChunkBytes=64 * 1024)


def limits(overrides=None):
    value = dict(DEFAULT_LIMITS)
    value.update(overrides or {})
    if set(value) != set(DEFAULT_LIMITS) or any(type(v) is not int or v < 1 or v > 9007199254740991 for v in value.values()):
        raise ValidationError("Workspace limits must be positive safe integers", code="INVALID_REQUEST")
    return value


def invalid(message, code="INVALID_MANIFEST"):
    raise ValidationError(message, code=code)


def portable_key(value):
    return unicodedata.normalize("NFKC", value).upper().lower()


def is_control_metadata(name):
    return portable_key(name) in (".git", ".contextvault")


def portable_path(value, configured=None):
    configured = limits(configured)
    if not isinstance(value, str) or not value or unicodedata.normalize("NFC", value) != value or any(0xD800 <= ord(c) <= 0xDFFF for c in value):
        invalid("Paths must use nonempty valid Unicode NFC relative names")
    if len(value.encode("utf-8")) > configured["maxPathBytes"]:
        invalid("Path byte limit exceeded", "QUOTA_EXCEEDED")
    if re.search(r'[\\\x00-\x1f\x7f<>:"|?*]', value):
        invalid("Path contains a nonportable character")
    for component in value.split("/"):
        if component in ("", ".", "..") or component[-1:] in (".", " "):
            invalid("Path contains an unsafe component")
        if len(component.encode("utf-8")) > configured["maxComponentBytes"]:
            invalid("Path component byte limit exceeded", "QUOTA_EXCEEDED")
        if is_control_metadata(component) or re.match(r"^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", component, re.I):
            invalid("Path contains reserved metadata or a Windows name")
    return value


def canonical_manifest(value, configured=None):
    configured = limits(configured)
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "entries"} or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1 or not isinstance(value["entries"], list):
        invalid("Expected a manifest v1 complete snapshot")
    if len(value["entries"]) > configured["maxEntries"]:
        invalid("Manifest entry limit exceeded", "QUOTA_EXCEEDED")
    paths, prefixes, entries, total = {}, {}, [], 0
    for raw in value["entries"]:
        if not isinstance(raw, dict):
            invalid("Manifest entries must be objects")
        name = portable_path(raw.get("path"), configured)
        if name in paths:
            invalid("Manifest contains duplicate paths")
        components = name.split("/")
        for length in range(1, len(components) + 1):
            prefix = "/".join(components[:length])
            key = portable_key(prefix)
            if key in prefixes and prefixes[key] != prefix:
                invalid("Manifest contains portable-name collisions")
            prefixes[key] = prefix
        kind = raw.get("kind")
        entry = dict(path=name, kind=kind)
        if kind == "directory" and set(raw) == {"path", "kind"}:
            pass
        elif kind == "file" and set(raw) == {"path", "kind", "byteLength", "sha256"}:
            size = raw["byteLength"]
            if type(size) is not int or size < 0 or size > 9007199254740991 or not isinstance(raw["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", raw["sha256"]):
                invalid("Invalid file length or lowercase SHA-256")
            total += size
            if size > configured["maxFileBytes"] or total > configured["maxTotalBytes"]:
                invalid("Workspace byte limit exceeded", "QUOTA_EXCEEDED")
            entry.update(byteLength=size, sha256=raw["sha256"])
        else:
            invalid("Manifest contains unsupported kinds or fields")
        paths[name] = entry
        entries.append(entry)
    for name in paths:
        components = name.split("/")
        for length in range(1, len(components)):
            if paths.get("/".join(components[:length]), {}).get("kind") == "file":
                invalid("A regular file cannot contain another entry")
    entries.sort(key=lambda entry: entry["path"].encode("utf-8"))
    return dict(schemaVersion=1, entries=entries)


def canonical_manifest_bytes(value, configured=None):
    return json.dumps(canonical_manifest(value, configured), ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def safe_directory(path, create=False):
    if not os.path.isabs(path):
        invalid("Filesystem roots must be absolute")
    current = Path(Path(os.path.abspath(path)).anchor)
    for part in Path(os.path.abspath(path)).parts[1:]:
        current = current / part
        if create:
            try:
                os.mkdir(str(current), 0o700)
                sync_directory(str(current.parent))
            except FileExistsError:
                pass
        value = os.lstat(str(current))
        if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode):
            invalid("Filesystem ancestry contains a link or non-directory")


def sync_directory(path):
    safe_directory(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def identity(value):
    return value.st_dev, value.st_ino


def stamp(value):
    return identity(value) + (value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def open_regular(path):
    safe_directory(os.path.dirname(path))
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        invalid("Only regular files without hardlinks are accepted")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(descriptor)
        safe_directory(os.path.dirname(path))
        after = os.lstat(path)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or identity(before) != identity(opened) or identity(opened) != identity(after):
            invalid("File identity changed during open")
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def walk_workspace(root, configured=None, include_control=False):
    configured = limits(configured)
    safe_directory(root)
    found = []
    def visit(parent, prefix):
        safe_directory(parent)
        with os.scandir(parent) as children:
            for child in children:
                if not include_control and is_control_metadata(child.name):
                    continue
                relative = prefix + child.name
                if not include_control:
                    portable_path(relative, configured)
                value = child.stat(follow_symlinks=False)
                if not (stat.S_ISDIR(value.st_mode) or stat.S_ISREG(value.st_mode)) or (stat.S_ISREG(value.st_mode) and value.st_nlink != 1):
                    invalid("Workspace contains a link or special file")
                kind = "directory" if stat.S_ISDIR(value.st_mode) else "file"
                found.append((relative, kind, stamp(value)))
                if len(found) > configured["maxEntries"] and not include_control:
                    invalid("Workspace entry limit exceeded", "QUOTA_EXCEEDED")
                if kind == "directory":
                    visit(child.path, relative + "/")
    visit(root, "")
    found.sort(key=lambda entry: entry[0].encode("utf-8"))
    if not include_control:
        canonical_manifest(dict(schemaVersion=1, entries=[dict(path=name, kind=kind, **({"byteLength": mark[2], "sha256": "0" * 64} if kind == "file" else {})) for name, kind, mark in found]), configured)
    return found


def remove_workspace(root, preserve_root=False):
    # Validate the complete stopped tree before the first deletion, including control metadata.
    listed = walk_workspace(root, include_control=True)
    for name, kind, original in sorted(listed, key=lambda item: item[0].count("/"), reverse=True):
        path = os.path.join(root, *name.split("/"))
        safe_directory(os.path.dirname(path))
        current = os.lstat(path)
        if identity(current) != original[:2] or (kind == "directory" and not stat.S_ISDIR(current.st_mode)) or (kind == "file" and (not stat.S_ISREG(current.st_mode) or current.st_nlink != 1)):
            invalid("Workspace changed during cleanup")
        os.rmdir(path) if kind == "directory" else os.unlink(path)
    safe_directory(root)
    if not preserve_root:
        os.rmdir(root)
    sync_directory(root if preserve_root else os.path.dirname(root))


def capture_workspace(root, private_root, configured=None, *, on_owned=None):
    configured = limits(configured)
    safe_directory(root)
    safe_directory(private_root)
    if os.path.commonpath((root, private_root)) == root:
        invalid("Private capture must be outside submitted contents")
    before = walk_workspace(root, configured)
    capture_id = uuid.uuid4().hex
    target = tempfile.mkdtemp(prefix="capture-" + capture_id + "-", dir=private_root)
    os.chmod(target, 0o700)
    entries, files = [], {}
    try:
        sync_directory(private_root)
        if on_owned:
            # The session durably records this identity before any captured content is written.
            on_owned(dict(directory=target, directoryIdentity=list(identity(os.lstat(target)))))
        for index, (name, kind, original) in enumerate(before):
            entry = dict(path=name, kind=kind)
            if kind == "file":
                digest, length = hashlib.sha256(), 0
                destination = os.path.join(target, str(index))
                descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                with open_regular(os.path.join(root, *name.split("/"))) as source, os.fdopen(descriptor, "wb") as output:
                    if stamp(os.fstat(source.fileno())) != original:
                        raise ConflictError("Source changed before capture", code="CAPTURE_CHANGED")
                    while True:
                        chunk = source.read(configured["maxChunkBytes"])
                        if not chunk:
                            break
                        length += len(chunk)
                        if length > original[2]:
                            raise ConflictError("Source changed during capture", code="CAPTURE_CHANGED")
                        digest.update(chunk)
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                    if length != original[2] or stamp(os.fstat(source.fileno())) != original:
                        raise ConflictError("Source changed during capture", code="CAPTURE_CHANGED")
                entry.update(byteLength=length, sha256=digest.hexdigest())
                files[name] = dict(captureId=capture_id, privateFilePath=destination, byteLength=length, sha256=entry["sha256"])
            entries.append(entry)
        if walk_workspace(root, configured) != before:
            raise ConflictError("Workspace changed during capture", code="CAPTURE_CHANGED")
        manifest = canonical_manifest(dict(schemaVersion=1, entries=entries), configured)
        sync_directory(target)
        sync_directory(private_root)
        return dict(captureId=capture_id, directory=target, directoryIdentity=list(identity(os.lstat(target))), manifest=manifest, files=files)
    except BaseException:
        remove_workspace(target)
        raise


class VerifiedReader:
    def __init__(self, path, entry, configured=None):
        self.source = open_regular(path)
        self.entry = entry
        self.configured = limits(configured)
        self.digest = hashlib.sha256()
        self.length = 0
        self.verified = False
    def __len__(self):
        return self.entry["byteLength"]
    def __iter__(self):
        return self
    def __next__(self):
        chunk = self.source.read(self.configured["maxChunkBytes"])
        if not chunk:
            if self.length != self.entry["byteLength"] or self.digest.hexdigest() != self.entry["sha256"]:
                invalid("File bytes differ from declaration", "RECEIPT_MISMATCH")
            self.verified = True
            raise StopIteration
        self.length += len(chunk)
        if self.length > self.entry["byteLength"]:
            invalid("File exceeds declared length", "RECEIPT_MISMATCH")
        self.digest.update(chunk)
        return chunk
    def close(self):
        self.source.close()

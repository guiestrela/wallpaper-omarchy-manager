#!/usr/bin/python3
"""Open a pinned wallpaper without following symlinks and publish a private snapshot.

The source is opened component-by-component relative to directory file
 descriptors. The returned cache path names an atomically published copy, so Qt
 never reopens the attacker-replaceable source pathname.
"""
from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import sys
import time
from typing import TypedDict

_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
_SOURCE_FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
MAX_PINNED_BYTES = 4 * 1024 * 1024 * 1024
CACHE_MAX_ENTRIES = 32
CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024
CACHE_RETENTION_SECONDS = 7 * 24 * 60 * 60
LEASE_TTL_SECONDS = 7 * 24 * 60 * 60


class CacheEntry(TypedDict):
    name: str
    size: int
    mtime: float
    active: bool
    files: list[str]
    leases: list[str]


def _parts(path: str) -> list[str]:
    if not isinstance(path, str) or not path.startswith("/") or "\x00" in path:
        raise ValueError("path must be absolute")
    normalized = path.rstrip("/") or "/"
    if normalized == "/":
        return []
    components = normalized[1:].split("/")
    if any(part in ("", ".", "..") for part in components):
        raise ValueError("path contains an unsafe component")
    return components


def _open_directory(path: str, *, create: bool = False, private: bool = False) -> int:
    components = _parts(path)
    uid = os.getuid()
    fd = os.open("/", _DIRECTORY_FLAGS)
    try:
        for index, component in enumerate(components):
            try:
                next_fd = os.open(component, _DIRECTORY_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(component, 0o700, dir_fd=fd)
                next_fd = os.open(component, _DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            info = os.fstat(fd)
            if not stat.S_ISDIR(info.st_mode):
                raise OSError(errno.ENOTDIR, "path component is not a directory")
            if private and index == len(components) - 1:
                if info.st_uid != uid:
                    raise PermissionError(errno.EPERM, "private cache directory is not user-owned")
                if info.st_mode & 0o077:
                    os.fchmod(fd, 0o700)
            elif private:
                if info.st_uid not in (0, uid) and not info.st_mode & stat.S_ISVTX:
                    raise PermissionError(errno.EPERM, "cache path component has an untrusted owner")
                if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
                    raise PermissionError(errno.EPERM, "cache path component is writable by others")
        if private and os.fstat(fd).st_uid != uid:
            raise PermissionError(errno.EPERM, "private cache root is not user-owned")
        return fd
    except Exception:
        os.close(fd)
        raise


def _relative_pin(folder: str, pinned: str) -> str:
    root = folder.rstrip("/") or "/"
    if not pinned.startswith("/"):
        raise ValueError("pinned path must be absolute")
    prefix = "/" if root == "/" else root + "/"
    if not pinned.startswith(prefix):
        raise ValueError("pinned path is outside the configured folder")
    relative = pinned[len(prefix):]
    components = relative.split("/")
    if not relative or any(part in ("", ".", "..") for part in components):
        raise ValueError("pinned path is not a valid child of the configured folder")
    return relative


def _open_pin(root_fd: int, relative: str) -> int:
    components = relative.split("/")
    directory_fd = os.dup(root_fd)
    try:
        for component in components[:-1]:
            next_fd = os.open(component, _DIRECTORY_FLAGS, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        source_fd = os.open(components[-1], _SOURCE_FLAGS, dir_fd=directory_fd)
        info = os.fstat(source_fd)
        if not stat.S_ISREG(info.st_mode):
            os.close(source_fd)
            raise OSError(errno.EINVAL, "pinned media is not a regular file")
        return source_fd
    finally:
        os.close(directory_fd)


def _cache_root(cache_root: str | None) -> str:
    if cache_root is not None:
        return os.path.abspath(cache_root)
    home = os.environ.get("HOME", "")
    if not home.startswith("/"):
        raise ValueError("HOME is unavailable or not absolute")
    configured = os.environ.get("XDG_CACHE_HOME", "")
    base = configured if configured.startswith("/") else os.path.join(home, ".cache")
    return os.path.join(base, "omarchy", "wallpaperomarchymanager", "pinned")


def _process_start_time(pid: int) -> str | None:
    """Return Linux process start ticks so PID reuse cannot revive a lease."""
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="ascii") as stream:
            record = stream.read()
    except FileNotFoundError:
        return None
    except PermissionError:
        return "inaccessible"
    close = record.rfind(")")
    if close < 0:
        return None
    fields = record[close + 2:].split()  # begins at field 3; starttime is field 22
    return fields[19] if len(fields) > 19 and fields[19].isdigit() else None


def _lease_owner() -> tuple[int, str]:
    pid = os.getppid()
    started = _process_start_time(pid)
    if started is None:
        raise OSError(errno.ESRCH, "cannot identify the Quickshell lease owner")
    return pid, started


def _lease_name(pid: int, started: str, token: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{32}", token):
        raise ValueError("invalid snapshot lease token")
    return f".lease-{pid}-{started}-{token}"


def _lease_is_live(name: str, mtime: float, *, now: float | None = None) -> bool:
    match = re.fullmatch(r"\.lease-(\d{1,10})-(\d{1,20})-[a-f0-9]{32}", name)
    if not match:
        return False
    current_time = time.time() if now is None else now
    # A live shell PID alone does not prove the QML component still owns the
    # lease. The component renews active leases periodically; after unload,
    # the marker expires even if Quickshell itself remains alive.
    if mtime > current_time + 300 or current_time - mtime > LEASE_TTL_SECONDS:
        return False
    current = _process_start_time(int(match.group(1)))
    # An inaccessible process is treated as live only while its heartbeat is
    # fresh (checked above); a missing or reused PID is stale.
    if current == "inaccessible":
        return True
    return current == match.group(2)


def _valid_lease_child(name: str) -> bool:
    return re.fullmatch(r"\.lease-\d{1,10}-\d{1,20}-[a-f0-9]{32}", name) is not None


def _inspect_cache_entry(cache_fd: int, cache_path: str, name: str,
                         active_paths: set[str], *, now: float | None = None) -> CacheEntry | None:
    if not re.fullmatch(r"[a-f0-9]{64}", name):
        return None
    try:
        entry_fd = os.open(name, _DIRECTORY_FLAGS, dir_fd=cache_fd)
    except (FileNotFoundError, NotADirectoryError, OSError):
        return None
    try:
        info = os.fstat(entry_fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            return None
        files: list[str] = []
        leases: list[str] = []
        live_lease = False
        size = 0
        for child in os.listdir(entry_fd):
            child_info = os.stat(child, dir_fd=entry_fd, follow_symlinks=False)
            if (not stat.S_ISREG(child_info.st_mode) or child_info.st_uid != os.getuid()
                    or child_info.st_mode & 0o077):
                return None
            if _valid_lease_child(child):
                leases.append(child)
                live_lease = live_lease or _lease_is_live(child, child_info.st_mtime, now=now)
            elif not (re.fullmatch(r"media\.[a-z0-9]{1,12}", child)
                      or re.fullmatch(r"\.stage-[a-f0-9]{32}", child)):
                return None
            files.append(child)
            size += child_info.st_size
        return {
            "name": name,
            "size": size,
            "mtime": info.st_mtime,
            "active": live_lease or any(os.path.join(cache_path, name, child) in active_paths for child in files),
            "files": files,
            "leases": leases,
        }
    finally:
        os.close(entry_fd)


def _remove_cache_entry(cache_fd: int, name: str) -> bool:
    try:
        entry_fd = os.open(name, _DIRECTORY_FLAGS, dir_fd=cache_fd)
    except OSError:
        return False
    try:
        info = os.fstat(entry_fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            return False
        children = os.listdir(entry_fd)
        for child in children:
            child_info = os.stat(child, dir_fd=entry_fd, follow_symlinks=False)
            if (not stat.S_ISREG(child_info.st_mode) or child_info.st_uid != os.getuid()
                    or child_info.st_mode & 0o077):
                return False
            if not (_valid_lease_child(child)
                    or re.fullmatch(r"media\.[a-z0-9]{1,12}", child)
                    or re.fullmatch(r"\.stage-[a-f0-9]{32}", child)):
                return False
        for child in children:
            os.unlink(child, dir_fd=entry_fd)
    finally:
        os.close(entry_fd)
    try:
        os.rmdir(name, dir_fd=cache_fd)
        return True
    except OSError:
        return False


def prune_cache(cache_fd: int, cache_path: str, active_paths: list[str],
                required_bytes: int, *, replace_key: str = "", now: float | None = None) -> None:
    """Collect expired/least-recent unused snapshots without unlinking live media."""
    active_path_set = set(active_paths)
    current_time = time.time() if now is None else now

    def entries() -> list[CacheEntry]:
        found = []
        for name in os.listdir(cache_fd):
            item = _inspect_cache_entry(cache_fd, cache_path, name, active_path_set, now=current_time)
            if item is not None:
                found.append(item)
        return found

    items = entries()
    for item in list(items):
        if (item["name"] != replace_key and not item["active"]
                and current_time - float(item["mtime"]) > CACHE_RETENTION_SECONDS):
            _remove_cache_entry(cache_fd, str(item["name"]))
    items = entries()

    def over_limit(current: list[CacheEntry]) -> bool:
        count = len(current) + (0 if any(x["name"] == replace_key for x in current) else 1)
        total = sum(x["size"] for x in current) + required_bytes
        return count > CACHE_MAX_ENTRIES or total > CACHE_MAX_BYTES

    for item in sorted(items, key=lambda value: value["mtime"]):
        if not over_limit(items):
            break
        if item["name"] == replace_key or item["active"]:
            continue
        if _remove_cache_entry(cache_fd, str(item["name"])):
            items.remove(item)
    if over_limit(items):
        raise OSError(errno.ENOSPC, "pinned media cache is full; active snapshots were retained")

def release_snapshot_leases(cache_root: str | None, leases: list[dict[str, str]]) -> int:
    if not isinstance(leases, list):
        raise ValueError("snapshot leases must be a list")
    cache_path = _cache_root(cache_root)
    cache_fd = _open_directory(cache_path, private=True)
    pid, started = _lease_owner()
    released = 0
    try:
        fcntl.flock(cache_fd, fcntl.LOCK_EX)
        for item in leases:
            if not isinstance(item, dict) or set(item) != {"path", "lease"}:
                raise ValueError("each snapshot lease must contain path and lease")
            path = item["path"]
            token = item["lease"]
            if not isinstance(path, str) or not isinstance(token, str):
                raise ValueError("snapshot lease fields must be strings")
            normalized = os.path.abspath(path)
            prefix = cache_path.rstrip("/") + "/"
            if not normalized.startswith(prefix):
                raise ValueError("snapshot path is outside the configured cache")
            relative = normalized[len(prefix):]
            match = re.fullmatch(r"([a-f0-9]{64})/(media\.[a-z0-9]{1,12})", relative)
            if not match:
                raise ValueError("snapshot path has an invalid cache structure")
            lease_name = _lease_name(pid, started, token)
            try:
                entry_fd = os.open(match.group(1), _DIRECTORY_FLAGS, dir_fd=cache_fd)
            except FileNotFoundError:
                continue
            try:
                info = os.fstat(entry_fd)
                if info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise PermissionError(errno.EPERM, "pin staging directory is not private")
                try:
                    lease_info = os.stat(lease_name, dir_fd=entry_fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if (not stat.S_ISREG(lease_info.st_mode) or lease_info.st_uid != os.getuid()
                        or lease_info.st_mode & 0o077):
                    raise PermissionError(errno.EPERM, "snapshot lease is not private")
                os.unlink(lease_name, dir_fd=entry_fd)
                released += 1
            finally:
                os.close(entry_fd)
        return released
    finally:
        os.close(cache_fd)


def renew_snapshot_leases(cache_root: str | None, leases: list[dict[str, str]]) -> int:
    """Refresh exact owner leases so inactive QML instances eventually expire."""
    if not isinstance(leases, list):
        raise ValueError("snapshot leases must be a list")
    cache_path = _cache_root(cache_root)
    cache_fd = _open_directory(cache_path, private=True)
    pid, started = _lease_owner()
    renewed = 0
    try:
        fcntl.flock(cache_fd, fcntl.LOCK_EX)
        now = time.time()
        for item in leases:
            if not isinstance(item, dict) or set(item) != {"path", "lease"}:
                raise ValueError("each snapshot lease must contain path and lease")
            path = item["path"]
            token = item["lease"]
            if not isinstance(path, str) or not isinstance(token, str):
                raise ValueError("snapshot lease fields must be strings")
            if not os.path.isabs(path) or "\x00" in path:
                raise ValueError("snapshot path must be absolute")
            normalized = os.path.abspath(path)
            prefix = cache_path.rstrip("/") + "/"
            if not normalized.startswith(prefix):
                raise ValueError("snapshot path is outside the configured cache")
            relative = normalized[len(prefix):]
            match = re.fullmatch(r"([a-f0-9]{64})/(media\.[a-z0-9]{1,12})", relative)
            if not match:
                raise ValueError("snapshot path has an invalid cache structure")
            lease_name = _lease_name(pid, started, token)
            entry_fd = os.open(match.group(1), _DIRECTORY_FLAGS, dir_fd=cache_fd)
            try:
                info = os.fstat(entry_fd)
                if info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise PermissionError(errno.EPERM, "pin staging directory is not private")
                lease_info = os.stat(lease_name, dir_fd=entry_fd, follow_symlinks=False)
                if (not stat.S_ISREG(lease_info.st_mode) or lease_info.st_uid != os.getuid()
                        or lease_info.st_mode & 0o077):
                    raise PermissionError(errno.EPERM, "snapshot lease is not private")
                os.utime(lease_name, (now, now), dir_fd=entry_fd, follow_symlinks=False)
                renewed += 1
            finally:
                os.close(entry_fd)
        return renewed
    finally:
        os.close(cache_fd)


def stage_pinned_media(folder: str, pinned: str, cache_root: str | None = None,
                      active_paths: list[str] | None = None,
                      return_lease: bool = False) -> str | tuple[str, str]:
    relative = _relative_pin(folder, pinned)
    owner_pid, owner_started = _lease_owner()
    root_fd = _open_directory(folder)
    source_fd = -1
    cache_fd = -1
    pin_dir_fd = -1
    temporary_name = ""
    cache_key = ""
    published = False
    lease_created = False
    prior_snapshot = False
    lease_token = secrets.token_hex(16)
    lease_name = _lease_name(owner_pid, owner_started, lease_token)
    cache_path = ""
    try:
        source_fd = _open_pin(root_fd, relative)
        source_info = os.fstat(source_fd)
        if source_info.st_size > MAX_PINNED_BYTES:
            raise OSError(errno.EFBIG, "pinned media exceeds the 4 GiB staging limit")
        cache_path = _cache_root(cache_root)
        cache_fd = _open_directory(cache_path, create=True, private=True)
        fcntl.flock(cache_fd, fcntl.LOCK_EX)
        cache_key = hashlib.sha256((folder.rstrip("/") + "\0" + relative).encode("utf-8")).hexdigest()
        prune_cache(cache_fd, cache_path, active_paths or [], source_info.st_size, replace_key=cache_key)
        try:
            os.mkdir(cache_key, 0o700, dir_fd=cache_fd)
        except FileExistsError:
            pass
        pin_dir_fd = os.open(cache_key, _DIRECTORY_FLAGS, dir_fd=cache_fd)
        info = os.fstat(pin_dir_fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise PermissionError(errno.EPERM, "pin staging directory is not private")
        prior_snapshot = any(re.fullmatch(r"media\.[a-z0-9]{1,12}", child)
                             for child in os.listdir(pin_dir_fd))
        lease_fd = os.open(lease_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                           | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=pin_dir_fd)
        try:
            os.fsync(lease_fd)
        finally:
            os.close(lease_fd)
        lease_created = True

        name = os.path.basename(relative)
        suffix = os.path.splitext(name)[1]
        if not re.fullmatch(r"\.[A-Za-z0-9]{1,12}", suffix or ""):
            suffix = ".media"
        final_name = "media" + suffix.lower()
        temporary_name = ".stage-" + secrets.token_hex(16)
        output_fd = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=pin_dir_fd)
        try:
            copied = 0
            while True:
                chunk = os.read(source_fd, 1024 * 1024)
                if not chunk:
                    break
                copied += len(chunk)
                if copied > MAX_PINNED_BYTES:
                    raise OSError(errno.EFBIG, "pinned media exceeds the 4 GiB staging limit")
                view = memoryview(chunk)
                while view:
                    written = os.write(output_fd, view)
                    view = view[written:]
            after_info = os.fstat(source_fd)
            if (source_info.st_dev, source_info.st_ino, source_info.st_size,
                    source_info.st_mtime_ns, source_info.st_ctime_ns) != (
                    after_info.st_dev, after_info.st_ino, after_info.st_size,
                    after_info.st_mtime_ns, after_info.st_ctime_ns):
                raise OSError(errno.EBUSY, "pinned media changed while snapshotting")
            os.fsync(output_fd)
        finally:
            os.close(output_fd)
        os.rename(temporary_name, final_name, src_dir_fd=pin_dir_fd, dst_dir_fd=pin_dir_fd)
        temporary_name = ""
        published = True
        staged_path = os.path.join(cache_path, cache_key, final_name)
        return (staged_path, lease_token) if return_lease else staged_path
    finally:
        if temporary_name and pin_dir_fd >= 0:
            try:
                os.unlink(temporary_name, dir_fd=pin_dir_fd)
            except FileNotFoundError:
                pass
        if lease_created and not published and not prior_snapshot and pin_dir_fd >= 0:
            try:
                os.unlink(lease_name, dir_fd=pin_dir_fd)
            except FileNotFoundError:
                pass
        if not published and cache_key and cache_fd >= 0:
            try:
                os.rmdir(cache_key, dir_fd=cache_fd)
            except OSError:
                pass
        for fd in (pin_dir_fd, cache_fd, source_fd, root_fd):
            if fd >= 0:
                os.close(fd)


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] in ("--release", "--renew"):
        try:
            leases = json.loads(argv[2])
            if not isinstance(leases, list):
                raise ValueError("snapshot leases must be a JSON list")
            if argv[1] == "--release":
                release_snapshot_leases(None, leases)
            else:
                renew_snapshot_leases(None, leases)
            return 0
        except (OSError, ValueError) as exc:
            print(f"stage-pinned-media: {exc}", file=sys.stderr)
            return 1
    if len(argv) not in (3, 4):
        print("usage: stage-pinned-media.py FOLDER PINNED_PATH [ACTIVE_SNAPSHOTS_JSON]", file=sys.stderr)
        return 2
    try:
        active_paths = json.loads(argv[3]) if len(argv) == 4 else []
        if not isinstance(active_paths, list) or any(not isinstance(path, str) for path in active_paths):
            raise ValueError("active snapshots must be a JSON list of paths")
        staged_path, lease_token = stage_pinned_media(
            argv[1], argv[2], active_paths=active_paths, return_lease=True)
        print(json.dumps({"path": staged_path, "lease": lease_token}, separators=(",", ":")))
        return 0
    except (OSError, ValueError) as exc:
        print(f"stage-pinned-media: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

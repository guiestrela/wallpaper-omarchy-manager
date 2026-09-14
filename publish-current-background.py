#!/usr/bin/python3
"""Atomically publish the wallpaper link inside a trusted directory.

The shell process is long-lived, while the state directory is a mutable path.
Open every component with O_NOFOLLOW, retain the final directory descriptor,
and perform both the temporary symlink creation and rename relative to it. A
post-publish lstat/readlink check makes a changed destination fail closed.
"""

from __future__ import annotations

import errno
import os
import secrets
import stat
import sys


LINK_NAME = "background"
MAX_TEMP_ATTEMPTS = 16


def error(message: str) -> int:
    print(f"publish-current-background: {message}", file=sys.stderr)
    return 1


def check_directory(fd: int, uid: int, *, final: bool) -> None:
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode):
        raise OSError(errno.ENOTDIR, "component is not a directory")

    # Root-owned system components are fine, but an untrusted owner is not.
    # The destination itself must belong to the invoking user. Rejecting
    # group/other-writable components also closes the parent-directory race
    # for users who share a group or a writable parent.
    if final:
        if info.st_uid != uid:
            raise PermissionError(errno.EPERM, "destination directory is not user-owned")
    elif info.st_uid not in (0, uid) and not info.st_mode & stat.S_ISVTX:
        raise PermissionError(errno.EPERM, "path component is not root- or user-owned")
    # A sticky directory such as /tmp is safe for traversing: the sticky bit
    # prevents another user from replacing an entry they do not own. Other
    # group/other-writable components are not trusted.
    if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
        raise PermissionError(errno.EPERM, "directory is group- or other-writable")


def open_owned_directory(path: str) -> int:
    if not path.startswith("/"):
        raise ValueError("destination directory must be absolute")

    components = path.split("/")[1:]
    if not components or any(component in ("", ".", "..") for component in components):
        raise ValueError("destination directory contains an unsafe component")

    uid = os.getuid()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open("/", flags)
    try:
        for index, component in enumerate(components):
            next_fd = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            check_directory(fd, uid, final=index == len(components) - 1)
        return fd
    except Exception:
        os.close(fd)
        raise


def revalidate(fd: int, uid: int, target: str) -> None:
    # The descriptor remains pinned even if the path is replaced after the
    # open. Check its identity again before trusting the child entry.
    check_directory(fd, uid, final=True)
    info = os.stat(LINK_NAME, dir_fd=fd, follow_symlinks=False)
    if not stat.S_ISLNK(info.st_mode):
        raise RuntimeError("published entry is not a symlink")
    if info.st_uid != uid:
        raise PermissionError(errno.EPERM, "published symlink is not user-owned")
    if os.readlink(LINK_NAME, dir_fd=fd) != target:
        raise RuntimeError("published symlink target changed")


def publish(directory: str, target: str) -> None:
    if not target:
        raise ValueError("wallpaper target is empty")

    uid = os.getuid()
    directory_fd = open_owned_directory(directory)
    temporary_name: str | None = None
    try:
        for _ in range(MAX_TEMP_ATTEMPTS):
            candidate = f".{LINK_NAME}.tmp.{os.getpid()}.{secrets.token_hex(8)}"
            try:
                # symlinkat(2): target is stored as data and the destination
                # directory is selected by the already-validated descriptor.
                os.symlink(target, candidate, dir_fd=directory_fd)
                temporary_name = candidate
                break
            except FileExistsError:
                continue
        if temporary_name is None:
            raise FileExistsError(errno.EEXIST, "could not allocate a temporary link name")

        check_directory(directory_fd, uid, final=True)
        # renameat(2) is atomic and does not follow either final path entry.
        os.replace(temporary_name, LINK_NAME,
                   src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        temporary_name = None

        # Make the publication durable where the filesystem supports syncing
        # directory descriptors, then verify what is actually in the directory.
        try:
            os.fsync(directory_fd)
        except OSError as exc:
            if exc.errno not in (errno.EINVAL, errno.EROFS):
                raise
        revalidate(directory_fd, uid, target)
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
        os.close(directory_fd)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        return error(f"usage: {argv[0]} DIRECTORY TARGET")
    try:
        publish(argv[1], argv[2])
    except (OSError, ValueError, RuntimeError) as exc:
        return error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

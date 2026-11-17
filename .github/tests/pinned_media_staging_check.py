#!/usr/bin/env python3
"""Race regressions for the pinned-media staging boundary; fixtures only."""
from __future__ import annotations

import importlib.util
import errno
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / "stage-pinned-media.py"
SPEC = importlib.util.spec_from_file_location("stage_pinned_media", HELPER)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load helper at {HELPER}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PinnedMediaStagingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="wpm-stage-test-")
        self.base = Path(self.temp.name)
        self.root = self.base / "wallpapers"
        self.root.mkdir()
        self.cache = self.base / "cache"
        self.cache.mkdir(mode=0o700)
        self.external = self.base / "external.jpg"
        self.external.write_bytes(b"outside-image")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_regular_pin_is_copied_to_private_snapshot(self) -> None:
        pinned = self.root / "a.jpg"
        pinned.write_bytes(b"synthetic-image-data")
        staged = Path(MODULE.stage_pinned_media(str(self.root), str(pinned), str(self.cache)))
        self.assertEqual(staged.read_bytes(), b"synthetic-image-data")
        self.assertTrue(os.path.commonpath((str(self.cache), str(staged))) == str(self.cache))
        self.assertEqual(stat.S_IMODE(staged.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(staged.stat().st_mode), 0o600)

    def test_changed_source_preserves_live_snapshot_generation(self) -> None:
        for report_active_path in (True, False):
            with self.subTest(report_active_path=report_active_path):
                pinned = self.root / f"generation-{report_active_path}.jpg"
                pinned.write_bytes(b"version-one")
                source_time = pinned.stat().st_mtime_ns
                first, first_token = MODULE.stage_pinned_media(
                    str(self.root), str(pinned), str(self.cache), return_lease=True)
                first_path = Path(first)
                first_inode = first_path.stat().st_ino
                active_paths = [first] if report_active_path else []
                pinned.write_bytes(b"version-two")
                # Equal size and restored mtime must not hide a source change.
                os.utime(pinned, ns=(source_time, source_time))
                second, second_token = MODULE.stage_pinned_media(
                    str(self.root), str(pinned), str(self.cache),
                    active_paths=active_paths, return_lease=True)
                self.assertNotEqual(first, second, "changed source needs a new generation path")
                self.assertEqual(first_path.read_bytes(), b"version-one")
                self.assertEqual(first_path.stat().st_ino, first_inode)
                self.assertEqual(Path(second).read_bytes(), b"version-two")
                self.assertRegex(Path(second).parent.name, r"^[a-f0-9]{64}$")
                second_inode = Path(second).stat().st_ino
                duplicate, duplicate_token = MODULE.stage_pinned_media(
                    str(self.root), str(pinned), str(self.cache), return_lease=True)
                self.assertEqual(duplicate, second, "unchanged source reuses its generation")
                self.assertEqual(Path(second).stat().st_ino, second_inode,
                                 "duplicate staging must not replace published media")
                leases = [{"path": first, "lease": first_token},
                          {"path": second, "lease": second_token},
                          {"path": duplicate, "lease": duplicate_token}]
                self.assertEqual(MODULE.renew_snapshot_leases(str(self.cache), leases), 3)
                self.assertEqual(MODULE.release_snapshot_leases(str(self.cache), leases), 3)

    def test_failed_restaging_removes_only_unreturned_lease(self) -> None:
        pinned = self.root / "restage.jpg"
        pinned.write_bytes(b"existing-snapshot")
        first, first_token = MODULE.stage_pinned_media(
            str(self.root), str(pinned), str(self.cache), return_lease=True)
        second, second_token = MODULE.stage_pinned_media(
            str(self.root), str(pinned), str(self.cache), return_lease=True)
        self.assertEqual(first, second)
        snapshot = Path(first)
        inode = snapshot.stat().st_ino
        original_children = {child.name for child in snapshot.parent.iterdir()}
        self.assertEqual(len(list(snapshot.parent.glob(".lease-*"))), 2)
        original_read = os.read
        injected = False

        def fail_copy(fd, count):
            nonlocal injected
            if not injected:
                injected = True
                return original_read(fd, count)
            raise OSError(errno.EIO, "injected restaging read failure")

        with patch.object(MODULE.os, "read", side_effect=fail_copy):
            with self.assertRaises(OSError) as caught:
                MODULE.stage_pinned_media(
                    str(self.root), str(pinned), str(self.cache), return_lease=True)
        self.assertTrue(injected)
        self.assertEqual(caught.exception.errno, errno.EIO)
        self.assertEqual({child.name for child in snapshot.parent.iterdir()}, original_children,
                         "failed restaging must remove its unreturned lease and temporary copy only")
        self.assertEqual(snapshot.read_bytes(), b"existing-snapshot")
        self.assertEqual(snapshot.stat().st_ino, inode)
        leases = [{"path": first, "lease": first_token}, {"path": second, "lease": second_token}]
        self.assertEqual(MODULE.renew_snapshot_leases(str(self.cache), leases), 2)
        self.assertEqual(MODULE.release_snapshot_leases(str(self.cache), leases[:1]), 1)
        self.assertEqual(MODULE.renew_snapshot_leases(str(self.cache), leases[1:]), 1)
        self.assertEqual(MODULE.release_snapshot_leases(str(self.cache), leases[1:]), 1)
        self.assertEqual(list(snapshot.parent.glob(".lease-*")), [])

    def test_cli_returns_real_snapshot_path_from_separate_arguments(self) -> None:
        pinned = self.root / "cli.jpg"
        pinned.write_bytes(b"cli-fixture")
        cache_base = self.base / "xdg-cache"
        cache_root = cache_base / "omarchy/wallpaperomarchymanager/pinned"
        env = os.environ.copy()
        env["HOME"] = str(self.base / "home")
        env["XDG_CACHE_HOME"] = str(cache_base)
        (self.base / "home").mkdir(mode=0o700)
        cache_root.mkdir(parents=True, mode=0o700)
        active = cache_root / ("e" * 64)
        active.mkdir(mode=0o700)
        active_snapshot = active / "media.jpg"
        active_snapshot.write_bytes(b"renderer-is-using-this")
        active_snapshot.chmod(0o600)
        os.utime(active, (1, 1))
        result = subprocess.run(
            [sys.executable, str(HELPER), str(self.root), str(pinned), json.dumps([str(active_snapshot)])],
            capture_output=True, text=True, timeout=5, env=env, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(active_snapshot.exists(), "CLI cleanup preserves snapshots leased by QML renderers")
        handoff = json.loads(result.stdout)
        staged = Path(handoff["path"])
        self.assertRegex(handoff["lease"], r"^[a-f0-9]{32}$")
        self.assertEqual(staged.read_bytes(), b"cli-fixture")
        self.assertTrue(staged.is_relative_to(cache_base))
        released = subprocess.run(
            [sys.executable, str(HELPER), "--release",
             json.dumps([{"path": str(staged), "lease": handoff["lease"]}])],
            capture_output=True, text=True, timeout=5, env=env, check=False,
        )
        self.assertEqual(released.returncode, 0, released.stderr)

    def test_oversized_source_is_rejected_before_staging(self) -> None:
        pinned = self.root / "huge.mp4"
        with pinned.open("wb") as stream:
            stream.truncate(4 * 1024 * 1024 * 1024 + 1)
        with self.assertRaises(OSError) as caught:
            MODULE.stage_pinned_media(str(self.root), str(pinned), str(self.cache))
        self.assertEqual(caught.exception.errno, errno.EFBIG, "oversized file fails with EFBIG")
        self.assertEqual(list(self.cache.iterdir()), [], "oversized source creates no staging artifact")

    def test_symlink_pin_is_rejected(self) -> None:
        pinned = self.root / "linked.jpg"
        pinned.symlink_to(self.external)
        with self.assertRaises(OSError):
            MODULE.stage_pinned_media(str(self.root), str(pinned), str(self.cache))

    def test_source_swap_after_descriptor_open_fails_closed(self) -> None:
        pinned = self.root / "after-open.jpg"
        pinned.write_bytes(b"opened-original")
        original_read = os.read
        swapped = False

        def swap_then_read(fd, count):
            nonlocal swapped
            if not swapped:
                swapped = True
                pinned.unlink()
                pinned.symlink_to(self.external)
            return original_read(fd, count)

        with patch.object(MODULE.os, "read", side_effect=swap_then_read):
            with self.assertRaises(OSError):
                MODULE.stage_pinned_media(str(self.root), str(pinned), str(self.cache))
        self.assertTrue(swapped)
        self.assertEqual(list(self.cache.iterdir()), [], "changed source leaves no staged artifact")

    def test_symlinked_parent_component_is_rejected(self) -> None:
        outside_dir = self.base / "outside"
        outside_dir.mkdir()
        (outside_dir / "a.jpg").write_bytes(b"outside")
        (self.root / "nested").symlink_to(outside_dir, target_is_directory=True)
        with self.assertRaises(OSError):
            MODULE.stage_pinned_media(str(self.root), str(self.root / "nested" / "a.jpg"), str(self.cache))

    def test_outside_and_traversal_paths_are_rejected(self) -> None:
        for path in (str(self.external), str(self.root / ".." / "external.jpg"), str(self.root) + "2/a.jpg"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                MODULE.stage_pinned_media(str(self.root), path, str(self.cache))

    def test_symlink_swap_at_leaf_open_fails_closed(self) -> None:
        pinned = self.root / "race.jpg"
        pinned.write_bytes(b"original")
        original_open = os.open
        swapped = False

        def swap_then_open(path, flags, mode=0o777, *, dir_fd=None):
            nonlocal swapped
            if path == "race.jpg" and dir_fd is not None and not swapped:
                swapped = True
                pinned.unlink()
                pinned.symlink_to(self.external)
            return original_open(path, flags, mode, dir_fd=dir_fd)

        with patch.object(MODULE.os, "open", side_effect=swap_then_open):
            with self.assertRaises(OSError):
                MODULE.stage_pinned_media(str(self.root), str(pinned), str(self.cache))
        self.assertTrue(swapped, "test must swap the pin immediately before the real leaf open")
        self.assertEqual(list(self.cache.iterdir()), [], "failed handoff leaves no staged artifact")

    def _snapshot(self, name: str, data: bytes, mtime: int) -> Path:
        directory = self.cache / name
        directory.mkdir(mode=0o700)
        snapshot = directory / "media.jpg"
        snapshot.write_bytes(data)
        snapshot.chmod(0o600)
        os.utime(directory, (mtime, mtime))
        return snapshot

    def test_cache_cleanup_removes_expired_unreferenced_snapshot_only(self) -> None:
        active = self._snapshot("a" * 64, b"active", 100)
        expired = self._snapshot("b" * 64, b"expired", 100)
        with patch.object(MODULE, "CACHE_RETENTION_SECONDS", 10):
            cache_fd = os.open(self.cache, os.O_RDONLY | os.O_DIRECTORY)
            try:
                MODULE.prune_cache(cache_fd, str(self.cache), [str(active)], 0, now=200)
            finally:
                os.close(cache_fd)
        self.assertTrue(active.exists(), "a snapshot referenced by a renderer must be retained")
        self.assertFalse(expired.parent.exists(), "expired unreferenced snapshots are collected")

    def test_staging_runs_retention_cleanup_before_publishing(self) -> None:
        expired = self._snapshot("f" * 64, b"expired", 100)
        pinned = self.root / "new.jpg"
        pinned.write_bytes(b"new-snapshot")
        with patch.object(MODULE, "CACHE_RETENTION_SECONDS", 10):
            staged = MODULE.stage_pinned_media(str(self.root), str(pinned), str(self.cache))
        self.assertEqual(Path(staged).read_bytes(), b"new-snapshot")
        self.assertFalse(expired.parent.exists(), "the real staging path prunes expired cache entries")

    def test_owner_lease_protects_snapshot_from_stale_active_path_snapshot(self) -> None:
        pinned = self.root / "leased.jpg"
        pinned.write_bytes(b"leased-snapshot")
        snapshot = Path(MODULE.stage_pinned_media(str(self.root), str(pinned), str(self.cache)))
        cache_fd = os.open(self.cache, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with patch.object(MODULE, "CACHE_RETENTION_SECONDS", 0):
                MODULE.prune_cache(cache_fd, str(self.cache), [], 0, now=time.time() + 1)
        finally:
            os.close(cache_fd)
        self.assertTrue(snapshot.exists(),
                        "filesystem lease must protect a renderer mapping even when active_paths is stale")

    def test_releasing_owner_lease_allows_expired_snapshot_collection(self) -> None:
        pinned = self.root / "released.jpg"
        pinned.write_bytes(b"released-snapshot")
        staged, token = MODULE.stage_pinned_media(
            str(self.root), str(pinned), str(self.cache), return_lease=True)
        snapshot = Path(staged)
        released = MODULE.release_snapshot_leases(
            str(self.cache), [{"path": staged, "lease": token}])
        self.assertEqual(released, 1)
        cache_fd = os.open(self.cache, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with patch.object(MODULE, "CACHE_RETENTION_SECONDS", 0):
                MODULE.prune_cache(cache_fd, str(self.cache), [], 0, now=10**12)
        finally:
            os.close(cache_fd)
        self.assertFalse(snapshot.exists(), "released and expired snapshot can be collected")

    def test_cache_limit_fails_closed_without_evicting_active_snapshot(self) -> None:
        active = self._snapshot("c" * 64, b"active", 100)
        with patch.object(MODULE, "CACHE_MAX_ENTRIES", 1), patch.object(MODULE, "CACHE_MAX_BYTES", 1024):
            cache_fd = os.open(self.cache, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaises(OSError) as caught:
                    MODULE.prune_cache(cache_fd, str(self.cache), [str(active)], 1, now=200)
            finally:
                os.close(cache_fd)
        self.assertEqual(caught.exception.errno, errno.ENOSPC)
        self.assertTrue(active.exists(), "capacity pressure never deletes an in-use snapshot")

    def test_cache_byte_limit_fails_closed_without_evicting_active_snapshot(self) -> None:
        active = self._snapshot("d" * 64, b"active", 100)
        with patch.object(MODULE, "CACHE_MAX_ENTRIES", 32), patch.object(MODULE, "CACHE_MAX_BYTES", 6):
            cache_fd = os.open(self.cache, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaises(OSError) as caught:
                    MODULE.prune_cache(cache_fd, str(self.cache), [str(active)], 1, now=200)
            finally:
                os.close(cache_fd)
        self.assertEqual(caught.exception.errno, errno.ENOSPC)
        self.assertTrue(active.exists(), "the byte cap does not evict a leased snapshot")

    def test_expired_owner_lease_does_not_protect_snapshot_after_component_unloads(self) -> None:
        pinned = self.root / "orphaned.jpg"
        pinned.write_bytes(b"orphaned-snapshot")
        staged, _token = MODULE.stage_pinned_media(
            str(self.root), str(pinned), str(self.cache), return_lease=True)
        snapshot = Path(staged)
        lease_marker = next(snapshot.parent.glob(".lease-*"))
        expired_at = time.time() - MODULE.LEASE_TTL_SECONDS - 1
        os.utime(lease_marker, (expired_at, expired_at))
        os.utime(snapshot.parent, (expired_at, expired_at))
        cache_fd = os.open(self.cache, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with patch.object(MODULE, "CACHE_RETENTION_SECONDS", 0):
                MODULE.prune_cache(cache_fd, str(self.cache), [], 0, now=time.time() + 1)
        finally:
            os.close(cache_fd)
        self.assertFalse(snapshot.exists(),
                         "an expired component lease must not stay live merely because Quickshell PID survives")

    def test_cli_renews_component_lease(self) -> None:
        pinned = self.root / "renewed.jpg"
        pinned.write_bytes(b"renewed-snapshot")
        cache_base = self.base / "xdg-cache"
        cache_root = cache_base / "omarchy/wallpaperomarchymanager/pinned"
        home = self.base / "home"
        home.mkdir(mode=0o700)
        cache_root.mkdir(parents=True, mode=0o700)
        env = os.environ.copy()
        env["HOME"] = str(home)
        env["XDG_CACHE_HOME"] = str(cache_base)
        staged_result = subprocess.run(
            [sys.executable, str(HELPER), str(self.root), str(pinned)],
            capture_output=True, text=True, timeout=5, env=env, check=False,
        )
        self.assertEqual(staged_result.returncode, 0, staged_result.stderr)
        handoff = json.loads(staged_result.stdout)
        staged = handoff["path"]
        token = handoff["lease"]
        snapshot = Path(staged)
        lease_marker = next(snapshot.parent.glob(".lease-*"))
        old_time = time.time() - MODULE.LEASE_TTL_SECONDS - 1
        os.utime(lease_marker, (old_time, old_time))
        os.utime(snapshot.parent, (old_time, old_time))
        result = subprocess.run(
            [sys.executable, str(HELPER), "--renew", json.dumps([{"path": staged, "lease": token}])],
            capture_output=True, text=True, timeout=5, env=env, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreater(lease_marker.stat().st_mtime, old_time + 1)
        cache_fd = os.open(cache_root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with patch.object(MODULE, "CACHE_RETENTION_SECONDS", 0):
                MODULE.prune_cache(cache_fd, str(cache_root), [], 0, now=time.time() + 1)
        finally:
            os.close(cache_fd)
        self.assertTrue(snapshot.exists(), "renewed lease survives stale-path cleanup with a live parent process")

    def test_qml_handoff_rejects_snapshot_outside_configured_cache(self) -> None:
        qml = (REPO / "Background.qml").read_text()
        self.assertIn("stagingCacheRoot", qml)
        self.assertIn("isStagedSnapshotPath", qml)


if __name__ == "__main__":
    unittest.main(verbosity=2)
